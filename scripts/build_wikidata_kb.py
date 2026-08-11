#!/usr/bin/env python3
"""Build `src/kb/wikidata-slice.tsv`, the vendored entity-linking asset.

Fetches a bounded slice of Wikidata over the public SPARQL endpoint and reduces
it to a compact TSV. Run offline-prep only: shodh itself never makes a network
call, it just `include_str!`s the result. See `src/kb/NOTICE` for provenance and
the exact set of mechanical transformations this applies.

    python scripts/build_wikidata_kb.py                    # writes src/kb/wikidata-slice.tsv
    python scripts/build_wikidata_kb.py --floor 20         # smaller/stricter slice
    python scripts/build_wikidata_kb.py --save-raw raw.jsonl   # keep the pull
    python scripts/build_wikidata_kb.py --raw raw.jsonl --floor 20  # re-cut, no refetch

Design notes that are easy to get wrong if you regenerate this:

  * Subclass recursion (`wdt:P31/wdt:P279*`) times out on WDQS for anything as
    large as "organization". The class list below is therefore explicit and
    concrete, and was chosen empirically (see `--discover`).
  * The sitelink floor is the size knob AND the quality floor. Lowering it grows
    the asset and the ambiguity rate together.
  * Descriptions are deliberately NOT fetched: they would multiply the asset
    size and, if sourced from Wikipedia text, would not be CC0.
  * Homonyms are NOT collapsed here. Every candidate for a surface must survive
    into the asset, because `src/kb/mod.rs` needs to see the ambiguity at lookup
    time in order to abstain. Collapsing here would make abstention impossible.
"""

import argparse
import collections
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

UA = "shodh-memory-kb-slice/1.0 (https://github.com/varun29ankuS/shodh-memory)"
ENDPOINT = "https://query.wikidata.org/sparql"

# (class QID, shodh coarse type, human note). Concrete classes only.
CLASSES = [
    ("Q4830453", "organization", "business"),
    ("Q783794", "organization", "company"),
    ("Q891723", "organization", "public company"),
    ("Q43229", "organization", "organization"),
    ("Q6881511", "organization", "enterprise"),
    ("Q161726", "organization", "multinational corporation"),
    ("Q18388277", "organization", "technology company"),
    ("Q1058914", "organization", "software company"),
    ("Q3918", "organization", "university"),
    ("Q875538", "organization", "public university"),
    ("Q31855", "organization", "research institute"),
    ("Q327333", "organization", "government agency"),
    ("Q484652", "organization", "international organization"),
    ("Q7278", "organization", "political party"),
    ("Q163740", "organization", "nonprofit organization"),
    ("Q7397", "product", "software"),
    ("Q9143", "product", "programming language"),
    ("Q166142", "product", "application software"),
    ("Q218616", "product", "proprietary software"),
    ("Q341", "product", "free software"),
    ("Q1130645", "product", "open-source software"),
    ("Q506883", "product", "free and open-source software"),
    ("Q188860", "product", "software library"),
    ("Q20825628", "product", "GNU package"),
    ("Q620615", "product", "mobile app"),
    ("Q9135", "product", "operating system"),
    ("Q1330336", "product", "web framework"),
    ("Q271680", "product", "software framework"),
    ("Q6368", "product", "web browser"),
    ("Q131093", "product", "content management system"),
    ("Q783866", "product", "JavaScript library"),
    ("Q13741", "product", "integrated development environment"),
    ("Q131212", "product", "text editor"),
    ("Q3932296", "product", "database management system"),
    ("Q35127", "product", "website"),
    ("Q193564", "product", "game engine"),
    ("Q3966", "product", "computer hardware"),
    ("Q2424752", "product", "product"),
    ("Q431289", "product", "brand"),
    ("Q11661", "product", "information technology"),
]

# Sports clubs and musical groups are deliberately absent. They are dense in
# nicknames ("The Reds", "AFC", "ACM") that collide with the acronyms a work or
# technical corpus actually uses, and they are not what this product's users
# write about. Their removal measurably reduced false ambiguity.

