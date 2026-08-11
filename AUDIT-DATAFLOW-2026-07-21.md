# Data-Flow Audit — 2026-07-21 (graph-guided, 5 parallel deep passes)

Method: code-review-graph at `e69ce0dd` (7576 nodes / 102991 edges) used to pick the five macro flows covering the system — write path (`handle_remember`, 419 nodes/44 files), read path (`recall`, 353/31), todo path (`create_todo`, 423/46 — the largest flow in the system), maintenance (`canonicalize_user_graph`/`rebuild_user_graph`/vector lifecycle), control plane (`handleCallTool`/streaming/hooks). One deep-read agent per flow, every finding verified against source with quoted lines. All findings below are NEW — deduped against AUDIT-TASKS-2026-07-21.md (T1–T44); overlaps are cited as "extends Tn".

Naming: W=write, R=read, D=todo, M=maintenance, C=control-plane.

---

## ⚠ BRANCH-CRITICAL INTERACTION

**Merging `feat/spacy-parser-autoload` activates the auto-canonicalization hazards M3/M4/M8.** The 6-hourly heavy-maintenance canonicalize (`state.rs:2159-2180`, `SHODH_CONSOLIDATE_CANON` default true) has been a de-facto no-op without the dependency parser. This branch auto-loads the parser, so the merge turns on a job that (M3) destroys episode provenance on every entity merge, (M4) writes fake Hebbian strengthen+recency signal, and (M8) holds the graph write lock across an O(n²) clustering run, stalling all recalls and ingest. Decide M3/M4/M8 posture BEFORE merging the branch (or default `SHODH_CONSOLIDATE_CANON` off until fixed).

---

## Cross-cutting classes (the audit's real output)

**Class A — Vector-index lifecycle has no single owner; both vector stores corrupt themselves.**
Todo store: every todo's vector is destroyed milliseconds after creation (D1), the update handler undoes its own re-index (D2), indices are never persisted and restart cross-wires mappings (D3). Main store: runtime "rebuild" reloads a stale snapshot and resurrects deleted vectors (M1), instant-load recovery re-ids vectors without persisting the remap → permanent cross-wire (M2), runtime rebuild races concurrent inserts (M9). And the verify/repair tools are blind to every one of these classes (M12, M13). Root shape: index add/remove is owned by handlers while destruction is owned by stores; startup-only code paths are reachable at runtime; no invariant check exists that a mapped id's vector actually belongs to that memory.

**Class B — Multiple ingestion pipelines with no authority → systematic duplication.**
`autoStreamContext` re-ingests `remember` bodies and `recall` queries over the WS pipeline, cross-pipeline so dedup can't catch it (C1). Temporal facts are stored twice per memory, more on retries, with non-deterministic ids (W1). Dedup-hits silently discard the new request's tags/type/importance and still emit "created" events (W4). Todo mirror memories are never cleaned up on todo/project delete (D9). Together with tracked T4 (stop-hook dup) this is one architecture question: which layer owns ingestion?

**Class C — Learning/plasticity signals are polluted by bookkeeping.**
Recall persists the query-specific final score into RocksDB; stale scores re-enter later rankings via hierarchy expansion (R1). Access-count/importance updates land on deep clones so cached memories' frequency signal is pinned (R2). Proactive habituation punishes memories that were never shown and durably penalizes their entities' graph salience (R4). Canonicalize routes merged edges through the Hebbian strengthen path, inflating strength and resetting recency for edges nobody touched (M4). Violates the brain-fidelity north star: ACT-R-style signals must be driven by genuine use, not by maintenance or serialization accidents.

**Class D — Maintenance jobs damage the structures they maintain.**
Merge destroys episode inverted-index provenance (M3); delete-then-add edge repoint loses edges on error, no atomicity (M6); unowned stemmed/lowercase index deletes cause dedup churn loops (M5); rebuild swallows clear_all failure (M10) and strips all entity name embeddings, permanently degrading tier-4 dedup and the contrastive adapter (M11); panic leaks the per-user consolidation lock until restart (M7).

