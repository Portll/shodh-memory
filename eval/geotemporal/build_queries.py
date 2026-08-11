#!/usr/bin/env python3
"""Build a held-out geotemporal query set (queries.jsonl) from a GDELT GKG
corpus already ingested into shodh-memory via scripts/gdelt/ingest_gkg.py.

Three query families, mechanically derived -- never from retrieval:

  - radius_window (default 25): pick a location cluster (grid cell) + the
    date window spanning its members; gold = every corpus record whose
    primary location is within the cluster's radius AND whose date falls in
    the window, computed over the FULL corpus (not just the cluster).
  - precedence (default 15): "what preceded X near Y" -- gold = in-radius
    records dated strictly before X's date, within a 7-day lookback window.
    Anchors are deduped by cluster (grid cell): once a cluster has produced
    one precedence query, later anchors in the same cluster are skipped, so
    a single-event-dominated corpus can't collapse most of `n` onto
    near-identical copies of the same query.
  - negative controls (default 10): clone an existing query's text/window
    verbatim but move the geo center by >2000km (verified empty against the
    full corpus at build time); expect_empty=true.

Determinism: no clock, no RNG, no seeds. Cluster/anchor selection is always
sorted by a deterministic key (the minimum member id in a cluster; a
record's own id for precedence anchors) before taking the first N.

Correlation-loss gate: gold sets and negative-control "verified empty"
checks are computed over `matched_rows` -- the subset of the corpus that
successfully correlated to a server-assigned id (see
`correlate_with_server`). If more than `MAX_UNMATCHED_FRACTION` (5%) of
usable GKG rows failed to correlate, `run()` refuses to build a query set
at all: a gold set derived from an incomplete view of the corpus
under-derives (inflating measured recall) and weakens the negative
controls' empty-radius guarantee, silently, unless this is gated.

Gold derivation reuses scripts/gdelt/v2locations.py and
scripts/gdelt/ingest_gkg.py's `build_payload` -- the exact same
parse-and-transform used at ingest time -- rather than re-implementing GKG
parsing. `build_payload`'s output (content, geo_location, created_at) is
also the correlation key back to the server: the server's content-hash
dedup means identical content maps to one memory id, and `/api/memories`
pagination is the only way to learn what id the server assigned (there is
no gkg-record-id echo in the API). See `correlate_with_server`'s docstring
for the known limitation of prefix-based content matching.

Known limitation (server API surface, not this script): `/api/recall` has
no time-range parameter (verified against src/handlers/types.rs's
RecallRequest) -- window filtering for scoring happens client-side in
run_eval.py, not here. This script only needs the *corpus's* dates (parsed
locally / read back via /api/memories) to build gold sets and windows.

stdlib-only (urllib), no third-party HTTP dependency -- consistent with
scripts/gdelt/ingest_gkg.py.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional, Sequence, Tuple

# Reuse Task 4's parser -- do not reimplement GKG/V2Locations parsing.
_GDELT_DIR = Path(__file__).resolve().parents[2] / "scripts" / "gdelt"
if str(_GDELT_DIR) not in sys.path:
    sys.path.insert(0, str(_GDELT_DIR))

from ingest_gkg import build_payload, iter_gkg_rows  # noqa: E402

# =============================================================================
# Constants (all deterministic, all documented -- no magic numbers left bare)
# =============================================================================
CELL_SIZE_DEG = 1.0
"""Grid-cell edge length used to group corpus rows into location clusters.
1 degree (~111km at the equator, less at higher latitudes) is a coarse but
adequate granularity for a held-out geotemporal smoke set; it is not a
claim about real-world administrative or perceptual regions."""

CLUSTER_RADIUS_BUFFER_M = 500.0
"""Flat buffer added to a cluster's centroid->farthest-member distance so
every member is guaranteed to be `<= radius` under the server's own
haversine `contains()` check (avoids floating-point boundary misses)."""

MATCH_PREVIEW_CHARS = 500
"""Must equal src/handlers/crud.rs's LIST_CONTENT_PREVIEW_CHARS -- the
content-preview truncation length used by /api/memories' list endpoint.
Matching keys are built by slicing to this length on both sides so the
comparison is correct whether or not server-side truncation occurred."""

PRECEDENCE_WINDOW_DAYS = 7

NEGATIVE_LAT_SHIFT_CANDIDATES_DEG: Tuple[float, ...] = (20.0, -20.0, 30.0, -30.0, 40.0, -40.0)
"""Candidate latitude shifts for negative controls, tried in order. 20
degrees of latitude is ~2220km at any longitude -- comfortably over the
brief's >2000km requirement -- regardless of which direction the shift
goes. Larger candidates are fallbacks for the rare case where the first
shift lands in another populated cluster."""

DEFAULT_NUM_RADIUS_WINDOW = 25
DEFAULT_NUM_PRECEDENCE = 15
DEFAULT_NUM_NEGATIVE = 10

MAX_UNMATCHED_FRACTION = 0.05
"""Correlation-loss gate. `correlate_with_server` links each locally-parsed
GKG row to a server-assigned memory id by content (see its docstring for
why content is the only available key); rows that fail to correlate are
simply absent from `matched_rows`, which is the population gold sets and
negative-control "verified empty" checks are computed over. If too large a
fraction of the corpus failed to correlate, gold sets are derived from an
incomplete view of the corpus -- gold under-derives (a record that should
be gold but didn't correlate silently inflates measured recall) and a
negative control's empty-radius guarantee is only as good as the rows it
could see (an out-of-radius record that failed to correlate can't be
caught by the overlap check either). Past this threshold, `run()` refuses
to build a query set at all rather than emit a queries.jsonl that would
produce a misleading headline recall number."""

_EARTH_RADIUS_M = 6_371_000.0
"""Must match src/memory/types.rs's GeoFilter::haversine_distance exactly
(same constant, same formula) so gold derivation agrees with the server's
own radius filter, bit for bit modulo floating-point library differences."""


# =============================================================================
# Geometry / time (pure)
# =============================================================================
def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in meters. Mirrors
    src/memory/types.rs::GeoFilter::haversine_distance exactly."""
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2.0) ** 2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon / 2.0) ** 2
    c = 2.0 * math.asin(math.sqrt(a))
    return _EARTH_RADIUS_M * c


