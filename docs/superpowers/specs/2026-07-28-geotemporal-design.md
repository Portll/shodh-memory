# Geospatial + Geotemporal Capability — Design

**Date:** 2026-07-28
**Status:** Approved design, pending implementation plan
**Scope:** shodh-memory engine (Rust core, MCP server, ingest)

## 1. Motivation

Analyst-grade geotemporal queries — "what happened within 25km of the Baltimore bridge in the week before the collapse?" — are currently impossible. Geospatial support exists end-to-end at the memory layer (shipped as robotics mode: `Experience.geo_location`, geohash10 index, haversine radius search, MCP `recall` geo params) but is a mutually exclusive retrieval mode that bypasses the entire semantic pipeline (`src/memory/mod.rs:2109-2128`). The knowledge graph has no coordinates, CATENA temporal-order links are extracted then dropped, and the GDELT demo discarded the V2Locations lat/lon present in its source data.

This design makes geo a composable query dimension, gives the graph coordinates and temporal-order edges, and adds sovereign (offline, deterministic) toponym linking — phased so every stage lands independent value and is gated on measured recall.

## 2. Decisions (ratified in brainstorm, 2026-07-28)

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Full capability, phased | Analyst queries + edge world-model + demo all wanted |
| Geocoding | Wikidata QID linking (bundled extract) | Coords + P131 containment + aliases in one artifact; airgap-safe |
| Geo × relevance | Hard radius filter composed into semantic pipeline; ranking inside radius stays semantic | Filter affects recall; decay affects only ordering |
| Distance decay | **CUT** — not in any phase | Ordering lever, not recall lever; house history (L5 saboteur, 19 unvalidated boosts) says evidence first. Revisit only if eval shows in-radius ordering failure |
| Success bar | GDELT geotemporal query set (held-out, gold from V2Locations+dates) | Same rigor as LongMemEval; doubles as IC demo material |
| Regression gate | LongMemEval smoke bit-neutral at every phase | "Improve the recall" must not trade existing recall |

## 3. Architecture

Four touch points; nothing new where substrate exists.

### 3.1 Retrieval composition
`geo_filter: Option<GeoFilter>` (`src/memory/types.rs:1772,2042`) becomes active in the semantic path:
- **Candidate source:** when present, geohash prefix scan (existing `search_by_location`, `src/memory/storage.rs:2328`; 9-cell neighbor scan over `geo:{geohash10}:{id}` keys) produces an id-set **unioned** into the retrieval pool. Accumulate, don't displace (multi-evidence-coverage finding).
- **Hard predicate:** haversine radius check added to `matches_filters` (`src/memory/types.rs:2244`) beside the existing `time_range` check, positioned before final ranking/truncation — never after truncation (silent-data-loss class).
- `RetrievalMode::Spatial` remains accepted for API compatibility; it routes through the composed path. Robotics-mode callers see identical-or-better results (superset pool, same predicate).
- Geotemporal = `geo_filter` + `time_range` predicate intersection. No new index key in Phase 1.

### 3.2 Graph substrate
- `RelationType::Precedes` — new variant in `src/graph_memory.rs:1654` enum; CATENA `LinkRelation::Precedes` (`src/causal_vocab.rs:246`) persists via `TypingMethod::Catena` (`graph_memory.rs:768`). Spreading weight conservative: equal to `RelatedTo`, below `Causes`. Migration check: must not collide with any persisted `Custom("precedes")` strings (Phase-0 audit item).
- `EntityNode.coords: Option<[f64; 2]>` — typed field (WGS84 lat/lon), **not** the stringly `attributes` map. Set only by gated linking (§3.4) or explicit API; never guessed. Accompanied by `wikidata_qid: Option<String>` provenance.

### 3.3 Ingest
GDELT ingest parses V2Locations: primary-location lat/lon → `Experience.geo_location`. All mentioned locations remain entity mentions (unchanged). Existing geohash index applies automatically. Pattern generalizes to any source carrying coordinates (EXIF, telemetry, MIF adapters).

### 3.4 Toponym linking (sovereign geocoding)
- **Artifact:** versioned offline Wikidata geo-extract — QID, label, aliases, P625 coords, P131 containment chain, sitelink count, fine type mapped to the 27 GLiNER geo labels via `wikidata_qid()` (`src/entity_type/mod.rs:83`). Geo-scoped (tens of MB), shipped like a model file. Same extract + same corpus → same links (determinism).
- **Linker:** extends `src/fs_matcher.rs`, not a new engine. Candidate generation = alias table blocked by fine type (a `river` mention never scores against city QIDs). FS scoring adds three comparators: name agreement (reuse Jaro-Winkler + embedding levels), popularity prior (sitelink bucket), **spatial coherence** (co-mentioned toponyms in an episode minimize pairwise distance — deterministic Paris-TX-vs-FR disambiguation).
- **Two thresholds (clerical band):** above upper → link + coords; between → candidate link with provenance, no coords; below → plain named node. Wrong coordinates are worse than none.
- **FS deepening (required by this phase):** term-frequency adjustment for name agreement (common toponyms over-trusted otherwise). Multi-rule blocking and collective ER noted as follow-on, out of scope here.
- **Materialization:** linked nodes get coords + QID; P131 chains become `LocatedIn` edges provenance-tagged KB-derived (distinct from text-attested).