FETCH = """SELECT ?item ?sl ?label (GROUP_CONCAT(DISTINCT ?alt;separator="|") AS ?alts) WHERE {
  ?item wdt:P31 wd:%s ; wikibase:sitelinks ?sl ; rdfs:label ?label .
  FILTER(?sl >= %d) FILTER(lang(?label)="en")
  OPTIONAL {
    { ?item skos:altLabel ?alt . FILTER(lang(?alt)="en") }
    UNION { ?item wdt:P1448 ?alt . FILTER(lang(?alt)="en") }
    UNION { ?item wdt:P1813 ?alt . FILTER(lang(?alt)="en") }
    UNION { ?item wdt:P1449 ?alt . FILTER(lang(?alt)="en") }
  }
} GROUP BY ?item ?sl ?label"""

DISCOVER = """SELECT ?cls ?clsLabel (COUNT(DISTINCT ?item) AS ?n) WHERE {
  ?item wdt:P277 ?lang ; wikibase:sitelinks ?sl ; wdt:P31 ?cls .
  FILTER(?sl >= %d)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?cls ?clsLabel ORDER BY DESC(?n) LIMIT 30"""

DOMAINISH = re.compile(
    r"^[\w.\-]+\.(com|org|net|io|gov|edu|de|fr|jp|cn|uk|ru|it|es|nl)$", re.I
)
PAREN_TAIL = re.compile(r"\s*\([^()]*\)\s*$")
WHITESPACE = re.compile(r"\s+")
WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
MAX_ALIASES = 12

# Descriptive organisational vocabulary. A surface form built ENTIRELY out of
# these is a description, not a name, and linking on it is how you get
# "international company" → Wells Fargo and "team" → Q327245. Measured on
# LoCoMo ORG mentions, dropping these removed two of the three false links.
#
# The list is deliberately confined to organisational/administrative words. It
# must NOT grow into a general stopword list: "Apple", "Oracle", "Shell", "Gap",
# "Target", "Square" and "Orange" are ordinary English words AND major
# companies, and suppressing them would cost far more than it saves.
GENERIC_WORDS = set("""
a an the and or of for in on at to by with from
company companies corporation corporate business firm enterprise enterprises
organization organisation organizations organisations institution institutions
team teams group groups division divisions department departments unit units
service services system systems solution solutions product products platform
project projects program programme network networks partner partners holding
holdings venture ventures industries industry industrial international national
global regional local worldwide universal general common central federal state
public private limited incorporated association associations society societies
foundation foundations institute institutes council committee bureau agency
agencies office offices center centre centers centres club clubs union unions
company's national's cooperative collective consortium alliance federation
authority authorities board trust trusts fund funds bank banks insurance
technology technologies engineering manufacturing trading commerce commercial
development research laboratory laboratories works factory studio studios
new old first second third main major minor big small great little
""".split())


def query(sparql, tries=3):
    """Run a SPARQL query, retrying transient WDQS timeouts."""
    url = ENDPOINT + "?" + urllib.parse.urlencode({"query": sparql, "format": "json"})
    for attempt in range(tries):
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Accept": "application/sparql-results+json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read().decode("utf-8"))["results"]["bindings"]
        except Exception as exc:  # noqa: BLE001 - retry anything transient
            sys.stderr.write("  retry %d/%d: %s\n" % (attempt + 1, tries, str(exc)[:90]))
            time.sleep(5 * (attempt + 1))
    return None


def clean(text):
    """Normalise a surface form: NFC, no tabs/pipes (the field separators), single spaces."""
    text = unicodedata.normalize("NFC", text or "").replace("\t", " ").replace("|", " ")
    return WHITESPACE.sub(" ", text).strip()


def is_descriptive(form):
    """True when every word in `form` is generic organisational vocabulary."""
    words = WORD.findall(form.lower())
    return bool(words) and all(w in GENERIC_WORDS for w in words)


def alias_forms(raw):
    """Hygiene for one raw alias; yields zero or one usable surface form."""
    alias = clean(raw)
    if not alias:
        return []
    # A trailing parenthetical is a Wikidata disambiguator, not something a
    # person writes: keep the head ("... Corporation (Armonk, NY)").
    head = clean(PAREN_TAIL.sub("", alias))
    form = head if head and head != alias else alias
    if len(form) < 2:
        return []
    if DOMAINISH.match(form):                                   # "ibm.com"
        return []
    if len(form) <= 4 and any(c.isdigit() for c in form):       # "18M"
        return []
    if not any(c.isalpha() for c in form):
        return []
    if is_descriptive(form):                                    # "International company"
        return []
    return [form]