def parse_iso8601(value: str) -> datetime:
    """Parse an RFC3339/ISO8601 timestamp as emitted either by
    ingest_gkg.parse_gkg_date (a bare `Z` suffix, second precision) or by
    Rust's `chrono::DateTime::to_rfc3339()` (numeric offset, with
    variable-precision fractional seconds up to nanoseconds when nonzero).
    `datetime.fromisoformat` -- the stdlib parser targeted here for
    requires-python>=3.8 compatibility -- accepts numeric offsets but,
    pre-3.11, neither a bare `Z` suffix nor fractional seconds of any
    length other than exactly 3 or 6 digits. Both occur in practice here,
    so both are normalized before parsing."""
    v = value.strip()
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    if "." in v:
        head, _, rest = v.partition(".")
        i = 0
        while i < len(rest) and rest[i].isdigit():
            i += 1
        frac, tz = rest[:i], rest[i:]
        frac = (frac + "000000")[:6]
        v = f"{head}.{frac}{tz}"
    return datetime.fromisoformat(v)


def grid_cell(lat: float, lon: float, cell_deg: float = CELL_SIZE_DEG) -> Tuple[int, int]:
    return (math.floor(lat / cell_deg), math.floor(lon / cell_deg))


class CorpusRow(NamedTuple):
    """A GKG record for which we have both the server-assigned memory id
    and the (lat, lon, created_at) needed to compute gold sets."""
    id: str
    lat: float
    lon: float
    created_at: datetime
    content: str


def cluster_centroid_and_radius(members: Sequence[CorpusRow]) -> Tuple[float, float, float]:
    """Centroid (mean lat/lon) of `members` plus a radius guaranteed to
    cover every member (max distance to centroid + a fixed buffer)."""
    lat = sum(m.lat for m in members) / len(members)
    lon = sum(m.lon for m in members) / len(members)
    max_dist = max(haversine_distance_m(lat, lon, m.lat, m.lon) for m in members)
    radius = max_dist + CLUSTER_RADIUS_BUFFER_M
    return lat, lon, radius


