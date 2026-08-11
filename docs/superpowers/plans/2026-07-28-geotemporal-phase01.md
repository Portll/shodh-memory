# Geotemporal Phase 0+1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. All executor subagents run `model: sonnet`.

**Goal:** Make geospatial constraints compose with semantic retrieval (recall-improving, union-not-displace), persist CATENA temporal-order links as first-class `Precedes` edges, wire GDELT V2Locations coordinates into ingest, and stand up a held-out geotemporal eval that gates it all.

**Architecture:** Mirror the existing Layer 0.4 temporal candidate-prefetch pattern (`src/memory/mod.rs:2156-2209`) for geo: geohash index scan seeds candidate ids, injected into the fused pool at floor score (never displacing semantic candidates); the existing `Query::matches` geo predicate (`src/memory/types.rs:2266-2279`) — already applied at pool hydration (`mod.rs:4913,4930,4948`) — provides the hard radius filter. `Custom("Precedes")` edges get promoted to a first-class enum variant. Spec: `docs/superpowers/specs/2026-07-28-geotemporal-design.md`.

**Tech Stack:** Rust (engine), Python (GDELT converter + eval harness), TypeScript (MCP server).

## Global Constraints

- MUST NOT run `cargo build` or `cargo run` — only `cargo check`, `cargo clippy`, `cargo test`. Eval runs needing a live server are explicitly user-gated steps.
- No "Co-Authored-By"/"Generated with Claude Code" in commits. PR workflow only; no direct pushes to main.
- Production grade: no TODOs, stubs, placeholders.
- Read every function before editing it — line anchors in this plan were verified on 2026-07-28 but WILL drift; re-locate by the quoted code/comments (grep the comment text), not by line number.
- Recall gates: LongMemEval smoke bit-neutral (CI); geotemporal eval must improve over baseline. Never displace semantic candidates — geo injection is additive only.
- Two branch trains: **feat/geo-composition** (Tasks 2-5, off `main`) and **feat/precedes-promotion** (Task 6, stacked on `feat/spacy-parser-autoload` — cannot merge before that branch + M3 resolution).

---

### Task 1: Phase 0 audit + baseline capture

**Files:**
- Create: `docs/superpowers/audits/2026-07-28-geotemporal-phase0.md`

**Interfaces:**
- Produces: audit doc consumed by Tasks 2-6; any FAIL verdict amends those tasks before execution.

- [ ] **Step 1: Verify integration sites exist on `main`** (Tasks 2-5 branch from main; sites were read on the spacy branch)

Run from repo root on a `main` checkout (worktree is fine):
```bash
git fetch origin && git worktree add ../shodh-main-audit origin/main
cd ../shodh-main-audit
grep -n "ROBOTICS MODE DELEGATION" src/memory/mod.rs
grep -n "Layer 0.4: Temporal pre-filter" src/memory/mod.rs
grep -n "pub fn matches(&self, memory: &Memory)" src/memory/types.rs
grep -n "ByLocation" src/memory/storage.rs
grep -n "geo_lat, geo_lon, and geo_radius_meters must all be provided" src/handlers/recall.rs
```
Expected: every grep hits. Record actual line numbers in the audit doc. If any miss on main (i.e., the code only exists on the spacy branch), STOP and flag — Tasks 2-5 rebase decision needed.

- [ ] **Step 2: Enumerate every Spatial-mode / geo_filter caller**

```bash
grep -rn "RetrievalMode::Spatial" src/ mcp-server/index.ts
grep -n "geo_lat\|geo_radius" src/handlers/recall.rs src/handlers/search.rs src/handlers/types.rs src/zenoh_transport/handlers.rs mcp-server/index.ts
```
Record each site + whether it (a) constructs GeoFilter, (b) guards mode, (c) forwards params. Confirm the duplicate construction in `recall.rs` (~:391 and ~:3464) and whether MCP `index.ts` (~:1884) rejects geo params when mode ≠ spatial. Verdict per site: COMPOSES / BLOCKS / DUPLICATE.

- [ ] **Step 3: Geohash index symmetry check**

Read `store_indices` (`src/memory/storage.rs` ~:1593 `geo:` write), the delete path (~:1857), and the update path (~:1910). Question: if a memory's `geo_location` CHANGES on update, is the old `geo:{oldhash}:{id}` key deleted before the new one is written? Trace the update path's delete-then-write ordering. Verdict: SYMMETRIC / STRANDED-KEY-BUG (if bug: file it in the audit doc; Task 2 gains a fix-first dependency).