def fetch(floor):
    entities = {}
    for cls, coarse, note in CLASSES:
        rows = query(FETCH % (cls, floor))
        if rows is None:
            sys.stderr.write("FAILED %s (%s) - slice will be incomplete\n" % (cls, note))
            continue
        added = 0
        for row in rows:
            qid = row["item"]["value"].rsplit("/", 1)[-1]
            if not qid.startswith("Q"):
                continue
            alts = [a for a in row.get("alts", {}).get("value", "").split("|") if a.strip()]
            found = entities.get(qid)
            if found is None:
                entities[qid] = {
                    "qid": qid,
                    "type": coarse,
                    "sitelinks": int(row["sl"]["value"]),
                    "label": row["label"]["value"],
                    "aliases": alts,
                }
                added += 1
            else:
                # Reached through several classes: union the surface forms.
                found["aliases"] = list(dict.fromkeys(found["aliases"] + alts))
        sys.stderr.write(
            "%-13s %-34s +%-6d total=%d\n" % (coarse, note, added, len(entities))
        )
    return list(entities.values())


def write_tsv(entities, path):
    rows = []
    for e in entities:
        label = clean(e["label"])
        if len(label) < 2 or not any(c.isalpha() for c in label):
            continue
        # An entity whose own name is a description ("team") is a concept entry,
        # not a nameable organisation, and is pure linking hazard.
        if is_descriptive(label):
            continue
        seen = {label.lower()}
        aliases = []
        for raw in e["aliases"]:
            for form in alias_forms(raw):
                if form.lower() not in seen:
                    seen.add(form.lower())
                    aliases.append(form)
        rows.append((e["qid"], e["type"], int(e["sitelinks"]), label, sorted(aliases)[:MAX_ALIASES]))

    # Stable, diffable order.
    rows.sort(key=lambda r: (-r[2], r[0]))
    with open(path, "w", encoding="utf-8", newline="\n") as out:
        for qid, coarse, sitelinks, label, aliases in rows:
            out.write("%s\t%s\t%d\t%s\t%s\n" % (qid, coarse, sitelinks, label, "|".join(aliases)))

    by_type = collections.Counter(r[1] for r in rows)
    surfaces = sum(len(r[4]) for r in rows)
    size = os.path.getsize(path)
    print(
        "wrote %s: %d entities (%s), %d aliases, %.2f MB"
        % (path, len(rows), dict(by_type), surfaces, size / 1e6)
    )


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.join(here, "..", "src", "kb", "wikidata-slice.tsv")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--floor", type=int, default=12, help="minimum Wikipedia sitelinks")
    ap.add_argument("--out", default=os.path.normpath(default_out))
    ap.add_argument(
        "--discover",
        action="store_true",
        help="print the most common P31 classes among software entities and exit",
    )
    ap.add_argument(
        "--raw",
        help="rebuild from a cached fetch (JSONL) instead of querying WDQS; "
        "lets the floor and the hygiene rules be re-tuned without refetching",
    )
    ap.add_argument("--save-raw", help="write the fetched entities to this JSONL")
    args = ap.parse_args()

    if args.discover:
        for row in query(DISCOVER % args.floor) or []:
            print(
                "%-12s %-44s %s"
                % (
                    row["cls"]["value"].rsplit("/", 1)[-1],
                    row.get("clsLabel", {}).get("value", "")[:44],
                    row["n"]["value"],
                )
            )
        return 0

    if args.raw:
        entities = [json.loads(l) for l in open(args.raw, encoding="utf-8") if l.strip()]
    else:
        entities = fetch(args.floor)
        if args.save_raw:
            with open(args.save_raw, "w", encoding="utf-8") as f:
                for e in entities:
                    f.write(json.dumps(e, ensure_ascii=False) + "\n")
    if not entities:
        sys.exit("no entities fetched; refusing to overwrite the asset")
    # The floor applies whether the entities were just fetched or reloaded, so a
    # cached raw pull can be re-cut at a stricter floor without refetching.
    entities = [e for e in entities if int(e["sitelinks"]) >= args.floor]
    write_tsv(entities, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