def compute_in_radius_window_ids(
    rows: Sequence[CorpusRow],
    center_lat: float,
    center_lon: float,
    radius_m: float,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    end_inclusive: bool = True,
) -> List[str]:
    """All `rows` ids within `radius_m` of the center AND within
    [start, end] (end inclusive by default; pass end_inclusive=False for
    "strictly before end", used by precedence queries so the anchor's own
    instant is excluded from its own "preceded by" gold set)."""
    out = []
    for r in rows:
        if haversine_distance_m(center_lat, center_lon, r.lat, r.lon) > radius_m:
            continue
        if start is not None and r.created_at < start:
            continue
        if end is not None:
            if end_inclusive and r.created_at > end:
                continue
            if not end_inclusive and r.created_at >= end:
                continue
        out.append(r.id)
    return sorted(out)


# =============================================================================
# Local GKG parsing (reuses Task 4's ingest_gkg.build_payload)
# =============================================================================
class LoadStats(NamedTuple):
    total_rows: int
    skipped_blank: int
    missing_geo: int
    missing_date: int
    usable: int


def load_local_gkg_rows(gkg_input: str, user_id: str) -> Tuple[List[dict], LoadStats]:
    """Re-derive (content, lat, lon, created_at) for every row of the same
    GKG export file used to ingest the corpus, via `build_payload` -- the
    exact transform the server received. Rows missing either geo or date
    are counted (silent-data-loss rule) but excluded from the returned
    list: both are required to evaluate the radius+window/precedence
    criteria. Raises OSError if `gkg_input` cannot be read (caller's job to
    turn that into a reported error, not a traceback -- see `run()`)."""
    columns, rows = iter_gkg_rows(gkg_input)
    total = 0
    skipped_blank = 0
    missing_geo = 0
    missing_date = 0
    out: List[dict] = []
    for row in rows:
        total += 1
        payload, _stats = build_payload(row, user_id, columns)
        if payload is None:
            skipped_blank += 1
            continue
        geo = payload.get("geo_location")
        created_at_raw = payload.get("created_at")
        if geo is None:
            missing_geo += 1
        if created_at_raw is None:
            missing_date += 1
        if geo is None or created_at_raw is None:
            continue
        out.append({
            "content": payload["content"],
            "lat": geo[0],
            "lon": geo[1],
            "created_at": parse_iso8601(created_at_raw),
        })
    stats = LoadStats(
        total_rows=total, skipped_blank=skipped_blank,
        missing_geo=missing_geo, missing_date=missing_date, usable=len(out),
    )
    return out, stats


# =============================================================================
# Server correlation: link local GKG rows to server-assigned memory ids
# =============================================================================
def match_key(content: str) -> Tuple[str, int]:
    """(prefix, total_length) key used to correlate a locally-parsed GKG
    row's full content against a server ListMemoryItem's possibly-truncated
    preview. `content[:MATCH_PREVIEW_CHARS]` on the local side lines up
    with the server's preview (itself `.chars().take(500)`) whether or not
    truncation actually happened -- if it didn't, content[:500] == content
    on both sides anyway."""
    return (content[:MATCH_PREVIEW_CHARS], len(content))


class CorrelationStats(NamedTuple):
    server_total: int
    matched: int
    unmatched: int
    ambiguous_keys: int