- [ ] **Step 4: `Custom("Precedes")` census**

```bash
grep -rn "Custom(\"Precedes\"" src/
git log --oneline -3 --all -- src/catena.rs
```
Confirm the mint site (`src/graph_memory.rs` ~:2864) exists ONLY on `feat/spacy-parser-autoload` (check: `git log main -- src/catena.rs` empty vs branch). Conclusion expected: zero production stores contain `Custom("Precedes")` edges because minting never shipped to main → Task 6 needs no data migration, only a load-time normalization guard. Record the verdict.

- [ ] **Step 5: Baseline capture**

Record in the audit doc: current LongMemEval smoke numbers from the latest green CI run on main (link the run), and note that geotemporal baseline is definitionally ~0 (composed geo queries impossible today). Do NOT re-run evals locally for this step.

- [ ] **Step 6: Write audit doc + commit**

Audit doc sections: Site table (Step 1-2), Symmetry verdict (Step 3), Precedes census (Step 4), Baselines (Step 5), Amendments required to Tasks 2-6 (empty if none).
```bash
git add docs/superpowers/audits/2026-07-28-geotemporal-phase0.md
git commit -m "docs: geotemporal phase-0 substrate audit"
```

---

### Task 2: Layer 0.45 geo candidate prefetch + pool injection

**Files:**
- Modify: `src/memory/mod.rs` (semantic_retrieve_inner: prefetch block after Layer 0.4 ~:2209; injection at fusion map, anchor "boost_temporal_prefilter && !temporal_prefilter_ids.is_empty()" ~:4192)
- Modify: `src/constants.rs` (add `GEO_INJECT_FLOOR`)
- Test: `tests/geo_composition.rs` (new)

**Interfaces:**
- Consumes: `SearchCriteria::ByLocation { lat, lon, radius_meters }` (`storage.rs:3144`); `query.geo_filter: Option<GeoFilter>` (`types.rs:2042`); `self.advanced_search(criteria) -> Result<Vec<Memory>>` (same call shape as Layer 0.4 at `mod.rs:2183`).
- Produces: composed geo retrieval in ALL semantic modes (Hybrid/Similarity/etc.); `RetrievalMode::Spatial` behavior unchanged (still short-circuits — API compat; composed path is reached by simply not requesting Spatial).

- [ ] **Step 1: Write the failing integration test**

Mirror the setup pattern of an existing integration test in `tests/` (e.g., `tests/entity_resolution_bridge.rs`) for MemorySystem construction with a temp storage dir (NOT under OneDrive-watched paths — use std::env::temp_dir, per the tantivy file-watcher finding). Test body:

```rust
// tests/geo_composition.rs
// Three memories: (A) geo-tagged inside radius, semantically UNRELATED to query text;
// (B) geo-tagged outside radius, semantically related; (C) no geo, semantically related.
// Query: Hybrid mode, text matching B/C, geo_filter centered on A's location.
#[test]
fn hybrid_mode_geo_filter_composes() {
    let mut system = /* construct per existing test pattern */;
    let inside = [39.2904, -76.6122, 0.0];   // Baltimore
    let outside = [51.5074, -0.1278, 0.0];   // London
    store_with_geo(&mut system, "harbor patrol completed", Some(inside));   // A
    store_with_geo(&mut system, "bridge inspection report", Some(outside)); // B
    store_with_geo(&mut system, "bridge inspection summary", None);         // C

    let query = Query::builder()
        .text("bridge inspection")
        .retrieval_mode(RetrievalMode::Hybrid)
        .geo_filter(GeoFilter::new(39.2904, -76.6122, 25_000.0))
        .build();
    let results = system.retrieve(&query).unwrap();

    let texts: Vec<&str> = results.memories.iter().map(|m| m.experience.content.as_str()).collect();
    // Hard predicate: B (outside radius) and C (no geo) MUST be excluded.
    assert!(!texts.iter().any(|t| t.contains("report")), "outside-radius memory leaked: {texts:?}");
    assert!(!texts.iter().any(|t| t.contains("summary")), "geo-less memory leaked through geo filter: {texts:?}");
    // Recall via injection: A is semantically unrelated to the query — it can only
    // arrive via the geo prefetch union. This is the recall-improvement assertion.
    assert!(texts.iter().any(|t| t.contains("harbor patrol")), "geo prefetch did not inject in-radius memory: {texts:?}");
}
```
Adapt `store_with_geo`/builder calls to the actual public API (read `Query` builder in `types.rs` ~:2404 region and the store API used by the existing test — do not invent signatures).

