#!/usr/bin/env python3
"""Ingest a GDELT GKG 2.1 CSV/TSV export into shodh-memory via POST /api/remember.

Reads a GKG export (tab-delimited, as GDELT ships it, or comma-delimited, as
BigQuery CSV exports ship it), builds one memory per row using the
V2Locations column for geo-tagging (v2locations.parse_v2locations /
primary_location, which natively handle both the legacy V1Locations shape
and the true GKG 2.1 V2Locations shape), and posts it to a running
shodh-memory server.

Silent-data-loss rule: a row is only ever *skipped entirely* if it is
genuinely empty. Any other defect (unparseable date, unparseable/missing
coordinates, truncated column count) causes that one field to be dropped
from the payload -- the record itself is always ingested. Every such drop
is counted and surfaced in the JSON summary (rows_missing_location vs.
rows_location_parse_failed vs. date_parse_failed) rather than silently
disappearing.

On the server response: "posted" means the server accepted the POST
request (HTTP 2xx). It does NOT mean a new memory was created -- the
server's content-hash dedup (memory/mod.rs `remember()`) silently returns
the existing memory's id as a success response when identical content was
already stored, and the response body gives this script no way to tell
"created" apart from "already existed". There is no duplicate/409 path to
count separately: `AppError::MemoryAlreadyExists` exists in errors.rs but
is never constructed by the remember handler, so the server never returns
409 for a dedup hit in practice.

stdlib-only (urllib), no third-party HTTP dependency.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Dict, Iterator, List, NamedTuple, Optional, Sequence, Tuple

from v2locations import GdeltLocation, _SPECIFICITY, parse_v2locations, primary_location

# =============================================================================
# GKG 2.1 column layout
# =============================================================================
# Canonical column order for the headerless daily GKG export (data.gdeltproject.org)
# and the header names used by the BigQuery `gdelt-bq.gdeltv2.gkg` CSV export
# (case-insensitive, matched against a candidate header row).
_CANONICAL_COLUMNS = [
    "gkgrecordid", "date", "sourcecollectionidentifier", "sourcecommonname",
    "documentidentifier", "v1counts", "v2counts", "v1themes", "v2themes",
    "v1locations", "v2locations", "v1persons", "v2persons", "v1organizations",
    "v2organizations", "v15tone", "dates", "gcam", "sharingimage",
    "relatedimages", "socialimageembeds", "socialvideoembeds", "quotations",
    "allnames", "amounts", "translationinfo", "extras",
]
_DEFAULT_COLUMNS: Dict[str, int] = {name: i for i, name in enumerate(_CANONICAL_COLUMNS)}


def detect_columns(header_row: Optional[Sequence[str]]) -> Dict[str, int]:
    """Resolve column-name -> index. If `header_row` names recognizable GKG
    columns, use those positions (BigQuery CSV export order/width can differ
    from the canonical layout); otherwise fall back to the fixed GKG 2.1
    layout. Missing names always fall back to their canonical position so a
    partial or unrecognized header never leaves a column unresolved."""
    columns = dict(_DEFAULT_COLUMNS)
    if not header_row:
        return columns
    found = False
    for i, cell in enumerate(header_row):
        key = (cell or "").strip().lower()
        if key in _DEFAULT_COLUMNS:
            columns[key] = i
            found = True
    return columns if found else dict(_DEFAULT_COLUMNS)


def looks_like_header(row: Sequence[str]) -> bool:
    """A GKG data row's first cell is a GKGRECORDID like '20150326000000-0';
    a header row's first cell is the literal column name."""
    if not row:
        return False
    return row[0].strip().lower() in ("gkgrecordid",)


def _is_header_row(row: Sequence[str]) -> bool:
    """True if `row` looks like a header rather than data: either its first
    cell is literally 'GKGRECORDID', or any cell matches a recognized GKG
    column name (covers a header that starts with something other than
    GKGRECORDID, however unlikely). Any row this returns True for MUST be
    resolved through detect_columns(), never assumed to already be in
    canonical order -- a narrowed/reordered BigQuery export has a header by
    definition, and canonical-order fallback would silently mis-index it."""
    if not row:
        return False
    if looks_like_header(row):
        return True
    return any((cell or "").strip().lower() in _DEFAULT_COLUMNS for cell in row)


def _col(row: Sequence[str], columns: Dict[str, int], name: str) -> str:
    idx = columns.get(name, _DEFAULT_COLUMNS[name])
    return row[idx].strip() if idx < len(row) and row[idx] is not None else ""


def _best_location_name(locs: List[GdeltLocation]) -> Optional[str]:
    if not locs:
        return None
    best = min(locs, key=lambda l: (_SPECIFICITY.get(l.loc_type, 3), locs.index(l)))
    return best.name or None