def correlate_with_server(
    local_rows: Sequence[dict], server_items: Sequence[dict],
) -> Tuple[List[CorpusRow], CorrelationStats]:
    """Match locally-parsed GKG rows to server-assigned memory ids by
    content. This is the one place a real limitation of the API surface
    shows up: `/api/memories` returns no gkg-record-id (there isn't one to
    return -- the server never stored it), so content is the only
    available correlation key, and the *listing* endpoint truncates
    content to 500 chars. Matching on (prefix, exact total length) rather
    than prefix alone rules out the truncation case trivially (prefix ==
    full content when length <= 500) and narrows the residual collision
    risk -- two DISTINCT full-length contents sharing both a 500-char
    prefix and an identical total length -- to a case indistinguishable
    from a true duplicate (which the server's content-hash dedup would
    also have merged to one id, so mapping them together is the correct
    outcome even then). Any (prefix, length) key claimed by more than one
    distinct server id is dropped from the map entirely (silent
    mis-mapping is worse than an honest unmatched count) and counted in
    `ambiguous_keys`. Rows with no server match are counted in
    `unmatched`, never silently skipped."""
    server_map: Dict[Tuple[str, int], str] = {}
    ambiguous: set = set()
    for item in server_items:
        key = (item["content"], item["content_length"])
        existing = server_map.get(key)
        if existing is not None and existing != item["id"]:
            ambiguous.add(key)
        else:
            server_map[key] = item["id"]
    for key in ambiguous:
        server_map.pop(key, None)

    matched_rows: List[CorpusRow] = []
    seen_ids: set = set()
    unmatched = 0
    for row in local_rows:
        key = match_key(row["content"])
        server_id = server_map.get(key)
        if server_id is None:
            unmatched += 1
            continue
        if server_id in seen_ids:
            # Multiple local rows resolved to the same server id (the
            # server's content-hash dedup collapsed them at ingest time) --
            # keep one CorpusRow per id so clusters/gold sets aren't
            # inflated by counting the same memory twice.
            continue
        seen_ids.add(server_id)
        matched_rows.append(CorpusRow(
            id=server_id, lat=row["lat"], lon=row["lon"],
            created_at=row["created_at"], content=row["content"],
        ))

    stats = CorrelationStats(
        server_total=len(server_items),
        matched=len(matched_rows),
        unmatched=unmatched,
        ambiguous_keys=len(ambiguous),
    )
    return matched_rows, stats


# =============================================================================
# Clustering
# =============================================================================
def build_clusters(
    rows: Sequence[CorpusRow], cell_deg: float = CELL_SIZE_DEG,
) -> Dict[Tuple[int, int], List[CorpusRow]]:
    clusters: Dict[Tuple[int, int], List[CorpusRow]] = {}
    for row in rows:
        key = grid_cell(row.lat, row.lon, cell_deg)
        clusters.setdefault(key, []).append(row)
    return clusters


def _cluster_sort_key(members: Sequence[CorpusRow]) -> str:
    """The cluster's deterministic sort key: the smallest member id.
    Ties the "sort by id, take first-N" determinism rule directly to
    cluster selection rather than to an arbitrary grid-index ordering."""
    return min(m.id for m in members)


def sorted_cluster_items(
    clusters: Dict[Tuple[int, int], List[CorpusRow]], min_size: int = 1,
) -> List[Tuple[Tuple[int, int], List[CorpusRow]]]:
    items = [(key, members) for key, members in clusters.items() if len(members) >= min_size]
    items.sort(key=lambda kv: _cluster_sort_key(kv[1]))
    return items


# =============================================================================
# Query family builders
# =============================================================================
def build_radius_window_queries(
    all_rows: Sequence[CorpusRow],
    clusters: Dict[Tuple[int, int], List[CorpusRow]],
    n: int = DEFAULT_NUM_RADIUS_WINDOW,
) -> Tuple[List[dict], int]:
    """Pick up to `n` clusters (sorted deterministically, preferring
    size>=2 so windows are non-degenerate, falling back to size-1 clusters
    only if there aren't enough larger ones) and build one query per
    cluster. Gold is recomputed over the FULL corpus (`all_rows`), not just
    the cluster's own members -- other clusters can legitimately overlap a
    given radius+window. Returns (queries, clusters_used_size_1) so the
    caller can report how many queries fell back to a degenerate
    single-record cluster."""
    used_keys: set = set()
    selected: List[Tuple[Tuple[int, int], List[CorpusRow]]] = []
    clusters_used_size_1 = 0
    for min_size in (2, 1):
        for key, members in sorted_cluster_items(clusters, min_size=min_size):
            if len(selected) >= n:
                break
            if key in used_keys:
                continue
            used_keys.add(key)
            selected.append((key, members))
            if len(members) == 1:
                clusters_used_size_1 += 1
        if len(selected) >= n:
            break

    queries: List[dict] = []
    for i, (_key, members) in enumerate(selected, start=1):
        center_lat, center_lon, radius_m = cluster_centroid_and_radius(members)
        start = min(m.created_at for m in members)
        end = max(m.created_at for m in members)
        if start == end:
            # A single-instant (or single-record) cluster has zero window
            # width; widen symmetrically so the query has a real window.
            start = start - timedelta(days=1)
            end = end + timedelta(days=1)
        gold_ids = compute_in_radius_window_ids(all_rows, center_lat, center_lon, radius_m, start, end)
        queries.append({
            "qid": f"rw_{i:04d}",
            "family": "radius_window",
            "text": (
                f"What happened within {radius_m / 1000.0:.1f} km of "
                f"({center_lat:.4f}, {center_lon:.4f}) between "
                f"{start.isoformat()} and {end.isoformat()}?"
            ),
            "geo": {"lat": center_lat, "lon": center_lon, "radius_m": radius_m},
            # end_inclusive=True: gold was computed with the end bound
            # inclusive (compute_in_radius_window_ids' default). run_eval.py
            # reads this flag so its client-side window filter uses the SAME
            # inclusivity as the gold it's being scored against, rather than
            # a hardcoded assumption that could silently diverge from
            # whichever family emitted the query (see precedence's
            # end_inclusive=False below).
            "window": {"start": start.isoformat(), "end": end.isoformat(), "end_inclusive": True},
            "gold_ids": gold_ids,
            "expect_empty": False,
        })
    return queries, clusters_used_size_1