- [ ] **Step 2: Run test, verify it fails on the injection assertion**

Run: `cargo test --test geo_composition -- --nocapture`
Expected: FAIL on "geo prefetch did not inject" (the two exclusion asserts should already PASS — `Query::matches` predicate is live at hydration; if they fail instead, stop and re-audit).

- [ ] **Step 3: Add constant**

```rust
// src/constants.rs — near TEMPORAL_PREFILTER_BOOST
/// Floor score for geo-prefetched candidates injected into the fused pool.
/// Injection is additive-only: ids already in the pool keep their semantic score
/// (entry().or_insert), so this can never displace or re-rank semantic candidates.
/// In-radius-but-semantically-silent memories enter at the bottom of the ranking,
/// surviving only when the hard geo predicate leaves capacity for them.
pub const GEO_INJECT_FLOOR: f32 = 0.05;
```

- [ ] **Step 4: Add Layer 0.45 prefetch block** (immediately after the Layer 0.4 block, `mod.rs` ~:2209)

```rust
// ===========================================================================
// LAYER 0.45: GEO PRE-FILTER (Geohash Candidate Prefetch)
// ===========================================================================
// Mirror of Layer 0.4 for spatial constraints: when the query carries a
// geo_filter, prefetch in-radius memory ids via the geohash index. These ids
// are UNIONED into the fused pool at GEO_INJECT_FLOOR (additive-only) —
// without this, in-radius memories that are semantically silent for the query
// text never enter the Vamana/BM25 pool and the hard geo predicate at
// hydration can only shrink results, never recover them.
let geo_prefilter_ids: HashSet<MemoryId> = if let Some(gf) = &query.geo_filter {
    match self.advanced_search(storage::SearchCriteria::ByLocation {
        lat: gf.lat,
        lon: gf.lon,
        radius_meters: gf.radius_meters,
    }) {
        Ok(memories) => {
            let ids: HashSet<_> = memories.iter().map(|m| m.id.clone()).collect();
            if !ids.is_empty() {
                tracing::info!(
                    "Layer 0.45: Geo pre-filter found {} memories within {}m of ({}, {})",
                    ids.len(), gf.radius_meters, gf.lat, gf.lon
                );
            }
            ids
        }
        Err(e) => {
            tracing::warn!("Layer 0.45: Geo pre-filter search failed: {}", e);
            HashSet::new()
        }
    }
} else {
    HashSet::new()
};
```

- [ ] **Step 5: Add injection at the fusion map** (anchor: the Layer 4.45 temporal boost block, grep `boost_temporal_prefilter && !temporal_prefilter_ids.is_empty()`; insert adjacent, operating on the same `fused` map)

```rust
// Layer 4.46: geo candidate injection (additive union — see GEO_INJECT_FLOOR docs).
// Placed with the 4.4x fused-map adjustments so injected ids flow through the
// same hydration path, where Query::matches applies the hard radius predicate.
if !geo_prefilter_ids.is_empty() {
    let mut injected = 0usize;
    for id in &geo_prefilter_ids {
        fused.entry(id.clone()).or_insert_with(|| {
            injected += 1;
            crate::constants::GEO_INJECT_FLOOR
        });
    }
    if injected > 0 {
        tracing::debug!("Layer 4.46: injected {} geo candidates at floor score", injected);
    }
}
```
Match the actual `fused` map's key/value types at the anchor site (verified `get_mut`/`*score *=` usage at ~:4192; adjust `f32` literal type if the map is f64).

- [ ] **Step 6: Run test to verify it passes**

Run: `cargo test --test geo_composition -- --nocapture`
Expected: PASS all three assertions.

- [ ] **Step 7: cargo check + clippy + full test sweep**

Run: `cargo check && cargo clippy -- -D warnings && cargo test`
Expected: clean; no existing test regresses (geo_prefilter_ids is empty for geo-less queries → zero behavior change).

- [ ] **Step 8: Commit**

```bash
git add src/memory/mod.rs src/constants.rs tests/geo_composition.rs
git commit -m "feat(geo): compose geo_filter with semantic retrieval via Layer 0.45 prefetch + additive pool injection"
```

---