# =============================================================================
# Date parsing
# =============================================================================
def parse_gkg_date(raw: str) -> Optional[str]:
    """GKG DATE is YYYYMMDDHHMMSS (2.1) or YYYYMMDD (1.0). Returns ISO8601 UTC,
    or None if unparseable -- never raises."""
    raw = (raw or "").strip()
    try:
        if len(raw) == 14 and raw.isdigit():
            dt = datetime(
                int(raw[0:4]), int(raw[4:6]), int(raw[6:8]),
                int(raw[8:10]), int(raw[10:12]), int(raw[12:14]),
                tzinfo=timezone.utc,
            )
        elif len(raw) == 8 and raw.isdigit():
            dt = datetime(int(raw[0:4]), int(raw[4:6]), int(raw[6:8]), tzinfo=timezone.utc)
        else:
            return None
    except ValueError:
        return None
    return dt.isoformat().replace("+00:00", "Z")


# =============================================================================
# Content synthesis
# =============================================================================
def _extract_names(field: str, limit: int = 6) -> List[str]:
    """AllNames/V2Persons/V2Organizations share the 'name,offset;name,offset'
    shape. Extract unique names in file order, deterministically."""
    names: List[str] = []
    seen = set()
    for chunk in (field or "").split(";"):
        name = chunk.split(",")[0].strip()
        if name and name not in seen:
            seen.add(name)
            names.append(name)
        if len(names) >= limit:
            break
    return names


def build_content(row: Sequence[str], columns: Dict[str, int], locs: List[GdeltLocation]) -> str:
    """Build embeddable memory text from the GKG row. Falls back down a
    chain of increasingly generic descriptions so content is never empty --
    and, more precisely, never shorter than the server's real minimum: the
    API requires content to be non-empty AND at least
    MIN_MEANINGFUL_CONTENT_LENGTH (10) trimmed characters
    (src/validation.rs:112-132), not merely non-empty. Every fallback string
    below clears that bound with room to spare."""
    loc_name = _best_location_name(locs)
    gkg_id = _col(row, columns, "gkgrecordid")

    parts: List[str] = []
    if loc_name:
        parts.append(f"GDELT GKG event near {loc_name}")
    elif gkg_id:
        parts.append(f"GDELT GKG record {gkg_id}")
    else:
        parts.append("GDELT GKG event")

    names = _extract_names(_col(row, columns, "allnames"))
    if names:
        parts.append("involving " + ", ".join(names))

    source = _col(row, columns, "sourcecommonname")
    if source:
        parts.append(f"(source: {source})")

    doc_id = _col(row, columns, "documentidentifier")
    if doc_id:
        parts.append(doc_id)

    return " ".join(p for p in parts if p).strip() or "GDELT GKG record (no data)"


# =============================================================================
# Row -> payload transform
# =============================================================================
class RowStats(NamedTuple):
    """Per-row field-loss accounting, distinguishing 'no data was there' from
    'data was there but couldn't be used' -- the latter is the real
    silent-data-loss case."""
    missing_location: bool        # V2Locations column was blank for this row
    location_parse_failed: bool   # V2Locations had content but none of it parsed
    date_parse_failed: bool       # DATE had content but it didn't parse


def build_payload(
    row: Sequence[str], user_id: str, columns: Optional[Dict[str, int]] = None
) -> Tuple[Optional[dict], RowStats]:
    """Transform one GKG row into a /api/remember payload. Returns
    (None, RowStats(False, False, False)) only for a genuinely empty row --
    every other defect degrades gracefully (drop the one bad field, keep
    the record) and is reflected in the returned RowStats."""
    columns = columns or _DEFAULT_COLUMNS
    if not row or all(not (c or "").strip() for c in row):
        return None, RowStats(False, False, False)

    locations_raw = _col(row, columns, "v2locations")
    locs, loc_stats = parse_v2locations(locations_raw)
    missing_location = not locations_raw
    location_parse_failed = bool(locations_raw) and loc_stats.parsed == 0

    content = build_content(row, columns, locs)
    payload: dict = {
        "user_id": user_id,
        "content": content,
        "tags": ["gdelt", "gkg"],
    }

    source = _col(row, columns, "sourcecommonname")
    if source:
        payload["tags"].append(source.lower())

    # parse_v2locations already rejects non-finite/out-of-range coordinates
    # (see v2locations.py), so any coords here are already valid WGS84.
    coords = primary_location(locations_raw)
    if coords is not None:
        lat, lon = coords
        payload["geo_location"] = [lat, lon, 0.0]

    raw_date = _col(row, columns, "date")
    iso_date = parse_gkg_date(raw_date)
    date_parse_failed = bool(raw_date) and iso_date is None
    if iso_date:
        payload["created_at"] = iso_date

    return payload, RowStats(missing_location, location_parse_failed, date_parse_failed)


# =============================================================================
# File reading (deterministic order)
# =============================================================================
def _detect_delimiter(sample_line: str) -> str:
    return "\t" if "\t" in sample_line else ","