def build_precedence_queries(
    all_rows: Sequence[CorpusRow],
    clusters: Dict[Tuple[int, int], List[CorpusRow]],
    n: int = DEFAULT_NUM_PRECEDENCE,
    window_days: int = PRECEDENCE_WINDOW_DAYS,
) -> List[dict]:
    """For each candidate anchor (corpus rows sorted by id, deterministic),
    build "what preceded X near Y" with gold = in-radius records dated
    strictly before X, within a `window_days`-day lookback. Anchors whose
    resulting gold set is empty are skipped (a query with no possible
    positive answer isn't a meaningful precedence test); iteration
    continues until `n` are built or anchors are exhausted.

    Cluster-level dedup: once a cluster (grid cell) has produced one
    precedence query, further anchors that fall in the SAME cluster are
    skipped. Without this, a single-event-dominated corpus (many records
    in one cell) would collapse most of the `n` requested queries onto
    near-identical centroid/radius/gold, which isn't a held-out set of
    `n` distinct tests -- it's one test copy-pasted. A cluster is only
    marked used once a query is actually built from it (not on every
    anchor visited), so an earlier anchor with empty gold doesn't burn the
    cluster's slot for a later anchor in the same cell that would have
    non-empty gold. If the corpus can't yield `n` distinct clusters, this
    returns fewer queries -- callers (see `run()`) surface that shortfall
    explicitly rather than padding with near-duplicates."""
    anchors_sorted = sorted(all_rows, key=lambda r: r.id)
    queries: List[dict] = []
    used_cluster_keys: set = set()
    for anchor in anchors_sorted:
        if len(queries) >= n:
            break
        key = grid_cell(anchor.lat, anchor.lon)
        if key in used_cluster_keys:
            continue
        members = clusters.get(key, [anchor])
        center_lat, center_lon, radius_m = cluster_centroid_and_radius(members)
        end = anchor.created_at
        start = end - timedelta(days=window_days)
        gold_ids = compute_in_radius_window_ids(
            all_rows, center_lat, center_lon, radius_m, start, end, end_inclusive=False,
        )
        if not gold_ids:
            continue
        used_cluster_keys.add(key)
        idx = len(queries) + 1
        queries.append({
            "qid": f"pr_{idx:04d}",
            "family": "precedence",
            "text": (
                # Uses the cluster CENTROID (center_lat/center_lon), not
                # the anchor's own raw coordinates -- the centroid is what
                # actually gets sent as the geo filter center, so the
                # query text must describe the location the server will
                # actually search around.
                f"What preceded the event near ({center_lat:.4f}, {center_lon:.4f}) "
                f"on {anchor.created_at.isoformat()}, in the {window_days} days prior?"
            ),
            "geo": {"lat": center_lat, "lon": center_lon, "radius_m": radius_m},
            # end_inclusive=False: gold excludes the anchor's own instant
            # (and any other record at exactly that timestamp) -- "preceded
            # X" is strictly before X, not inclusive of X. run_eval.py reads
            # this flag so its client-side window filter matches (see
            # radius_window's end_inclusive=True above for the contrast).
            "window": {"start": start.isoformat(), "end": end.isoformat(), "end_inclusive": False},
            "gold_ids": gold_ids,
            "expect_empty": False,
        })
    return queries