### Task 3: Surface unification — dedupe recall.rs geo construction, relax MCP mode guard

**Files:**
- Modify: `src/handlers/recall.rs` (duplicate GeoFilter construction ~:391-405 and ~:3464-3516 → one helper)
- Modify: `mcp-server/index.ts` (geo param guard ~:1884; tool description ~:807-832)
- Test: existing handler tests (`cargo test recall`) + new unit test for the helper

**Interfaces:**
- Consumes: `GeoFilter::new`, `validation::validate_geo_filter` (unchanged).
- Produces: `pub(crate) fn build_geo_filter(lat: Option<f64>, lon: Option<f64>, radius: Option<f64>) -> Result<Option<GeoFilter>, AppError>` in `recall.rs`, used by both call sites; MCP `recall` accepts geo params in ANY mode.

- [ ] **Step 1: Write failing unit test for the helper** (in `recall.rs` `#[cfg(test)]` mod, matching existing handler test style)

```rust
#[test]
fn build_geo_filter_all_or_none() {
    assert!(build_geo_filter(Some(39.0), Some(-76.0), Some(1000.0)).unwrap().is_some());
    assert!(build_geo_filter(None, None, None).unwrap().is_none());
    assert!(build_geo_filter(Some(39.0), None, None).is_err());       // partial → 400
    assert!(build_geo_filter(Some(999.0), Some(-76.0), Some(1000.0)).is_err()); // invalid lat
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test build_geo_filter` → FAIL (function not defined).

- [ ] **Step 3: Extract the helper** — move the exact match block from ~:391-405 into `build_geo_filter`; replace BOTH call sites (~:391 and the duplicate at ~:3464-3516) with `let geo_filter = build_geo_filter(req.geo_lat, req.geo_lon, req.geo_radius_meters)?;`. Diff the removed duplicate against the first site first — if the ~:3464 copy has drifted semantically (different validation), STOP and record the divergence in the audit doc before choosing behavior.

- [ ] **Step 4: Relax the MCP guard** — at `index.ts` ~:1884, delete/adjust the rejection of geo params when mode ≠ spatial (audit Task 1 Step 2 recorded its exact shape); update the `recall` tool description (~:807-832) to state geo params compose with any mode and spatial mode remains index-only. Keep the all-or-none triple check.

- [ ] **Step 5: Verify** — `cargo test recall && cargo clippy -- -D warnings`; for MCP: `cd mcp-server && npx tsc --noEmit`. Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/recall.rs mcp-server/index.ts
git commit -m "refactor(geo): single geo_filter builder for both recall paths; MCP geo params compose with all modes"
```

---

### Task 4: GDELT V2Locations converter (tracked)

**Files:**
- Create: `scripts/gdelt/v2locations.py` (parser module)
- Create: `scripts/gdelt/test_v2locations.py` (pytest)

**Interfaces:**
- Produces: `parse_v2locations(field: str) -> list[GdeltLocation]` and `primary_location(field: str) -> tuple[float, float] | None` (GdeltLocation: NamedTuple `loc_type:int, name:str, country:str, adm1:str, lat:float, lon:float, feature_id:str`). Consumed by the ingest pipeline (which POSTs `geo_location: [lat, lon, 0.0]` to `/api/remember` — the API already accepts it, `mcp-server/index.ts:751`, validated `validate_geo_location`).

- [ ] **Step 1: Write failing tests**

```python
# scripts/gdelt/test_v2locations.py
from v2locations import parse_v2locations, primary_location

# GKG V2Locations: ';'-separated blocks, '#'-separated fields:
# type#fullname#countrycode#adm1code#lat#lon#featureid
SAMPLE = "1#United States#US#US#39.828175#-98.5795#US;3#Baltimore, Maryland, United States#US#USMD#39.2904#-76.6122#4347778"

def test_parse_two_blocks():
    locs = parse_v2locations(SAMPLE)
    assert len(locs) == 2
    assert locs[1].loc_type == 3 and abs(locs[1].lat - 39.2904) < 1e-6

def test_primary_prefers_most_specific():
    # type 3 (US city) and 4 (world city) outrank 1 (country); first wins within a rank
    assert primary_location(SAMPLE) == (39.2904, -76.6122)

def test_malformed_blocks_skipped_not_fatal():
    assert parse_v2locations("garbage#novalues") == []
    assert primary_location("") is None
    # partial corruption: good block still parses
    locs = parse_v2locations("bad##block;3#Baltimore#US#USMD#39.2904#-76.6122#4347778")
    assert len(locs) == 1

