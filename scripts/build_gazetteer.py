#!/usr/bin/env python3
"""Build the embedded toponym gazetteer from GeoNames `cities15000`.

Produces `src/gazetteer/cities15000.tsv`, the asset `src/gazetteer/mod.rs`
embeds with `include_str!`. Run this only when refreshing the GeoNames
snapshot; the generated file is committed so builds stay offline and
reproducible.

    curl -LO https://download.geonames.org/export/dump/cities15000.zip
    unzip cities15000.zip
    python scripts/build_gazetteer.py cities15000.txt src/gazetteer/cities15000.tsv

Source: GeoNames (https://www.geonames.org), licensed CC BY 4.0. The
attribution required by that licence lives in `src/gazetteer/NOTICE`.

Output columns (tab-separated, no header):

    name  asciiname  lat  lon  country_code  population

`asciiname` is written only when it differs from `name` (an empty field
otherwise), because ~85% of rows repeat the name verbatim and both forms are
indexed as lookup keys either way.

Only populated places are kept: rows whose population is 0 carry no signal for
the population-weighted disambiguation the resolver does, and a zero-population
entry can never win an argmax against a real city of the same name.

`alternatenames` is deliberately dropped. It is the bulk of the source file
(hundreds of transliterations per row) and v1 resolution is exact-match only,
so transliterations would inflate the asset without changing a single result.
"""

import sys

# GeoNames `cities15000` column indices, per
# https://download.geonames.org/export/dump/readme.txt
COL_NAME = 1
COL_ASCIINAME = 2
COL_LATITUDE = 4
COL_LONGITUDE = 5
COL_COUNTRY_CODE = 8
COL_POPULATION = 14
COL_COUNT = 19


def build(src_path: str, dst_path: str) -> None:
    rows = []
    skipped_unpopulated = 0
    skipped_malformed = 0

    with open(src_path, encoding="utf-8") as src:
        for line in src:
            line = line.rstrip("\n")
            if not line:
                continue
            fields = line.split("\t")
            if len(fields) < COL_COUNT:
                skipped_malformed += 1
                continue

            name = fields[COL_NAME].strip()
            asciiname = fields[COL_ASCIINAME].strip()
            country = fields[COL_COUNTRY_CODE].strip()

            try:
                lat = float(fields[COL_LATITUDE])
                lon = float(fields[COL_LONGITUDE])
                population = int(fields[COL_POPULATION] or 0)
            except ValueError:
                skipped_malformed += 1
                continue

            if not name or not country:
                skipped_malformed += 1
                continue
            if population <= 0:
                skipped_unpopulated += 1
                continue

            # A tab or newline inside a name would corrupt the row framing.
            if "\t" in name or "\t" in asciiname:
                skipped_malformed += 1
                continue

            rows.append(
                (
                    name,
                    "" if asciiname == name else asciiname,
                    f"{lat:.5f}",
                    f"{lon:.5f}",
                    country,
                    population,
                )
            )

    # Sort for a stable, diffable asset: population descending so the row that
    # wins a homonym argmax is the one a reader sees first, then by name and
    # country to break ties deterministically.
    rows.sort(key=lambda r: (-r[5], r[0], r[4]))

    with open(dst_path, "w", encoding="utf-8", newline="\n") as dst:
        for name, asciiname, lat, lon, country, population in rows:
            dst.write(f"{name}\t{asciiname}\t{lat}\t{lon}\t{country}\t{population}\n")

    print(f"wrote {len(rows)} places to {dst_path}")
    print(f"  skipped {skipped_unpopulated} with zero population")
    print(f"  skipped {skipped_malformed} malformed")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    build(sys.argv[1], sys.argv[2])