def build_negative_controls(
    base_queries: Sequence[dict],
    all_rows: Sequence[CorpusRow],
    n: int = DEFAULT_NUM_NEGATIVE,
    shift_candidates: Sequence[float] = NEGATIVE_LAT_SHIFT_CANDIDATES_DEG,
) -> List[dict]:
    """Clone up to `n` of `base_queries` (sorted by qid, deterministic),
    keeping the text and window IDENTICAL but moving the geo center's
    latitude by one of `shift_candidates` degrees (>2000km at any
    longitude). Each candidate shift is verified against the full corpus
    (radius-only, window ignored -- the runner's negative-control check is
    also window-independent, a pure geo-leakage test) before being
    accepted; the first source query for which no candidate shift is
    empty is simply skipped in favor of the next source query, rather than
    emitting a negative control that isn't actually guaranteed empty."""
    sources = sorted(base_queries, key=lambda q: q["qid"])
    selected: List[Tuple[dict, float, float]] = []
    for source in sources:
        if len(selected) >= n:
            break
        lat = source["geo"]["lat"]
        lon = source["geo"]["lon"]
        radius_m = source["geo"]["radius_m"]
        for shift in shift_candidates:
            new_lat = lat + shift
            if not (-90.0 <= new_lat <= 90.0):
                continue
            overlap = compute_in_radius_window_ids(all_rows, new_lat, lon, radius_m)
            if not overlap:
                selected.append((source, new_lat, lon))
                break

    queries: List[dict] = []
    for i, (source, new_lat, new_lon) in enumerate(selected, start=1):
        queries.append({
            "qid": f"neg_{i:04d}",
            "family": "negative",
            "text": source["text"],
            "geo": {"lat": new_lat, "lon": new_lon, "radius_m": source["geo"]["radius_m"]},
            "window": dict(source["window"]) if source.get("window") else None,
            "gold_ids": [],
            "expect_empty": True,
        })
    return queries


# =============================================================================
# Output
# =============================================================================
def write_queries_jsonl(path: str, queries: Sequence[dict]) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        for q in queries:
            fh.write(json.dumps(q, sort_keys=True))
            fh.write("\n")


# =============================================================================
# HTTP: paginate /api/memories (stdlib urllib only)
# =============================================================================
def _fetch_memories_page(
    server: str, user_id: str, limit: int, offset: int,
    api_key: Optional[str] = None, timeout: float = 10.0,
) -> dict:
    qs = urllib.parse.urlencode({"user_id": user_id, "limit": limit, "offset": offset})
    url = f"{server.rstrip('/')}/api/memories?{qs}"
    request = urllib.request.Request(url, method="GET")
    if api_key:
        request.add_header("Authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8")
    return json.loads(body) if body else {"memories": [], "total": 0}


def fetch_all_server_memories(
    server: str, user_id: str, api_key: Optional[str] = None,
    page_size: int = 1000, timeout: float = 10.0,
) -> List[dict]:
    """Paginate GET /api/memories (PR #409's offset/limit pagination,
    per src/handlers/crud.rs) until every record for `user_id` has been
    fetched. Stops on an empty page or once `total` is reached, whichever
    comes first -- guards against an infinite loop if the server's
    `total` accounting and actual page contents ever disagree."""
    items: List[dict] = []
    offset = 0
    while True:
        page = _fetch_memories_page(server, user_id, page_size, offset, api_key=api_key, timeout=timeout)
        batch = page.get("memories", [])
        if not batch:
            break
        items.extend(batch)
        offset += len(batch)
        total = page.get("total")
        if total is not None and offset >= total:
            break
        if len(batch) < page_size:
            break
    return items