def test_non_numeric_coords_skipped():
    assert parse_v2locations("3#X#US#USMD#notanumber#-76.6122#id") == []
```

- [ ] **Step 2: Run** — `cd scripts/gdelt && python -m pytest test_v2locations.py -v` → FAIL (module missing).

- [ ] **Step 3: Implement**

```python
# scripts/gdelt/v2locations.py
"""GDELT GKG V2Locations parser. Deterministic; malformed blocks are skipped
and counted, never fatal (silent-data-loss rule: keep the record, drop only
the unparseable coordinate)."""
from typing import NamedTuple, Optional

class GdeltLocation(NamedTuple):
    loc_type: int; name: str; country: str; adm1: str
    lat: float; lon: float; feature_id: str

# GKG location types: 1=country, 2=US state, 3=US city, 4=world city, 5=world state
_SPECIFICITY = {3: 0, 4: 0, 2: 1, 5: 1, 1: 2}  # lower = more specific

def parse_v2locations(field: str) -> list[GdeltLocation]:
    out = []
    for block in (field or "").split(";"):
        parts = block.split("#")
        if len(parts) < 7:
            continue
        try:
            out.append(GdeltLocation(int(parts[0]), parts[1], parts[2], parts[3],
                                     float(parts[4]), float(parts[5]), parts[6]))
        except ValueError:
            continue
    return out

def primary_location(field: str) -> Optional[tuple[float, float]]:
    locs = parse_v2locations(field)
    if not locs:
        return None
    best = min(locs, key=lambda l: (_SPECIFICITY.get(l.loc_type, 3), locs.index(l)))
    return (best.lat, best.lon)
```

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit**

```bash
git add scripts/gdelt/v2locations.py scripts/gdelt/test_v2locations.py
git commit -m "feat(gdelt): deterministic V2Locations parser with primary-location selection"
```
Note: wiring into the live GDELT ingest script is a follow-up in the same PR IF the audit (Task 1) finds a tracked ingest entry point; the current ingest scripts are untracked (`demos/gdelt-bridge/` logs only) — if still untracked, add `scripts/gdelt/ingest_gkg.py` that reads a GKG CSV/TSV export and POSTs `/api/remember` with `content`, `geo_location=[lat,lon,0.0]`, and the GKG date as the ingest timestamp, mirroring the payload shape in `mcp-server/index.ts:751`.

---

### Task 5: Geotemporal eval set + runner

**Files:**
- Create: `eval/geotemporal/build_queries.py` (gold builder)
- Create: `eval/geotemporal/run_eval.py` (runner: recall@10 + negative-control pass rate)
- Create: `eval/geotemporal/README.md` (how to run; corpus prerequisites)

**Interfaces:**
- Consumes: GDELT corpus with coordinates ingested via Task 4; `/api/recall` HTTP API with `geo_lat/geo_lon/geo_radius_meters` + `time_range` params (shapes per `src/handlers/types.rs:110-118`).
- Produces: `queries.jsonl` (~50 rows: `{qid, family, text, geo:{lat,lon,radius_m}, window:{start,end}, gold_ids:[...], expect_empty:bool}`) and a runner emitting `{recall@10, negative_pass_rate, per_family}` JSON.

- [ ] **Step 1: Gold builder.** From the ingested corpus's stored records (export via `/api/memories` pagination), mechanically derive: 25 radius+window queries (pick a location cluster + date window; gold = all records whose primary location is in-radius AND date in-window — derived from the same V2Locations data, NOT from retrieval), 15 precedence queries ("what preceded X near Y": gold = in-radius records dated before X's date, window = 7 days prior), 10 negative controls (same text, center moved >2000km; `expect_empty=true`). Deterministic: seed nothing, sort by id, take first-N.
- [ ] **Step 2: Runner.** For each query: POST `/api/recall` (mode=hybrid, geo params, time_range, limit 10); score recall@10 against gold_ids; negative controls score pass iff zero results. Print JSON summary + per-family breakdown. Fail the process (exit 1) if negative_pass_rate < 1.0 — wrong-region leakage is a hard fail.
- [ ] **Step 3 (USER-GATED):** Running the eval requires a live server (`cargo run` is forbidden by default) — request the user start the server or approve the run. Record numbers in the PR description: geotemporal recall@10 before Task 2 (expected ≈0 via mode=hybrid) vs after.
- [ ] **Step 4: Commit**

```bash
git add eval/geotemporal/
git commit -m "feat(eval): held-out geotemporal query set (radius+window, precedence, negative controls) + runner"
```

---

### Task 6: Promote `Custom("Precedes")` → first-class `RelationType::Precedes` [branch: stacked on feat/spacy-parser-autoload]

**Files:**
- Modify: `src/graph_memory.rs` (enum ~:1654-1741; `as_str` ~:1746; spreading-weight table — grep the match containing `LocatedIn` weight entries; mint site ~:2849-2865)
- Test: `#[cfg(test)]` in `graph_memory.rs`, matching existing test style

