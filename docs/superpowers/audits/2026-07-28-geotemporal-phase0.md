# Geotemporal Phase-0 Substrate Audit

**Date:** 2026-07-28
**Scope:** Task 1 of `docs/superpowers/plans/2026-07-28-geotemporal-phase01.md`.
**Verified against:** `main` @ `f113ad58ea2b4accdd8156e20ceaae76f9f2456b` (checked out at the
`../shodh-geo-composition` worktree, branch `feat/geo-composition`), cross-checked against
`docs/geotemporal-design` in the primary repo (carries `feat/spacy-parser-autoload`'s full history)
for Step 4 only.

---

## Step 1: Integration sites on `main`

All five anchors from the plan's Step 1 grep list are present on `main`. None are spacy-branch-only;
Tasks 2-5 do not need a rebase decision.

| Anchor | Expected (~) | Actual (main @ f113ad58) |
| --- | --- | --- |
| `ROBOTICS MODE DELEGATION` | `src/memory/mod.rs` | `mod.rs:2104` (comment header), match block `2109-2110` |
| `Layer 0.4: Temporal pre-filter` | `src/memory/mod.rs` | `mod.rs:2191` (found-log), `mod.rs:2200` (warn-log) |
| `pub fn matches(&self, memory: &Memory)` | `src/memory/types.rs` | `types.rs:2212` |
| `ByLocation` | `src/memory/storage.rs` | `storage.rs:1997` (`SearchCriteria::ByLocation` match arm), `storage.rs:3144` (enum variant decl) |
| `"geo_lat, geo_lon, and geo_radius_meters must all be provided together"` | `src/handlers/recall.rs` | `recall.rs:401` (in `recall`), `recall.rs:3474` (in `paginated_recall` — this is the plan's confirmed duplicate) |

**Verdict: PASS.** No STOP condition triggered.

---

## Step 2: Spatial-mode / geo_filter caller census

`RetrievalMode::Spatial` construction sites (`grep -rn "RetrievalMode::Spatial" src/ mcp-server/index.ts`):

| Site | Notes |
| --- | --- |
| `src/handlers/recall.rs:53` | string→enum parse (`recall`) |
| `src/handlers/recall.rs:445` | pre-flight guard in `recall` |
| `src/handlers/search.rs:136,151` | string→enum parse + hard BLOCK in `multimodal_search` |
| `src/handlers/search.rs:239,265` | string→enum parse + pre-flight guard in `robotics_search` |
| `src/memory/mod.rs:2110` | `ROBOTICS MODE DELEGATION` dispatch (Spatial\|Mission\|ActionOutcome) inside `semantic_retrieve_inner` |
| `src/memory/retrieval.rs:1029` | `RetrievalEngine::search()` dispatcher → `spatial_search` |
| `src/python.rs:758` | string→enum parse (Python bindings) |
| `src/zenoh_transport/handlers.rs:1367,1481` | string→enum parse + test |

Per-site verdict table (COMPOSES = correctly builds `GeoFilter` and forwards it into `MemoryQuery`,
regardless of retrieval mode / BLOCKS = rejects geo/spatial combination outright / DUPLICATE =
independently re-implements identical logic already present elsewhere):

| Site | (a) constructs GeoFilter | (b) guards mode | (c) forwards to query | Verdict |
| --- | --- | --- | --- | --- |
| `recall.rs::recall` (fn at :349, geo build :391-405, guard :444-450, forward :580) | Yes | Yes (Spatial requires all 3; other modes: no rejection, geo passes through) | Yes | **COMPOSES** |
| `recall.rs::paginated_recall` (fn at :3454, geo build :3465-3478, forward :3516) | Yes (byte-identical match arm to `:391-405`, no drift) | **No** — missing the `RetrievalMode::Spatial if geo_filter.is_none()` pre-flight check that `recall` has at `:444-450` | Yes | **COMPOSES, but with a gap** — see Amendments |
| `recall.rs` :391-405 vs :3465-3478 | — | — | — | **DUPLICATE** (confirmed, logic identical, no semantic drift — see Task 3 note) |
| `search.rs::multimodal_search` (:114) | N/A (never reads geo params) | Hard-rejects `mode=="spatial"` unconditionally (`:151-157`), told to use `/api/search/robotics` | N/A | **BLOCKS** |
| `search.rs::robotics_search` (:213, geo build :253-256, guard :265-270, forward :283) | Yes | Yes | Yes | **COMPOSES** — uses **different field names** (`lat`/`lon`/`radius_meters`, not `geo_lat`/`geo_lon`/`geo_radius_meters`) — a 2nd naming surface, see Amendments |
| `zenoh_transport/handlers.rs` (`ZenohRecallRequest` :226-268, geo build :654-658, forward :689) | Yes | **No pre-flight guard at all** — `mode=="spatial"` with missing lat/lon/radius silently produces `geo_filter=None`, which later surfaces as an `anyhow!("Spatial search requires geo_filter")` Internal error out of `spatial_search` (`retrieval.rs:1277`) instead of a clean validation error | Yes | **COMPOSES, but with a gap** — 3rd naming surface (`lat`/`lon`/`radius_meters`, matches `robotics_search`'s naming, not `recall.rs`'s) |
| `mcp-server/index.ts` `recall` tool (:1855-1988) | Forwards `geo_lat/geo_lon/geo_radius_meters` as opaque optionals to `/api/recall` (:1977-1979) | **Only checks the one direction**: `mode==="spatial"` requires the triple (`:1884-1886`). Does **not** reject geo params when `mode !== "spatial"` — they pass straight through | Yes (via HTTP call to `recall.rs::recall`, the fully-guarded endpoint) | **COMPOSES** |

**Composition mechanism (why "COMPOSES" is possible today, contrary to a naive reading of "geo only
works in spatial mode"):** `Query::matches()` (`types.rs:2266-2279`) applies `geo_filter` as an
unconditional AND-predicate independent of `retrieval_mode` — it isn't gated on `Spatial`. For the
**default/production recall path** (`/api/recall`, any mode, since `query_text` is always set →
`recall_inner` (`mod.rs:1845-1848`) → `semantic_retrieve_inner` (`mod.rs:2052`)), this predicate is
applied at the pool-hydration stage via `self.retriever.matches_filters()`:
`mod.rs:4913` (working-memory tier), `mod.rs:4930` (session tier), `mod.rs:4948` (long-term/RocksDB
tier) — confirmed exact line numbers, matching the plan's architecture note verbatim. So: **if a
caller sends `geo_lat/geo_lon/geo_radius_meters` together with `mode=hybrid` (or temporal, or
similarity) today on `main`, the geo constraint already applies as a hard AND-filter over whatever the
semantic/BM25/graph legs surface.** What is **NOT** present today is *injection*: geo-relevant memories
that never enter the fused candidate pool (because they're semantically silent for the query text)
cannot be filtered-in after the fact — the predicate can only shrink the pool, never grow it. That
gap is exactly Task 2's target and the reason the plan's Step 2 test (`tests/geo_composition.rs`)
expects the two exclusion assertions to already pass pre-Task-2 and only the injection assertion to
fail. **This audit confirms that expectation is architecturally sound** — do not re-litigate it in
Task 2; the "hard filter already live" premise checks out.

Separately, `retrieval.rs`'s own per-mode methods (`similarity_search:1073`, `temporal_search:1127`
also call `matches_filters`; `causal_search:1163-1195` and `associative_search:1197-1201` do **not**)
are reachable only via `RetrievalEngine::search()` (`retrieval.rs:1019-1032`), which is used by (a) the
`ROBOTICS MODE DELEGATION` shortcut for Spatial/Mission/ActionOutcome only, and (b) `recall_inner`'s
non-semantic branch (`mod.rs:1851+`, reached only when `query.query_text` is `None` — not the shape
any HTTP/MCP caller sends). This means the `causal_search` gap (no geo filtering) is **not reachable**
from the documented HTTP/MCP surfaces today; noted for completeness, not actionable.

---

## Step 3: Geohash index symmetry check

Traced `update_indices` (the plan calls it `store_indices`; actual name is
**`update_indices`, `storage.rs:1516`** — geo write at `storage.rs:1593-1600`, key format
`geo:{geohash}:{id}`), `delete()` (`storage.rs:1820-1836`), and `update()` (`storage.rs:1763-1768`).

- `update()` (`:1763-1768`): calls `self.remove_from_indices(&memory.id)` **first**, then
  `self.store(memory)`.
- `remove_from_indices()` (`:1841-1953`): re-**fetches the currently-persisted (pre-update) memory**
  via `self.get(id)` at `:1843` — i.e., it reconstructs index keys, including the geo key
  (`:1909-1913`, using `memory.experience.geo_location` from the **old**, on-disk record, not the
  new argument), and deletes them in a batch (`:1951`).
- `store()` → `store_inner()` (`:1421`) → `update_indices()` (`:1516`) writes the **new** geo key
  from the incoming `memory` argument's (new) `geo_location` (`:1593-1600`).

Ordering is: **delete-old-geohash-key (computed from old on-disk state) → write-new-geohash-key
(computed from the new memory argument)**. This is the correct sequence — if `geo_location` changes
on update, the stale `geo:{oldhash}:{id}` key is deleted before/independently of the new key being
written, and critically the OLD hash is computed from the OLD location (not accidentally
re-deriving the same "new" hash twice, which would leak the old key).

`delete()` (`:1820-1836`) also calls `remove_from_indices` before removing the main record — same
correct behavior for hard deletes.

Caveat: `remove_from_indices` and `store_inner` are two **separate** RocksDB batch writes (not one
atomic transaction). A crash between them leaves a transient window with neither geo key present
(under-indexed, not double-indexed/stranded) — a durability gap, not a correctness/stranded-key bug,
and out of scope for the geohash symmetry question asked.

**Scope clause — this verdict covers the `update()` path specifically, not `store()` in general.**
`store()` (`:1380`) → `store_inner()` (`:1421`) never calls `remove_from_indices` — it only ever
*adds* fresh indices via `update_indices()`. If `store()` is ever called directly (bypassing
`update()`) on a memory `id` that **already exists** on disk with a *different* `geo_location` than
the incoming record, the old `geo:{oldhash}:{id}` key would be stranded (6 call sites in
`src/memory/mod.rs` call `.store()` directly: `:891, 988, 1379, 6226, 6345, 8302` — not individually
audited here for whether any re-store an existing id with a changed location). Blast radius is
bounded even if this occurs: a stranded geohash-bucket entry can only ever surface a memory *id* as a
prefetch candidate; `Query::matches()` re-reads that memory's **current** `geo_location` at hydration
time and rejects it if it no longer falls in the requested radius — so a stranded key produces at
worst a wasted lookup, never an incorrect result. Task 2's injection mechanism (Layer 0.45) inherits
this same safety property for free, since it also hydrates through `Query::matches()`.

**Verdict: SYMMETRIC for the `update()`/`delete()` paths** (the ones the plan asked about). **Not
independently verified for `store()` called directly on a pre-existing id** — bounded-risk gap noted,
not a fix-first blocker for Task 2.

---

## Step 4: `Custom("Precedes")` census

```
grep -rn 'Custom("Precedes"' src/         → src/graph_memory.rs:2865 (only hit)
git log --oneline -3 --all -- src/catena.rs → 622eb10d "feat(graph): causal spine — comprehensive OpenIE + CATENA, wired into ingest"
```

**This contradicts the plan's stated premise.** The plan (`docs/superpowers/plans/2026-07-28-geotemporal-phase01.md`,
Task 6 Step 1 preamble) asserts the mint site "exists ONLY on `feat/spacy-parser-autoload`" and that
`git log main -- src/catena.rs` would be **empty**. It is not:

- `git log main -- src/catena.rs` → **1 commit**, `622eb10d`, dated **2026-07-10** (18 days before this
  audit). Confirmed via `git branch --all --contains 622eb10d`, which lists `main` directly.
- The mint site (`graph_memory.rs:2864-2866`, inside `mint_causal_spine_edges`, fn starts `:2784`)
  is **byte-identical** on `main` (worktree `feat/geo-composition` @ f113ad58) and on
  `docs/geotemporal-design` (primary repo, carries `feat/spacy-parser-autoload`'s full history):
  `git log main..HEAD -- src/catena.rs src/graph_memory.rs` on that branch returns **empty** — zero
  commits ahead of main touch either file. `feat/spacy-parser-autoload` does not add, modify, or
  otherwise touch the Precedes mint site or the `RelationType` enum at all.
- `causal_vocab.rs:246` (`enum LinkRelation`, `Precedes` variant at `:250`) — present on main, matches
  the plan's anchor.

**Why the plan's author believed it was branch-confined:** `mint_causal_spine_edges` is gated on
`crate::dep_parser::is_available()` (`graph_memory.rs:2791`). On `main`,
`dep_parser::load_from_env()` (`src/dep_parser.rs:86-89`) resolves the parser bundle from an
explicitly-set `SHODH_SPACY_MODEL_PATH` env var — nothing in `main`'s own tracked source sets this
automatically. `feat/spacy-parser-autoload`'s commit (`e69ce0dd`, "auto-resolve the dependency parser
bundle (causal spine on by default)") adds fallback auto-discovery ahead of the explicit env var
(confirmed on `docs/geotemporal-design`, which carries that branch's full history: `dep_parser.rs`
there documents "1. `SHODH_SPACY_MODEL_PATH` — explicit override" as the first of several resolution
steps, vs. main's single-step lookup). Re-confirmed directly against the named branch, not just the
docs branch: `git log --oneline main..feat/spacy-parser-autoload -- src/catena.rs src/graph_memory.rs
src/causal_vocab.rs` on the primary repo returns **empty** — zero commits ahead of `main` on that
branch touch any of Task 6's target files.

**This does NOT mean zero edges exist — it has already been operationally confirmed otherwise.** The
private working vault (`shodh-vault/01-Daily/2026-07-11.md:18`, `shodh-vault/04-Research/Causal-Spine-3Arm.md:70`)
records, in the user's own words, dated the day after the mint site shipped:

> "spaCy `en_core_web_sm` bundle moved into the repo (`models/`, gitignored) — closes the deploy gap
> (flagged servers didn't set `SHODH_SPACY_MODEL_PATH`); **the parser stack now fires on the demo
> servers**." (2026-07-11)

This is a direct, dated, first-party record that the deploy gap was closed the day after CATENA
shipped, and that the parser stack (hence `mint_causal_spine_edges`, hence `Custom("Precedes")`
minting) **has been active on at least the demo servers since 2026-07-11** — 17 days before this
audit. Combined with MEMORY.md's 2026-07-21 note that "GLiNER v2 NOW LIVE... founder-confirmed... +
OpenIE + CATENA," the conclusion is not "plausible" but **effectively confirmed from this repo's own
operational record**: at least the demo-server stores almost certainly contain live
`Custom("Precedes")` edges today. This audit did not (and per its no-build/no-run constraint,
cannot) directly inspect a running store's `relationships` column family to give a byte-level count,
but the documentary evidence is unambiguous enough to treat "zero production edges" as **false**, not
merely unverified.

- This does **not** change Task 6's engineering approach: `.normalize()` applied at
  `decode_relationship_edge` (`graph_memory.rs:927-932`) is a **read-time, idempotent
  normalization** — correct whether zero or nonzero legacy edges exist, no destructive migration
  script needed. But see the choke-point qualification and additional call sites below — "the single
  choke point" needs a narrower definition than the plan states.
- **This removes a hard blocker from the roadmap**: Task 6 does **not** need to be stacked on
  `feat/spacy-parser-autoload` and does **not** need to wait on that branch's M3
  provenance-destruction resolution — confirmed by the direct branch diff above, not just the docs
  branch. Task 6 can branch directly off `main` today. See Amendments.

**Choke-point qualification (found while verifying the plan's "single choke point" claim for
Task 6 Step 3):** `decode_relationship_edge` (`graph_memory.rs:927-932`) is confirmed the single
funnel for **runtime reads** of a `RelationshipEdge` from RocksDB — all 9 production read call sites
in `graph_memory.rs` (`:4219, 4601, 4664, 4683, 4788, 5409, 5466, 5519, 7004`) plus 2 test sites go
through it, and `.normalize()` there will transparently fix every edge the running system actually
uses, regardless of what's on disk. However, it is **not** the only place `RelationshipEdge` bytes or
values are produced in `src/`:
- `src/migration.rs:592` (`migrate_generic_record::<RelationshipEdge>`) is a **separate, offline**
  bincode→postcard format-migration tool that round-trips edge bytes through its own generic
  decode/encode path, bypassing `decode_relationship_edge` entirely. It doesn't break Task 6's
  correctness (anything it migrates is still corrected on next runtime read), but it means the
  on-disk bytes it rewrites are not touched by `.normalize()` — worth a one-line comment in Task 6 so
  a future reader doesn't assume this tool already normalizes legacy edges.
- `src/mif/import.rs:484-522` (`parse_relation_type`) is a **third entry point**: it maps MIF
  (memory interchange format, JSON-based backup/import) relation-type strings to `RelationType`,
  falling back to `RelationType::Custom(other.to_string())` (`:521`) for anything unrecognized. It has
  no case for `"precedes"` and is not wired through `decode_relationship_edge` at all (edges are
  constructed as struct literals from parsed JSON, `:322-323`, then stored directly). Runtime
  normalize-on-read still corrects these once loaded for use, so this isn't a correctness gap, but it
  means a MIF-imported "Precedes" edge stays labeled `Custom("precedes")` in memory until re-read.
- `src/mif/export.rs:534-573` (`relation_type_to_string`) is an **exhaustive** match over every
  `RelationType` variant (no wildcard — `Custom(s)` is its own explicit arm). **Adding
  `RelationType::Precedes` to the enum will fail `cargo check` here** until a
  `RelationType::Precedes => "precedes",` arm is added. This is compiler-enforced (not a silent bug)
  but it is a file outside Task 6's stated file list (`src/graph_memory.rs` only) — see Amendments.

**Verdict: mint site is main-resident, and this repo's own operational history shows it has been
firing since 2026-07-11 — treat "zero production `Custom("Precedes")` edges" as false, not merely
unverified. De-risk Task 6 by branching directly off `main` (confirmed zero dependency on
`feat/spacy-parser-autoload`'s diff for any of its target files). Expand Task 6's file list beyond
`graph_memory.rs` per the choke-point qualification above.**

---

## Step 5: Baseline capture

Per controller instruction, no evals were re-run. Baselines pulled from GitHub Actions:

**Latest green `CI` (push-triggered) run on `main`:**
`https://github.com/varun29ankuS/shodh-memory/actions/runs/29420796706`
(run `29420796706`, "Merge #409: paginate /api/memories…", 2026-07-15, success). This workflow's
jobs (Clippy, Security Audit, Unit/Integration/Stress tests, 3-platform Build, Format, Version
Consistency, Benchmarks) do **not** carry LongMemEval smoke numbers — no recall@10/p@1 output in any
job log.

**LongMemEval smoke numbers live in a separate scheduled workflow, `weekly recall trend`.** Latest
green run on `main`:
`https://github.com/varun29ankuS/shodh-memory/actions/runs/29226172798`
(run `29226172798`, 2026-07-13, success; the two more recent scheduled runs — `29719182841` 07-20
"cancelled" and `30240254595` 07-27 — are not usable as baseline. Checked `30240254595` specifically:
it did **not** finish — annotation reads "The job has exceeded the maximum execution time of
5h30m0s" (vs. the green run's 3h09m), and its log contains no `LongMemEval-S:` output line, only the
harness's own source/echo text — i.e. it never got far enough to print a result before being killed.
Worth a flag on its own: the smoke run got slower between 07-13 and 07-20/07-27 to the point of
timing out twice in a row — orthogonal to this audit but likely worth a separate look before trusting
future scheduled runs). Extracted from job log (job `86740574891`):

```
LongMemEval-S: 100 questions (NER=neural) — recall@10 = 0.7833 — p@1 = 0.5000
  knowledge_update   n=17   recall@10 = 0.9118
  multi_hop          n=25   recall@10 = 0.5880
  single_hop         n=26   recall@10 = 0.9487
  temporal           n=32   recall@10 = 0.7333
```

Note this run used `NER=neural` (the real GLiNER/spaCy pipeline), not CI's fallback NER — per prior
audit history this is the more representative number for quality-tracking purposes, but is **not**
the exact configuration path-through as the standard `CI` workflow's own (NER-fallback) test tier.
Record both facts: the number source (`weekly recall trend`, not `CI`) and its NER mode, so Task 5's
PR description doesn't misattribute it to a different workflow.

**Geotemporal baseline:** definitionally ~0 today for the *injection* scenario specifically (see Step
2's composition-mechanism note) — composed geo+semantic retrieval via hard AND-filtering already
works for in-pool candidates; what's ~0 is recall of geo-relevant-but-semantically-silent memories,
because there is no prefetch/union mechanism yet. This is a narrower and more precise framing of
"composed geo queries impossible today" than the plan's literal wording, but it is the correct
framing for Task 5's "before" number (expected ≈0 via mode=hybrid, per the plan's own Task 5 Step 3
note) and does not change Task 5's design.

---

## Amendments required to Tasks 2-6

1. **Task 2, Step 1 (test skeleton)** — the sample test code calls
   `Query::builder().text("...").geo_filter(GeoFilter::new(...)).build()`. Neither `.text()` nor
   `.geo_filter()` exist on `QueryBuilder` (`types.rs:2382-2470`). The actual builder method for query
   text is `.query_text(...)` (`:2389`), and there is **no** `.geo_filter()` builder method — `geo_filter`
   is a `pub` field directly on `Query` (`types.rs:2042`, confirmed `pub geo_filter:
   Option<GeoFilter>`), so the test must either (a) set `query.geo_filter = Some(...)` directly after
   `.build()`, or (b) Task 2 adds a `.geo_filter(...)` builder method as a small, in-scope addition to
   `QueryBuilder` for consistency with the rest of the builder API. Recommend (b) since Task 2 already
   touches geo composition and a builder method is more idiomatic/reusable for the eventual eval
   harness (Task 5) than field-poking from external test files.

2. **Task 2 — `paginated_recall` composition gap.** `recall.rs::paginated_recall` (`:3454`) builds and
   forwards `geo_filter` identically to `recall`, but lacks `recall`'s pre-flight
   `RetrievalMode::Spatial if geo_filter.is_none()` guard (`:444-450`). A caller hitting
   `POST /api/recall/paginated` with `mode=spatial` and no geo params gets an unhandled `500 Internal
   Error` (from `spatial_search`'s `ok_or_else(|| anyhow!("Spatial search requires geo_filter"))`,
   `retrieval.rs:1277`) instead of the clean `400 InvalidInput` `recall` returns. Not a geo-composition
   correctness bug (Task 2's actual target), but Task 3 (which is already touching this exact
   duplication to extract a shared `build_geo_filter` helper) should also port the Spatial pre-flight
   guard into `paginated_recall` while it's in there, or explicitly scope it out with a comment if the
   team decides paginated_recall intentionally never supports spatial mode.

3. **Task 3 — third and fourth geo-parameter-naming surfaces not currently in scope.** The plan's Task
   3 only unifies `recall.rs`'s two `geo_lat/geo_lon/geo_radius_meters` sites and the MCP guard.
   `search.rs::robotics_search` (`:204-206`) and `zenoh_transport/handlers.rs::ZenohRecallRequest`
   (`:241-249`) independently use a **different** field-name triple (`lat`/`lon`/`radius_meters`, no
   `geo_` prefix) for the identical construct. This is out of Task 3's stated file list
   (`recall.rs`, `mcp-server/index.ts`) — flagging so it isn't silently treated as "the same
   duplication, already fixed" once Task 3 lands. No action required for Phase 0/1; note for a future
   consolidation pass.

4. **Task 3 — Zenoh transport spatial-mode guard gap.** `zenoh_transport/handlers.rs`'s recall handler
   (geo build `:654-658`, forward `:689`) has **no** pre-flight validation at all for
   `mode=="spatial"` with missing `lat/lon/radius_meters` (unlike `recall.rs` and `search.rs`, both of
   which guard it). Same failure mode as Amendment 2 (an internal error surfaces instead of a clean
   validation error), but on a third surface not mentioned in the plan's file list for any task. Not
   blocking for Tasks 2/4/5; worth a follow-up ticket.

5. **Task 6 — de-block from `feat/spacy-parser-autoload`.** Per Step 4 above,
   `progress.md`'s framing ("Task 6 worktree: NOT YET CREATED — stacks on feat/spacy-parser-autoload
   (M3-blocked for merge)") and the plan's own branching note ("**feat/precedes-promotion** ... stacked
   on `feat/spacy-parser-autoload` — cannot merge before that branch + M3 resolution") are based on an
   incorrect premise. Task 6's actual target files (`graph_memory.rs` enum/`as_str`/spreading-weight/mint
   site, `causal_vocab.rs`) are **unchanged** by `feat/spacy-parser-autoload` relative to `main`
   (confirmed empty diff on those files). **Recommend Task 6 branch directly off `main`**, independent
   of `feat/spacy-parser-autoload`'s merge timeline and M3 resolution. This removes a cross-branch
   dependency that was gating the roadmap for no structural reason — verify with the controller before
   re-planning, since it changes the two-branch-train structure the plan explicitly documents.

6. **Task 6 — correct, don't soften, the "no production stores affected" framing.** The plan's Task 6
   preamble states plainly that `Custom("Precedes")` "could only have been minted by pre-promotion
   builds of the CATENA spine (never shipped to main — phase-0 audit)". This is **factually wrong** on
   two counts, both established by this audit: (a) the mint site shipped to `main` on 2026-07-10
   (`622eb10d`), and (b) per the vault record cited above, the parser stack has been **actively firing
   on the demo servers since 2026-07-11** — i.e. live `Custom("Precedes")` edges almost certainly
   already exist in at least that store. Required change: rewrite the `normalize()` doc comment
   (`graph_memory.rs`, plan's Step 3) to state the corrected history — mint site shipped 2026-07-10,
   demo-server deploy gap closed 2026-07-11, legacy edges are expected to exist and this normalization
   is what makes them safe to read going forward — rather than asserting they never shipped. The code
   fix itself (`.normalize()` at the read choke point) needs no change; it was already the right fix
   for the wrong stated reason.

7. **Task 6 — expand the file list beyond `graph_memory.rs`.** Per the choke-point qualification
   above: (a) `src/mif/export.rs:534-573` (`relation_type_to_string`) is an exhaustive match with no
   wildcard arm — adding `RelationType::Precedes` to the enum will not compile until a
   `RelationType::Precedes => "precedes",` arm is added there (`cargo check` enforces this
   automatically, so it will be caught, just not where the plan's file list says to look). (b)
   `src/mif/import.rs:484-522` (`parse_relation_type`) has a permissive `Custom(_)` fallback (won't
   fail to compile) but should gain a `"precedes" => RelationType::Precedes,` arm for MIF
   export/import round-trip fidelity — otherwise a Precedes edge exported then re-imported downgrades
   to `Custom("precedes")` (still correct at runtime via normalize-on-read, but avoidable churn). (c)
   `src/migration.rs:592`'s offline format-migration tool bypasses `decode_relationship_edge` entirely
   — no code change required, but Task 6's PR description/comment should note it explicitly doesn't
   normalize edges migrated through that path (they self-heal on next runtime read regardless).

8. **Task 5 — baseline attribution.** When Task 5 writes "geotemporal recall@10 before Task 2 (expected
   ≈0 via mode=hybrid)" into its PR description, cite the LongMemEval reference number from
   `weekly recall trend` run `29226172798` (0.7833 overall / by-category above), not from the `CI`
   workflow — `CI` does not produce this metric at all on `main`. Also flag (informationally, not
   blocking) that the two most recent scheduled runs of that same workflow (07-20, 07-27) both failed
   to complete — the 07-27 run timed out at 5h30m against a prior 3h09m runtime — before Task 5's own
   eval runner goes into rotation next to a workflow that may itself need attention.