# =============================================================================
# CLI
# =============================================================================
def _default_output_path() -> str:
    return str(Path(__file__).resolve().parent / "queries.jsonl")


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True, help="shodh-memory server base URL, e.g. http://localhost:9944")
    parser.add_argument("--user-id", required=True, help="user_id the GDELT corpus was ingested under")
    parser.add_argument("--gkg-input", required=True, help="path to the SAME GKG export used to ingest the corpus")
    parser.add_argument("--output", default=_default_output_path(), help="output queries.jsonl path")
    parser.add_argument("--page-size", type=int, default=1000, help="/api/memories pagination page size")
    parser.add_argument("--cell-deg", type=float, default=CELL_SIZE_DEG, help="grid cell size in degrees")
    parser.add_argument("--num-radius-window", type=int, default=DEFAULT_NUM_RADIUS_WINDOW)
    parser.add_argument("--num-precedence", type=int, default=DEFAULT_NUM_PRECEDENCE)
    parser.add_argument("--num-negative", type=int, default=DEFAULT_NUM_NEGATIVE)
    parser.add_argument(
        "--api-key", default=os.environ.get("SHODH_API_KEY"),
        help="bearer token for SHODH_API_KEYS-protected servers (default: $SHODH_API_KEY)",
    )
    return parser


def run(argv: Optional[Sequence[str]] = None) -> dict:
    args = _build_arg_parser().parse_args(argv)

    try:
        local_rows, load_stats = load_local_gkg_rows(args.gkg_input, args.user_id)
    except OSError as e:
        return {"error": f"could not read --gkg-input {args.gkg_input}: {e}"}

    try:
        server_items = fetch_all_server_memories(
            args.server, args.user_id, api_key=args.api_key, page_size=args.page_size,
        )
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        return {"error": f"could not fetch corpus from {args.server}: {e}"}

    matched_rows, corr_stats = correlate_with_server(local_rows, server_items)

    unmatched_fraction = (corr_stats.unmatched / load_stats.usable) if load_stats.usable else 0.0
    if unmatched_fraction > MAX_UNMATCHED_FRACTION:
        return {
            "error": (
                f"correlation loss too high: {unmatched_fraction:.1%} of usable GKG rows "
                f"({corr_stats.unmatched}/{load_stats.usable}) did not correlate to a "
                f"server-assigned id, exceeding the {MAX_UNMATCHED_FRACTION:.0%} threshold "
                "-- refusing to build a query set from a partially-correlated corpus"
            ),
            "correlation_unmatched_fraction": unmatched_fraction,
            "rows_matched": corr_stats.matched,
            "rows_unmatched": corr_stats.unmatched,
            "ambiguous_keys": corr_stats.ambiguous_keys,
            "gkg_rows_usable": load_stats.usable,
        }

    clusters = build_clusters(matched_rows, cell_deg=args.cell_deg)
    radius_window_queries, clusters_used_size_1 = build_radius_window_queries(
        matched_rows, clusters, n=args.num_radius_window,
    )
    precedence_queries = build_precedence_queries(matched_rows, clusters, n=args.num_precedence)
    negative_queries = build_negative_controls(
        radius_window_queries + precedence_queries, matched_rows, n=args.num_negative,
    )

    all_queries = radius_window_queries + precedence_queries + negative_queries
    write_queries_jsonl(args.output, all_queries)

    return {
        "output": args.output,
        "gkg_rows_total": load_stats.total_rows,
        "gkg_rows_skipped_blank": load_stats.skipped_blank,
        "gkg_rows_missing_geo": load_stats.missing_geo,
        "gkg_rows_missing_date": load_stats.missing_date,
        "gkg_rows_usable": load_stats.usable,
        "server_corpus_total": corr_stats.server_total,
        "rows_matched": corr_stats.matched,
        "rows_unmatched": corr_stats.unmatched,
        "correlation_unmatched_fraction": unmatched_fraction,
        "ambiguous_keys": corr_stats.ambiguous_keys,
        "radius_window_requested": args.num_radius_window,
        "radius_window_built": len(radius_window_queries),
        "precedence_requested": args.num_precedence,
        "precedence_built": len(precedence_queries),
        "negative_requested": args.num_negative,
        "negative_built": len(negative_queries),
        "clusters_used_size_1": clusters_used_size_1,
    }


def main(argv: Optional[Sequence[str]] = None) -> None:
    summary = run(argv)
    print(json.dumps(summary))
    if "error" in summary:
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