**Interfaces:**
- Consumes: `LinkRelation::Precedes` (`src/causal_vocab.rs:246`), CATENA mint site (`graph_memory.rs:2864`).
- Produces: `RelationType::Precedes` variant; `RelationType::normalize()` mapping legacy `Custom("Precedes")` on read. Typed-walk/queries can now match temporal order first-class.

- [ ] **Step 1: Failing tests**

```rust
#[test]
fn precedes_is_first_class() {
    assert_eq!(RelationType::Precedes.as_str(), "Precedes");
    // legacy edges (if any store predates promotion) normalize on read
    assert_eq!(RelationType::Custom("Precedes".into()).normalize(), RelationType::Precedes);
    assert_eq!(RelationType::Custom("Other".into()).normalize(), RelationType::Custom("Other".into()));
}

#[test]
fn catena_temporal_signal_mints_first_class_precedes() {
    // drive the mint path with a Precedes LinkRelation and assert the created
    // edge's relation_type == RelationType::Precedes (NOT Custom). Reuse the
    // existing test harness around the graph_memory.rs:2849 mint site — read
    // neighboring #[cfg(test)] tests for the established edge-creation setup.
}
```

- [ ] **Step 2: Run** — `cargo test precedes` → FAIL (no variant).
- [ ] **Step 3: Implement** — add `Precedes,` to the enum in the Causal group (after `ResultsIn,` line ~:1676) with doc comment `/// Temporal order (CATENA): head event occurs before tail event. NOT causation.`; add `Self::Precedes => "Precedes",` to `as_str`; add a spreading-weight entry equal to `RelatedTo`'s value (spec: temporal order is weaker evidence than causation — find the weight match arm containing `LocatedIn`, copy `RelatedTo`'s number exactly); change mint site ~:2865 from `RelationType::Custom("Precedes".to_string())` to `RelationType::Precedes`; add:

```rust
impl RelationType {
    /// Normalize legacy string-typed relations to first-class variants.
    /// Custom("Precedes") edges could only have been minted by pre-promotion
    /// builds of the CATENA spine (never shipped to main — phase-0 audit);
    /// this guard makes reads robust regardless.
    pub fn normalize(self) -> Self {
        match self {
            Self::Custom(ref s) if s == "Precedes" => Self::Precedes,
            other => other,
        }
    }
}
```
Call `.normalize()` at edge deserialization: grep the edge-load path (where `RelationshipEdge` is deserialized from storage — audit doc records the exact site) and apply to `relation_type` there, once, at the single choke point.
- [ ] **Step 4: Run** — `cargo test precedes && cargo test && cargo clippy -- -D warnings` → PASS/clean. Check serde: if `RelationType` serializes by derive, `Precedes` round-trips as a unit variant — add a serde round-trip assertion to the first test.
- [ ] **Step 5: Commit**

```bash
git add src/graph_memory.rs
git commit -m "feat(graph): promote Precedes to first-class RelationType with legacy normalization"
```

---

## Self-review (done at write time)

- **Spec coverage:** §3.1 → Tasks 2-3; §3.2 Precedes → Task 6; §3.3 → Task 4; Phase 0 → Task 1; §4 1d eval → Task 5. `EntityNode.coords` + all §3.4 linking = Phase 2 plan (separate, M3-blocked). Spatial-mode short-circuit retained by design (API compat, spec §3.1).
- **Placeholder scan:** Step bodies carry real code; two deliberate audit-dependencies (edge-load choke point, MCP guard shape) are pinned to audit-doc outputs, not left vague.
- **Type consistency:** `GeoFilter{lat,lon,radius_meters}` matches `types.rs:1772`; `ByLocation` fields match `storage.rs:3144`; injection map ops match the verified `fused` usage at `mod.rs:4192`.