def iter_gkg_rows(path: str) -> Tuple[Dict[str, int], Iterator[List[str]]]:
    """Read a GKG CSV/TSV export. Returns (columns, rows) where `rows` yields
    data rows in file order (a leading header row, if present, is consumed
    to build `columns` and is not yielded as data).

    Note: this reads the whole file into memory (`list(reader)`) to detect
    the delimiter/header before yielding rows. Fine for the sizes this
    script has been used with; a real daily GKG export (which can run to
    hundreds of thousands of rows) would want a streaming rewrite instead.

    Raises whatever `open()` raises (FileNotFoundError, PermissionError,
    etc.) -- callers (see `run()`) are responsible for turning that into a
    reported error rather than an unhandled traceback.
    """
    with open(path, "r", encoding="utf-8", newline="") as fh:
        first_line = fh.readline()
        if not first_line:
            return dict(_DEFAULT_COLUMNS), iter(())
        delimiter = _detect_delimiter(first_line)
        fh.seek(0)
        reader = csv.reader(fh, delimiter=delimiter)
        rows = list(reader)

    if not rows:
        return dict(_DEFAULT_COLUMNS), iter(())

    if _is_header_row(rows[0]):
        # Any detected header MUST be resolved by name -- never assume
        # canonical order just because a header is present. A narrowed or
        # reordered BigQuery export has exactly this shape.
        columns = detect_columns(rows[0])
        data_rows = rows[1:]
    else:
        columns = dict(_DEFAULT_COLUMNS)
        data_rows = rows

    return columns, iter(data_rows)


# =============================================================================
# HTTP (stdlib urllib only)
# =============================================================================
def post_remember(server: str, payload: dict, api_key: Optional[str] = None, timeout: float = 10.0) -> dict:
    """POST payload to {server}/api/remember. Raises urllib.error.HTTPError
    on non-2xx. The parsed response body is currently unused by callers
    (see module docstring re: "posted" not implying "created") -- json.loads
    is guarded so a non-JSON or malformed response body can't crash an
    otherwise-successful ingest run."""
    url = server.rstrip("/") + "/api/remember"
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, method="POST", headers={"Content-Type": "application/json"}
    )
    if api_key:
        request.add_header("Authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8")
    if not body:
        return {}
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {}


# =============================================================================
# CLI
# =============================================================================
def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True, help="shodh-memory server base URL, e.g. http://localhost:9944")
    parser.add_argument("--user-id", required=True, help="user_id to attribute ingested memories to")
    parser.add_argument("--input", required=True, help="path to a GKG CSV/TSV export")
    parser.add_argument("--limit", type=int, default=None, help="max rows to ingest (default: all)")
    parser.add_argument("--dry-run", action="store_true", help="parse and print the summary but do not POST")
    parser.add_argument(
        "--api-key", default=os.environ.get("SHODH_API_KEY"),
        help="bearer token for SHODH_API_KEYS-protected servers (default: $SHODH_API_KEY)",
    )
    return parser


def run(argv: Optional[Sequence[str]] = None) -> dict:
    args = _build_arg_parser().parse_args(argv)

    try:
        columns, rows = iter_gkg_rows(args.input)
    except OSError as e:
        return {"error": f"could not read --input {args.input}: {e}"}

    parsed = 0
    skipped = 0
    posted = 0
    errors = 0
    rows_missing_location = 0
    rows_location_parse_failed = 0
    date_parse_failed = 0
    error_samples: List[dict] = []

    for i, row in enumerate(rows):
        if args.limit is not None and parsed >= args.limit:
            break
        payload, stats = build_payload(row, args.user_id, columns)
        if payload is None:
            skipped += 1
            continue
        parsed += 1
        if stats.missing_location:
            rows_missing_location += 1
        if stats.location_parse_failed:
            rows_location_parse_failed += 1
        if stats.date_parse_failed:
            date_parse_failed += 1

        if args.dry_run:
            continue

        try:
            post_remember(args.server, payload, api_key=args.api_key)
            posted += 1
        except urllib.error.HTTPError as e:
            errors += 1
            if len(error_samples) < 5:
                error_samples.append({"row": i, "status": e.code, "reason": str(e.reason)})
        except urllib.error.URLError as e:
            errors += 1
            if len(error_samples) < 5:
                error_samples.append({"row": i, "status": None, "reason": str(e.reason)})

    summary = {
        "parsed": parsed,
        "skipped": skipped,
        "posted": posted,
        "errors": errors,
        "rows_missing_location": rows_missing_location,
        "rows_location_parse_failed": rows_location_parse_failed,
        "date_parse_failed": date_parse_failed,
        "dry_run": args.dry_run,
    }
    if error_samples:
        summary["error_samples"] = error_samples
    return summary


def main(argv: Optional[Sequence[str]] = None) -> None:
    summary = run(argv)
    print(json.dumps(summary))
    if "error" in summary:
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