**Class E — Silent contract violations at API boundaries.**
Hierarchy/companion/lineage expansions bypass all query filters and the limit (R5); `session_id` silently overrides mode to Temporal, dropping the graph leg (R6); MCP blocks `causal` mode the backend supports (R11); four todo alias routes 500 on every call (D5); `reorder_todo` has always been a no-op (D4); shim/server content caps disagree 100k chars vs 50k bytes (W12); MCP token budget counts output before surfaced-memory appends (C4).

---

## P1 findings

| id | Finding | Where |
|---|---|---|
| D1 | Todo semantic search dead system-wide: `add_activity` blob-rewrite fires `remove_todo_indices`, deleting the vector mapping created milliseconds earlier; repeats on every comment/complete/reorder; recurrence todos never indexed | `handlers/todos.rs:1005-1045`, `memory/todos.rs:634-641,517-546` |
| D2 | update_todo handler re-index undone by its own next line (`let _ = update_todo` after indexing), despite a comment claiming the opposite | `handlers/todos.rs:1506-1551` |
| D3 | Todo vector indices never persisted (`TodoStore::flush` has zero callers); restart reassigns vids from 0 while stale rev-mappings survive → deleting an old todo kills a new todo's vector (T2-class, separate store); startup "will rebuild on first use" message is false | `memory/todos.rs:1347-1365,305-331`, `state.rs:1689-1696,933` |
| R1 | Recall persists query-specific final score into the record (`score` serialized against its own "not stored" contract); stale scores re-enter later rankings via hierarchy expansion (`unwrap_or(0.0)` sort) | `mod.rs:5189-5198`, `storage.rs:1794-1798`, `types.rs:1716,1069`, `mod.rs:5322-5326` |
| M1 | Runtime auto-rebuild/compaction reloads the ~6h-stale `.vamana` snapshot instead of rebuilding: discards this cycle's soft-deletes (resurrects deleted vectors), re-adds post-save vectors greedily (no alpha-RNG), restores stale rebuild counter → alpha rebuild never runs | `retrieval.rs:236-246,443,478,1623-1635`, `vamana_persist.rs:376-378` |
| M2 | Instant-load recovery re-ids vectors in RAM, never persists remap; after next save the stale RocksDB ids are in-range → permanent, checksum-clean cross-wired retrieval (distinct site from T2; T2's fix doesn't cover it). Chunked memories collapse to single vector or become permanently unsearchable | `retrieval.rs:503-548` (esp. 510-518) vs `1588-1597` |
| M3 | Canonicalize-merge destroys merged mentions' episode provenance: `delete_entity` wipes `entity_episodes` rows, nothing re-indexes under canonical UUID; `entity_refs` dangle; mention counts/labels/attributes discarded. Default-on every 6h once parser loads (this branch) | `graph_memory.rs:3044-3062,3530-3557,4949` |
| W1 | Temporal facts stored twice per memory (core path + handler Task 3), random ids so re-stores never overwrite; dedup-hit retries append copy #3+ | `mod.rs:1123-1150`, `remember.rs:848-865`, `temporal_facts.rs:395` |
| W2 | Update-path index failure deletes the pre-existing memory: `store_inner` rollback (built for creates) runs on `update()` after `remove_from_indices`, converting a transient index error into total loss incl. version history (extends T20) | `storage.rs:1763-1768,1438-1450` |

## P2 findings