## 4. Phases

### Phase 0 — Substrate conflict audit (no code)
Sonnet audit over the five integration points; findings doc reshapes Phase 1 before implementation:
1. Spatial short-circuit callers: HTTP (`src/handlers/recall.rs:391-402` **and duplicate at :3464-3516** — Phase 1 unifies, never adds a third copy), `search.rs:253-283`, MCP `index.ts:822-832,1884,1977-1979`, Zenoh `handlers.rs:174`.
2. `matches_filters` reachability in every path claiming geo support; position relative to fusion/truncation.
3. Geohash index write/update/delete symmetry (`storage.rs:1593,1857,1910`) — no stranded keys on update.
4. CATENA→graph handoff; `Custom("precedes")` collision scan over persisted stores.
5. Baseline capture: current LongMemEval smoke numbers on the working branch, pre-change.

### Phase 1 — Composition + persistence + eval
- 1a. Geo composes (§3.1). 1b. `Precedes` persists (§3.2). 1c. GDELT V2Locations → geo_location (§3.3).
- 1d. **Geotemporal eval set:** ~50 held-out queries, three families — radius+window, geo-anchored precedence ("what preceded X near Y"), negative controls (wrong region → empty). Gold derived mechanically from V2Locations+dates.
- **Gates:** geotemporal recall@10 improves over pre-Phase-1 baseline; LongMemEval smoke bit-neutral. No dependency on linking, Wikidata, or `EntityNode` changes.

### Phase 2 — Graph geo + toponym linking
- 2a. Wikidata geo-extract artifact + build script (versioned, reproducible).
- 2b. FS toponym linker incl. TF-adjustment (§3.4).
- 2c. Graph materialization (coords, QID, KB-provenance `LocatedIn`).
- **Hard block:** does not merge until data-flow-audit finding M3 (canonicalize provenance destruction) is resolved — both touch node rewrite paths.
- **Gates:** linking precision on a labeled GDELT toponym sample (target set during Phase 0 from measured ambiguity rate); geotemporal eval improves via graph-side answers; LongMemEval neutral.

### Phase 3 — Scale (conditional)
- Crossed `geodate:{geohash5}:{YYYYMMDD}:{id}` index key **only if** Phase-1 predicate intersection measures slow on full corpus. Measure first, index second.
- Workbench map/timeline surface belongs to the workbench thread, not this spec; this design guarantees its query API (radius + window + relevance in one call).

## 5. Error handling
- Geo params: existing `validate_geo_filter` / `validate_geo_location` (`src/validation.rs`) reused; all-or-none semantics for lat/lon/radius preserved (`recall.rs:394`).
- Linking: ambiguity → clerical band, never silent wrong assignment; extract-version mismatch → refuse to link, log, continue unlinked.
- Ingest: malformed V2Locations → skip coordinates, keep text (never drop the record); parse failures counted and surfaced, not swallowed (silent-data-loss rule).

## 6. Testing
- Unit: geohash predicate composition; `Precedes` round-trip (extract→persist→traverse); V2Locations parser (incl. malformed rows); linker comparators (TF-adjustment, spatial coherence) in `fs_matcher.rs` test style.
- Contract: Spatial-mode API compatibility (same request shape, superset results); write/delete index symmetry.
- Eval: geotemporal set (1d) in CI alongside LongMemEval smoke; negative controls mandatory.

## 7. Out of scope
Distance-decay ranking (cut; evidence-first revisit only), polygons/R-tree engines, sub-day temporal index granularity, live geocoding services, workbench UI implementation, multi-rule FS blocking and collective ER (follow-on to §3.4).

## 8. Risks
| Risk | Mitigation |
|---|---|
| Entity-linking wall stalls geo | Phase 1 ships with zero linking dependency |
| M3 provenance destruction adjacent to Phase 2 | Hard merge block until M3 resolved |
| Composition regresses tuned retrieval | Union-not-displace pool; bit-neutral LongMemEval gate per phase |
| Wrong coordinates in IC context | Two-threshold clerical band; no-guess rule; KB-provenance tags |
| Stale geo index keys on update | Phase-0 symmetry audit + contract test |
