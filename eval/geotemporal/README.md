# Geotemporal eval set (held-out)

Builds a held-out set of ~50 geo+time queries against an ingested GDELT GKG
corpus, and scores `recall@10` + negative-control pass rate against a live
shodh-memory server. This is Task 5 of the geotemporal phase-01 plan; it
consumes Task 4's GDELT parser/ingest script (`scripts/gdelt/`) and Task
2/3's composed geo retrieval (`geo_lat`/`geo_lon`/`geo_radius_meters` on
`/api/recall`, now a hard radius filter + candidate-injection in every
retrieval mode, not just `mode=spatial`).

## Files

- `build_queries.py` — gold-set builder. Reads the same GKG export used at
  ingest time, re-derives (content, lat/lon, date) via
  `scripts/gdelt/ingest_gkg.build_payload` (reusing Task 4's parser, not
  reimplementing it), correlates each row to its server-assigned memory id
  via `/api/memories` pagination, and mechanically builds three query
  families into `queries.jsonl`.
- `run_eval.py` — runner. Reads `queries.jsonl`, POSTs `/api/recall` for
  each query, scores `recall@10` against `gold_ids`, and checks that every
  negative control returned zero results.
- `test_build_queries.py`, `test_run_eval.py` — pytest, pure-logic +
  file-I/O + stubbed-HTTP (`monkeypatch` on `urllib.request.urlopen`,
  matching `scripts/gdelt/test_ingest_gkg.py`'s pattern). **No test ever
  contacts a live server.**

## Query families

| Family          | Count | Gold definition |
|------------------|------:|------------------|
| `radius_window`  | 25    | Pick a location cluster (1°×1° grid cell, by default) + the date window spanning its members. Gold = every corpus record whose primary location is within the cluster's radius **and** whose date falls in the window (end inclusive) — recomputed over the *full* corpus, not just the cluster (other clusters can legitimately overlap). |
| `precedence`     | 15    | "What preceded record X near Y" — gold = in-radius records dated **strictly before** X (end exclusive), within a 7-day lookback window. Anchors with no possible gold are skipped. Deduped by cluster (grid cell): once a cluster has produced one precedence query, later anchors in the same cluster are skipped, so a single-event-dominated corpus can't collapse most of the 15 onto near-identical copies of the same query. |
| `negative`       | 10    | Clone an existing query's text and window **verbatim**, but move the geo center's latitude by ≥20° (>2000km at any longitude). Verified empty against the full corpus at *build* time before being accepted — this is a real negative control, not just a labeled one. `expect_empty=true`. |

Every query's `window` (when non-null) carries an explicit `end_inclusive`
flag: `true` for `radius_window` (gold's end bound is inclusive), `false`
for `precedence` (gold excludes the anchor's own instant). `run_eval.py`
reads this flag rather than hardcoding one inclusivity for both families —
see "Known limitation: window-bound inclusivity" below.

All selection is deterministic: no clock, no RNG, no seeds. Clusters and
precedence anchors are always sorted by a stable id-derived key (a
cluster's smallest member id; a record's own id) before taking the first
N. If the corpus doesn't have enough distinct multi-record clusters to
fill 25 `radius_window` (or 15 `precedence`) queries, the builder produces
fewer rather than padding with near-duplicates or under-filling silently
— compare `*_built` against `*_requested` in the builder's summary to see
any shortfall (`clusters_used_size_1` additionally reports how many
`radius_window` queries fell back to a degenerate single-record cluster).

## Known limitation: no server-side time filter

`/api/recall`'s `RecallRequest` (`src/handlers/types.rs`) has
`geo_lat`/`geo_lon`/`geo_radius_meters` but **no `time_range` parameter** —
unlike `RoboticsSearchRequest`, which does have
`time_range_start`/`time_range_end`. The brief anticipated a `time_range`
param on `/api/recall`; it does not exist, so `run_eval.py` requests
`limit=10` (the geo hard-filter still applies server-side) and applies the
date-window filter **client-side**, over each returned memory's
`created_at`, after the fact.

This is necessarily pessimistic: a gold item the server ranked 11th (or
worse) can never be recovered by client-side filtering of a 10-item
response, and an in-radius-but-out-of-window item occupying a top-10 slot
depresses the score for a reason that has nothing to do with geo
composition quality. To make that distortion visible instead of silently
baking it into one number, every `radius_window`/`precedence` query is
scored twice:

- **`recall_at_10`** — the headline metric: request `limit=10`, then
  window-filter. Literal compliance with the brief's `limit 10` request
  shape.
- **`recall_at_10_diagnostic_limit50`** — diagnostic only: request
  `limit=50`, window-filter, then truncate to top 10. Gives the window
  filter more candidates to work with before truncating, closer to what a
  real server-side `time_range` parameter would have produced. **Do not
  gate on this number** — it exists to separate "geo composition is
  broken" from "the API has no time-range param" when reading a result.

If a future PR adds `time_range_start`/`time_range_end` (or equivalent) to
`RecallRequest`, `run_eval.py` should be updated to pass it directly and
this client-side filter (and the diagnostic-limit split) should be
retired.

### Reading `recall_at_10` alongside `precision_at_10` and gold size

`recall_at_10` has a hard ceiling whenever a query's gold set is larger
than the request limit: with `|gold| = gold_count` and a fixed top-10
request, the best any retrieval quality can achieve is
`min(1.0, 10 / gold_count)`. A `radius_window` query over a dense cluster
can easily have `gold_count > 10`, in which case a "perfect" system still
reports `recall_at_10 < 1.0` — that is the metric doing its job, not a
regression. The runner reports `gold_count_distribution` (`min`/`max`/`mean`
`|gold_ids|` across scored positive-family queries) in the summary
specifically so a low `recall_at_10` can be checked against whether it's
capped by gold size before being read as a quality problem.

`precision_at_10` (hits in the top 10 requested / 10, fixed denominator)
is reported alongside recall for the same reason: it is not capped by
`gold_count`, so it stays informative exactly where `recall_at_10`
understates a genuinely good top-10 on a high-gold-count query.

## Known limitation: window-bound inclusivity

`build_queries.py`'s two positive families compute gold with different
end-bound inclusivity: `radius_window` treats a query's `window.end` as
inclusive (a record dated exactly at the window's end date is gold);
`precedence` treats it as exclusive (a record dated exactly at the
anchor's own instant is not "before" it, so it's excluded from gold).
Rather than leaving `run_eval.py`'s client-side window filter hardcoded to
one of those and silently disagreeing with the other family, every query
in `queries.jsonl` carries an explicit `window.end_inclusive` boolean, and
`evaluate_query` reads it per-query and passes it through to
`filter_by_window`. A `queries.jsonl` written before this flag existed is
still handled: `window.end_inclusive` defaults to `true` (matching the
pre-existing hardcoded behavior) when absent.

## Known limitation: GKG-row → server-id correlation

`/api/memories` has no way to ask "which memory id came from GKG record
X" — the server never stored the GKG record id, only the transformed
`content`/`geo_location`/`created_at`. `build_queries.py` correlates a
locally re-parsed GKG row to a server-assigned id by matching
`(content[:500], len(content))` against each `/api/memories` list item's
`(content, content_length)` (the list endpoint truncates its `content`
preview to 500 chars; matching on the same prefix length plus the exact
total length collapses to an exact full-content match whenever
`content_length <= 500`, and narrows the residual collision risk for
longer content to cases that are effectively true duplicates anyway,
which the server's own content-hash dedup would also have merged to one
id). Every row that fails to match, and every `(prefix, length)` key
claimed by more than one distinct server id, is counted
(`rows_unmatched`, `ambiguous_keys`) in the builder's summary rather than
silently dropped or silently mismatched.

**Correlation-loss gate:** gold sets and negative-control "verified empty"
checks are computed only over rows that successfully correlated
(`matched_rows`) — an unmatched row is invisible to both. If too large a
fraction of the corpus fails to correlate, gold under-derives (a record
that should be gold but didn't correlate silently inflates measured
recall) and a negative control's empty-radius guarantee weakens (an
out-of-radius record that failed to correlate can't be caught by the
overlap check either). `build_queries.py` refuses to build a query set at
all when `rows_unmatched / gkg_rows_usable` exceeds `MAX_UNMATCHED_FRACTION`
(5%, a module constant): it returns `{"error": ..., "correlation_unmatched_fraction": ...}`
and does not write `queries.jsonl` — a partially-correlated corpus must
not produce a headline number. The fraction is also reported
(`correlation_unmatched_fraction`) in a *successful* run's summary, so a
below-threshold-but-nonzero loss is still visible.

## `expect_empty` is the scoring source of truth, not `family`

`run_eval.py`'s `evaluate_query` branches on each query's `expect_empty`
field (not its `family` string) to decide whether it's scored as a
negative control. `family` is still required to agree
(`family == "negative"` iff `expect_empty` is true); if a `queries.jsonl`
row has them disagree, `evaluate_query` raises before making any HTTP
call, and `run()` surfaces that as a clean `{"error": ...}` rather than
silently picking one field to trust. This only fires on a hand-edited or
stale queries file — `build_queries.py` always emits them consistently —
but scoring a disagreement silently either way would hide exactly the
kind of bug this eval set exists to catch.

## Running it (requires a live server — user-gated)

Neither script can be run as part of this task: `cargo run` is forbidden
by default in this repo, and both scripts genuinely need a live server —
`build_queries.py` to read back the corpus's server-assigned ids,
`run_eval.py` to call `/api/recall`. Start the server yourself, then:

```bash
# 1. Ingest a GDELT GKG export (Task 4's script) if you haven't already.
python scripts/gdelt/ingest_gkg.py \
  --server http://localhost:9944 --user-id geo-eval \
  --input path/to/gkg-export.csv

# 2. Build the held-out query set from the SAME export file.
python eval/geotemporal/build_queries.py \
  --server http://localhost:9944 --user-id geo-eval \
  --gkg-input path/to/gkg-export.csv \
  --output eval/geotemporal/queries.jsonl

# 3. Run the eval.
python eval/geotemporal/run_eval.py \
  --server http://localhost:9944 --user-id geo-eval \
  --queries eval/geotemporal/queries.jsonl
```

`run_eval.py` exits 1 if:
- `negative_pass_rate < 1.0` (binding requirement — any wrong-region
  leakage fails the run), **or**
- `negative_pass_rate is None`, i.e. `queries.jsonl` contained **zero**
  negative-control queries — a run that performed no leakage validation
  at all is a FAILED run, not a vacuous pass, **or**
- the queries file can't be read, or a query row is malformed
  (`expect_empty`/`family` inconsistency; see above).

`build_queries.py` additionally exits 1 (before even attempting to build
a query set) if the correlation-loss gate trips — see "GKG-row →
server-id correlation" above.

`run_eval.py` always prints one JSON summary line:

```json
{
  "recall_at_10": 0.0,
  "recall_at_10_diagnostic_limit50": 0.0,
  "precision_at_10": 0.0,
  "gold_count_distribution": {"min": 2, "max": 14, "mean": 5.4},
  "negative_pass_rate": 1.0,
  "skipped_no_gold": 0,
  "per_family": {
    "radius_window": {"n": 25, "recall_at_10": 0.0, "recall_at_10_diagnostic_limit50": 0.0, "precision_at_10": 0.0},
    "precedence": {"n": 15, "recall_at_10": 0.0, "recall_at_10_diagnostic_limit50": 0.0, "precision_at_10": 0.0},
    "negative": {"n": 10, "negative_pass_rate": 1.0}
  },
  "n_queries": 50
}
```

## Baseline reference

- LongMemEval-S recall@10 (unrelated, non-geo benchmark, for scale only):
  `0.7833` — weekly-recall-trend workflow run 29226172798 (2026-07-13).
- Geotemporal recall@10 **before** Task 2 (geo composition): definitionally
  ≈0 for the injection scenario — there was no geo hard-filter or
  candidate-injection path prior to that work, so a geo+text query had no
  mechanism to preferentially surface in-radius records.
- Geotemporal recall@10 **after** Task 2/3, on a real ingested corpus: not
  yet measured — requires the user-gated live run above. Record the
  before/after numbers in the PR description once run.