- **W3** MIF-imported memories never BM25-indexed (`remember_with_id` skips hybrid_search; also skips dedup/temporal facts/patterns); permanent keyword-search hole invisible to verify/repair. `mod.rs:860-903`, `mif.rs:231`.
- **W4** Content-hash dedup-hit discards new tags/type/importance/metadata, still emits MemoryCreated/SSE/success; MCP renders fields as stored. `mod.rs:917-926`, `remember.rs:692-719`.
- **W5** `process_experience_into_graph` (NER + up-to-20 embedder calls + parser) runs directly on tokio runtime threads; `batch_remember` does it inline for up to 1000 items (re-creates the #109 timeout-retry loop). `remember.rs:782,1070-1080,1253`, `todos.rs:2119`.
- **W6** `metadata`/`action_params`/`outcome_details` wholly unvalidated (to ~2MB axum default); metadata cloned into every graph episode; `validate_metadata` is dead code. `remember.rs:637-650`, `state.rs:3357`, `validation.rs:265`.
- **W7** Graph writes race under shared `graph.read()`: concurrent new-entity check-then-act mints duplicate UUIDs for one name (write-path-minted entity split); typed-edge find-or-strengthen races likewise. `state.rs:3297`, `graph_memory.rs:3223-3348,3871-3970`.
- **R2** Access/importance updates applied to deep clones; cached (working/session-tier) memories' access_count pinned at original+1; `boost_importance` effectively never fires on the semantic path; non-semantic path behaves differently. `types.rs:1101-1109`, `mod.rs:4838,6501-6510`.
- **R3** Any storage read error during result fetch (IO/corrupt, not just not-found) soft-deletes the memory's vectors + vmapping permanently; also ignores `SHODH_RECALL_READONLY`. `mod.rs:4962-4969`, `retrieval.rs:766-787`.
- **R4** proactive_context habituation increments `surfacings_without_utility` and applies entity-salience penalties for ALL threshold-passing candidates, then `.take(max_results)` — ranks 6+ ratchet down forever, and only shown items can dishabituate. `recall.rs:2310,2323-2346,2353`.
- **R5** Hierarchy/companion/lineage expansions bypass matches_filters (time/session/tags/robot/geo) and exceed `limit`. `mod.rs:5879-5904,5293-5297`, `recall.rs:756-780`.
- **R6** `session_id` force-overwrites mode to Temporal → graph leg silently off; handler comment describes a `temporal_search()` flow unreachable from `/api/recall`. `recall.rs:461-481`, `mod.rs:2687-2691`.
- **D6** No per-todo concurrency: whole-blob RMW loses concurrent comment/update; store `update_todo` = non-batched remove-indices-then-store → crash leaves todo invisible to all listings (unlisted T20-class site). `memory/todos.rs:634-641,708-790,803-859`.
- **D7** Bare-number short-id resolves to first `seq_num` match across projects (every project has a #1); destructive ops (delete cascades subtasks) can hit the wrong todo, order mutates with priorities/due dates. `memory/todos.rs:589-595,904-922`.
- **D8** `add_todo_comment` runs full remember+NER+graph synchronously on the request path (graph phase not even spawn_blocking). `handlers/todos.rs:2108-2134`.
- **M4** Canonicalize repoint routes through `add_relationship` dedup → `strengthen()` + `last_activated = now` per collapsed edge: fake Hebbian signal + dormancy anomalies every 6h. `graph_memory.rs:3057,3912-3929`.
- **M5** `delete_entity` removes stemmed/lowercase index keys unconditionally without ownership check; proper-noun add/delete asymmetry lets one delete break an unrelated entity's tier-3 resolution → duplicate-mint/re-merge churn loop. `graph_memory.rs:3364-3411 vs 3471-3483`.
- **M6** Canonicalize edge repoint is `let _ = delete` then `add` with both failures ignored; add-failure permanently destroys edge+provenance; no WriteBatch. `graph_memory.rs:3054-3057`.
- **M7** Timer maintenance path leaks per-user consolidation AtomicBool on panic (HTTP path has RAII guard, timer doesn't); user silently excluded from all maintenance + manual consolidate until restart. `state.rs:1965,2183`, vs `consolidation.rs:66-79`.
- **M8** Heavy-cycle canonicalize holds `graph.write()` across O(n²) Fellegi-Sunter clustering (block key folds most content entities into one block) → multi-minute recall/ingest stalls at 10k+ entities; `invalidate_relationship` takes write lock on the async runtime. `state.rs:2162-2180`, `fs_matcher.rs:453-465`, `graph.rs:429`.
- **M9** Runtime `rebuild_from_rocksdb` snapshots storage before taking index locks → concurrently indexed memories dropped from new index with live RocksDB mappings (ghost/cross-wire). `retrieval.rs:252-302`.
- **C1** `autoStreamContext` double-ingests: skip list (4 meta tools) misses `remember`/`recall` → remember bodies stored twice (HTTP + WS extraction), recall queries ingested as memories; cross-pipeline, dedup-proof; default ON. `index.ts:1675-1692,1708,407`. (Distinct site from T32.)
- **C2** MCP handshake never sends `session_id`; each WS reconnect orphans a server session (1h GC, 1000 cap) → flapping connection kills all streaming capture silently (buffer FIFO-evicts, C8). `index.ts:341-350,379-393`, `streaming.rs:524-527,576,734-739`.

## P3 findings (compact)

- **W8** Content-dedup races: concurrent identical stores both persist; single-valued `content_hash` key hides one twin; deleting either erases dedup for both (hash key deleted without value check). `storage.rs:1930-1934`.
- **W9** Chunk-boundary embedding inconsistency: short memories indexed content-only, long ones content+entities+context — augmentation applies only past the chunk threshold. `retrieval.rs:647-707,802-849`.
- **W10** Write behavior forks by route: agent-tagged memories skip interference/patterns/modality/stats; batch/upsert/zenoh/todo pass `None` entity embeddings → tier-4 merge off; entity identity depends on ingest endpoint. `mod.rs:1317-1435`, `remember.rs:1074`.
- **W11** One invalid `memory_type` aborts an entire batch (`?` inside loop) after per-item validation was promised. `remember.rs:955`.
- **W12** Shim allows 100k chars, server rejects >50k bytes; 50–100k (or multibyte >50KB) always passes shim, always 400s; hook captures silently lost. `index.ts:204`, `validation.rs:9,134`.
- **R7** Facts leg non-deterministic: `HashSet` iteration + `take(10/15)` → fact sets churn across restarts (breaks repeat-determinism gate). `recall.rs:904,2621`.
- **R8** FLAT+V2 flag combo produces mixed-mode fusion (leg branch order differs) → silently corrupted eval attribution. `mod.rs:4037-4054 vs 4100-4123`.
- **R9** `SHODH_LEG=graph` isolation leaks hybrid leg under RRF/V2 and pads zero-score entries under FLAT → per-leg numbers lie. `mod.rs:3669,4099-4127`.
- **R10** Post-truncation score mutations (competition demotion, quality gate) only conditionally re-sorted → demotion is a ranking no-op on the default path; non-monotonic displayed scores. `mod.rs:5102-5160,5307-5330`.
- **R11** MCP `validModes` omits `causal`; backend supports it. `index.ts:1877`, `recall.rs:52`.
- **R12** T5-class filter-after-truncation, three unlisted sites: recall todos leg, proactive todos leg, proactive quality gate. `recall.rs:838-848,2692-2703,2046-2056`.
- **D4** `reorder_todo` permanent silent no-op: `sort_order` never assigned non-zero anywhere; `UpdateTodoRequest.sort_order` declared but never applied. `memory/todos.rs:803-859`, `types.rs:3755`, `handlers/todos.rs:270`.
- **D5** Four alias routes (`/api/todos/update|complete|delete|reorder`) bind Path-extracting handlers with no path param → guaranteed 500. `router.rs:291-294`.
- **D9** delete_todo/delete_project never clean mirrored memories/graph entities; 3+ near-dup mirror memories per todo lifecycle pollute the retrieval corpus. `handlers/todos.rs:1831-1882,2580-2650`.
- **D10** delete_project(delete_todos=false) orphans todos + stale project index rows + seq counter. `memory/todos.rs:1285-1334`.
- **D11** parse_recurrence hardcodes day-1/Mon-Fri, ignoring the todo's own due date. `handlers/todos.rs:427-442`.
- **D12** Unparseable due date on update silently CLEARS the existing due date. `handlers/todos.rs:1468-1470`.
- **D13** MCP add_todo always sends `contexts: []` → server skips @context auto-extraction advertised in the tool description. `index.ts:3643,3688`, `handlers/todos.rs:946-950`.
- **D14** check_context_reminders substitutes zero-vector on embed failure → reminders silently never fire (T13-class site). `handlers/todos.rs:715-722`.
- **M10** rebuild_user_graph discards `clear_all` failure (partial clear → double-strengthen; full failure → silent no-op reporting success). `graph.rs:340-344`.
- **M11** Rebuild passes `None` entity embeddings → post-rebuild graph permanently loses tier-4 merge + adapter evidence; nothing backfills. `graph.rs:366` vs `remember.rs:741-786`.
- **M12** verify_index_integrity: ghosts cancel orphans in the count (`is_healthy` can be true with non-empty orphan list); no cross-wire/dim/chunk checks — blind to T2/M1/M2 corruption; repair can't see or fix cross-wires. `mod.rs:7362-7371,7282-7347`.
- **M13** Instant-load counts a chunked memory recovered if ANY chunk id in range; other chunks permanently unsearchable + ghost reverse-mappings. `retrieval.rs:462-468`.
- **C3** proactive_context module-global feedback state corrupts under overlapping calls (guard cleared by first finisher; `lastUserContext` overwritten pre-await) → wrong turn pairs into reinforcement. `index.ts:295-297,2821-2849`.
- **C4** Token budget counts resultText before surfaced-memories append + alert prepend; `_meta.token_status` reflects pre-append count → alerts fire late. `index.ts:4144-4178`.
- **C5** recall geo/reward filters unvalidated at both layers (remember does validate) → deep 500s instead of 400s. `index.ts:1884-1892`, `recall.rs:394-413`.
- **C6** proactive summary counts unfiltered facts while display filters conf≥0.4 → "3 facts" header above empty facts block; empty-result fast path skipped. `index.ts:2856,2937-2938,3006`.
- **C7** ReadResource `memory://` list-scans first 100 then `.find` → existing memory beyond cap = "not found"; dedicated GET-by-id route unused (sibling of T7). `index.ts:4432-4441`.
- **C8** Client streamBuffer FIFO-evicts oldest at 100 while disconnected — silent capture loss (client-side sibling of T10). `index.ts:310-311,425-430`.
- **C9** `forget` has no `id` presence guard (`DELETE /api/memory/undefined`); same raw-interpolation site as T1 — fold into the apiPath() fix. `index.ts:2382-2384`.

---

## Data-flow maps (condensed; full detail in agent transcripts)

**Write:** MCP shim (100k-char check) → `/api/remember` validate (50KB bytes) + NER/YAKE (merged into BOTH entities and tags, cap 50) → `MemorySystem::remember` under user RwLock.read in spawn_blocking: hash-dedup (early return) → importance → embed (cache) → `storage.store` (main CF put + 14 index families; rollback deletes main on index failure) → working memory → vector index (chunk decision on augmented text, index content-only embedding if unchunked) → BM25 (failure warn-only) → patterns → temporal facts (site #1) → interference → session tier → BM25 commit. Post-response detached task: entity embeddings → `process_experience_into_graph` (on runtime thread) → parent resolution → temporal facts AGAIN (site #2) → lineage. Partial-success matrix spans 8 stores; only vector-index orphans are detectable/repairable.

**Read:** MCP (limit clamp 250) → handler: session→Temporal override → spawn_blocking: NER annotate → `recall()` → `semantic_retrieve_inner`: temporal/attribute/fact prefilters → embedding (cache) → graph leg (Hybrid/Assoc/Causal only; PPR default ON; leg score = mini-fusion already containing semantic cosine — 2026-06-10 pollution confirmed live) → vector leg (k×3) → BM25+vector internal RRF → FLAT calibrated-max fusion w/ fitted symmetric gate (default ON) → multiplicative boost stack (attribute ×2.5, temporal-fact ×2.0, causal-origin pins roots ×2-above-max) → truncate to max_results (T5 site) → fetch+filter → L5 multipliers → conditional final sort → access persist (writes scores to disk = R1) → hierarchy/companion expansion (filter bypass = R5). Handler: lineage boost (absolute, fusion-mode-scale-sensitive) → lineage expansion (unfiltered) → normalize ×0.95 → todos/facts legs (nondeterministic entity pick).

**Todo:** create → project auto-create → full-scan prefix resolution → get_user_memory (constructs whole per-user memory system) → embed SYNC → todo Vamana index + mapping rows → store_todo (seq under mutex, blob + 7 index families) → add_activity → **update_todo → remove_todo_indices → vector just created is destroyed (D1)** → detached mirror-memory task (full remember + graph on runtime thread). Todos are deliberately first-class memories (mirror Experience + tags + recall/proactive todo legs) but write-side mirror soft-fails invisibly while read-side hard-fails.

**Maintenance:** 6h timer → per-user sequential: AtomicBool lock (leak-on-panic, M7) → decay/potentiation → heavy: fact decay, auto_repair_and_compact (→ stale-snapshot reload, M1/M2/M9) → edge replay boosts → apply_decay (orphan-entity deletion → M5 churn) → canonicalize under graph.write() (M3/M4/M6/M8) → flush_all (skips TodoStore, D3).

**Control plane:** every tool call → connectStream + autoStreamContext (C1 double-ingest) → health check round-trip → executeTool switch → apiCall (GET retried, mutations not) → format → count tokens (C4: before appends) → streamToolCall (T32) → surfaced memories append → token_status meta. Hook events: prompt→proactive(auto_ingest), PostToolUse Edit/Write/Bash-error→rememberEnriched, Stop→summary (T4). Triple-ingest architecture: hooks + WS auto-stream + HTTP writes, no authoritative layer.

---

## Discussion agenda

1. **Branch gate:** default `SHODH_CONSOLIDATE_CANON` off (or land M3/M4/M6/M8 fixes) before merging spacy-parser-autoload?
2. **Todo vector index:** keep per-user Vamana (then move index ops inside store_todo/update_todo as a matched pair) or replace with brute-force cosine over blob-persisted embeddings — todo counts are small; dissolves D1/D2/D3 and the mapping CF entirely.
3. **Score serialization (R1):** blank `score` in `MemoryFlat::serialize` — but hierarchy expansion currently *depends* on the stale-score accident (fresh items would sort to 0.0 and be truncated); the two must be fixed together (make expansion a separate annotated section?).
4. **Ingestion authority:** who owns capture — hooks, WS streaming, or explicit HTTP writes? C1 + T4 + T32 + W1 are all symptoms of "all three at once".
5. **Canonicalize shape:** in-place mutation vs copy-on-write merge-plan applied as one WriteBatch (preserving edge strength, episode index, mention counts) — fixes M3/M4/M6 + crash-consistency in one design.
6. **Instant-load reachability:** add `force: bool` to `rebuild_from_rocksdb` so runtime rebuild never takes the `.vamana` fast path (dissolves M1, shrinks M2 to real startups).
7. **Verify/repair scope:** grow `verify_index` into an invariant checker (id-range, spot-check vector↔memory cosine, chunk counts, BM25 doc-count arm) — currently it certifies exactly the corruptions the rebuild paths produce.
8. **Fact-id determinism (W1):** `tf-{memory_id}-{seq}` makes retries idempotent by construction; also decide the canonical store site (core vs handler).
9. **Session-scoped recall (R6):** should session_id add a filter instead of overriding mode and dropping the graph leg?
10. **Tags=entities conflation (write-path question):** `merged_entities` assigned to BOTH `entities` and `tags` (remember.rs:633-634) — intentional?
