# Audit Tasks — 2026-07-21

Source: comprehensive audit @ `e69ce0dd` (branch `feat/spacy-parser-autoload`). All items verified against source by an adversarial re-verify pass. Ordered by fix priority. `[ ]` = todo.

Legend: **P0** fix first · **P1** high · **P2** medium · **P3** ops/hygiene · **P4** low/optional.

---

## P0 — CRITICAL (data loss / security)

- [ ] **T1 · MCP `forget` path-traversal → whole-user wipe.** `mcp-server/index.ts:2384` interpolates `id` raw; `id="../users/<uid>"` normalizes to `DELETE /api/users/<uid>` (router.rs:147). Fix: add `apiPath(...segments)` helper that `encodeURIComponent`s every segment; apply at forget (2384), dismiss_reminder (3617), todos (3783/3812/3829/3845), subtasks (3956), comments (3979/4004/4027/4052), and `read_memory` memory_id (4092).
- [ ] **T2 · Vector-id rebuild permutation → silent cross-wired retrieval.** `src/memory/retrieval.rs:300-311` never persists the regrouped mapping. Fix: write the new mapping back to RocksDB inside `rebuild_from_rocksdb` (mirror `force_quality_rebuild` at 1588-1597); add a layout-generation stamp checked at instant-load; index chunk vectors, not only `experience.embeddings`.
- [ ] **T3 · Backup restore destroys live DB, no rollback/verify.** `src/backup.rs:324`, `src/handlers/consolidation.rs:586-649`. Fix: call `verify_backup` (checksum) first; restore into `storage.restore_tmp` then rename-aside (as secondary stores do at 441-491); hold a per-user exclusive restore gate that `get_user_memory` (state.rs:1242) respects.
- [ ] **T4 · Stop-hook duplicates memories every turn.** `hooks/memory-hook.ts:1541-1764`, `hooks/claude-settings.json:26-36`. Fix: move session-summary + `deleteState()` to `SessionEnd`; if `Stop` stays, keep it incremental with a persisted `lastTranscriptOffset` (no reset).

## P1 — HIGH

- [ ] **T5 · Filters applied after top-k truncation → empty/short results.** `src/memory/mod.rs:4584` then `4911-4975`. Fix: drain the fused list until `max_results` survivors pass filters (budget-capped), then truncate.
- [ ] **T6 · `read_memory` (and siblings) mask backend errors as "not found"/empty.** `index.ts:4090-4103`; same class `session_history`/`fact_narratives`/`purge_facts` (3177/3257/3311). Fix: rethrow non-404 with `isError:true`; return "not found" only on real 404; map `success:false` → `isError`.
- [ ] **T7 · Reads silently capped at 100.** `index.ts:2222/2325/4433` (context_summary prints wrong `Total`, 2269); backend default 100 (crud.rs:83). Fix: pass `limit`, page via `total`; fetch `memory://<id>` by `GET /api/memory/{id}` not list-scan.
- [ ] **T8 · Causal-origin mislabels hubs as roots, pins wrong rank-1 (default ON).** `src/graph_memory.rs:4336-4354`, `mod.rs:4489-4499`. Fix: fetch causal-typed incoming edges directly (typed pair index / relation-filtered scan) instead of untyped strength top-64.
- [ ] **T9 · Graph edge-direction fix default-OFF → PPR self-loops, backward edges invisible.** `src/memory/graph_retrieval.rs:511-532`. Fix: run the pending A/B and flip `SHODH_GRAPH_EDGE_DIR` default to true; at minimum exclude `nb==u` self-edges from PPR adjacency.
- [ ] **T10 · Streaming buffer unbounded + bypasses 50KB cap.** `src/streaming.rs:669-686`, `webhooks.rs:191-225`. Fix: byte-cap merged content, call `validate_content` per message, set `max_message_size` on upgrade.
- [ ] **T11 · Codebase-index path blocklist dead on Windows + is a read primitive.** `src/handlers/files.rs:195-344`. Fix: strip `\\?\` (dunce) before compare; switch blocklist → allowlist root (`SHODH_INDEX_ROOT`).
- [ ] **T12 · `verify_backup` ignores `shared/` SSTs → corrupt backup passes.** `src/backup.rs:651-664`. Fix: hash `shared/` + `meta/`, or use RocksDB's native `verify_backup`.
- [ ] **T13 · BM25/hybrid failure silently degrades to vector-only.** `src/memory/mod.rs:3525-3531`. Fix: `warn!` + Prometheus counter (mirror `commit_failures`).
- [ ] **T14 · Backend child-process lifecycle: shim exit kills shared server; no respawn.** `index.ts:5012-5044`, `1711-1722`. Fix: don't kill a detached backend on shim exit (refcount via pidfile); re-run `ensureServerRunning` on health-check failure.
- [ ] **T15 · Auto-spawn API-key race → loser 401s all session.** `index.ts:107-123`, `4909-5008`. Fix: persist the auto-generated key to a file next to the data dir so all shims share it; validate after spawn.
- [ ] **T16 · Hooks default to a dev key the auto-spawned server rejects → capture silently dead.** `hooks/memory-hook.ts:19` (+ session-start/stop/user-prompt `.sh:6`). Fix: share the persisted key (T15); fail loudly at SessionStart on auth failure.
- [ ] **T17 · `setup-hooks` writes unquoted path (breaks on spaces) + wrong matcher shape.** `mcp-server/scripts/setup-hooks.cjs:40-44,50/68/74`. Fix: quote the script path; use Claude Code string matchers.

## P2 — MEDIUM

- [ ] **T18 · Flat authorization — every API key is root over every user.** `src/auth.rs:169-185`. Fix: bind key→user (scoping) or explicitly document no-tenancy.
- [ ] **T19 · `DELETE /api/users/{id}` needs no confirm token** while `clear_all_memories` does. `src/handlers/users.rs:56-68`. Fix: require a confirmation token.
- [ ] **T20 · `store_inner` non-atomic across CFs despite "ATOMIC" claim.** `src/memory/storage.rs:1421-1453`. Fix: single cross-CF `WriteBatch` (default CF + index CF).
- [ ] **T21 · `import_mif` dedup `unwrap_or_default()` + no rollback → silent double-import.** `src/handlers/mif.rs:204-282`. Fix: propagate the read error; make import transactional or report partial state.
- [ ] **T22 · Unauth `POST /api/context/status` + CORS `Any`.** `router.rs:65-68`, `health.rs:236-307`, `config.rs:160-162`. Fix: bind to loopback or require token; validate/cap `session_id`. (Scope: growth is 5-min-bounded, cross-origin still needs key — lower than first flagged.)
- [ ] **T23 · List endpoints full-scan + full deserialize per page.** `src/handlers/crud.rs:294-427`. Fix: index-driven cursor iteration. (Runs in `spawn_blocking`, so CPU/RAM cost, not worker-block.)
- [ ] **T24 · `create_backup` handler runs checkpoint+SHA256 synchronously.** `consolidation.rs:414-499`, `backup.rs:689-699`. Fix: `spawn_blocking`.
- [ ] **T25 · Post-remember graph/embedding failures logged at `debug!` (invisible).** `src/handlers/remember.rs:766/770/803`. Fix: `warn!` + a failure counter.
- [ ] **T26 · Verbosity-bias quality factor active by default.** `src/memory/mod.rs:5022-5031` (gated only by `SHODH_FUSION_V2` off). Fix: decouple the verbosity drop from the V2 umbrella and default it on.
- [ ] **T27 · Vamana can return <k live results under clustered soft-deletes.** `src/vector_db/vamana.rs:786-807`. Fix: skip deleted during greedy search instead of post-filtering a padded k.
- [ ] **T28 · SIMD distance kernels: debug-only length check.** `src/vector_db/distance_inline.rs:28-29`. Fix: one dimension check at `search`/`search_ids` entry (guards a latent UB path).
- [ ] **T29 · Hook leaks secrets: tool-output snippet incl. `Read` of `.env` unredacted.** `hooks/memory-hook.ts:1284-1287`, matcher includes `Read`. Fix: redaction pass (`sk-…`/`AKIA…`/`ghp_…`) before any payload; exclude `Read` outputs.
- [ ] **T30 · Hook state file non-atomic → lost/duplicated capture under parallel tool calls.** `hooks/memory-hook.ts:157-190`. Fix: temp-file + atomic rename; merge instead of last-writer-wins.
- [ ] **T31 · Three shell hooks are dead (wrong shapes).** `user-prompt.sh:31` parses `.results[]` (API returns `memories`); `stop.sh:16` reads non-existent `CLAUDE_TRANSCRIPT_FILE`; `claude-code-ingest.sh:51` `jq '.[-2:]'` on JSONL. Fix or delete each.
- [ ] **T32 · `streamToolCall` re-ingests read-only tool results (old memory content).** `index.ts:4139-4141` (skip list lacks read_memory/context_summary). Fix: exclude all read-only/display tools. (Mode-gated: streaming only.)
- [ ] **T33 · Unbounded MCP response sizes.** `index.ts:2054` (recall full_content ×250), `4123` (read_memory). Fix: cap total bytes, emit explicit truncation marker + pagination hint.
- [ ] **T34 · Remove dead id-corrupting `auto_rebuild_if_needed` enum passthrough.** `src/vector_db/mod.rs:220-223` (zero callers, footgun). Fix: delete passthrough or make `pub(crate)` with a screaming name.

## P3 — GitHub / ops / hygiene

- [ ] **T35 · Enable Dependabot / vulnerability alerts** (currently disabled on public repo).
- [ ] **T36 · Add required-PR-review to `main` branch protection** (only `CI Summary` required today; direct push possible).
- [ ] **T37 · Triage IPC hardening issues #401 (HKDF subkey — probe MAC is a chosen-challenge oracle), #402 (anti-replay), #403 (default)** — live weaknesses in merged code, untriaged since 2026-07-15.
- [ ] **T38 · Fix the weekly recall-trend workflow before next Sunday** (broke 2026-07-20, 5h30m cancelled, unparseable output to #367).
- [ ] **T39 · Cut a release (v0.2.1 / v0.3.0)** — newest software release v0.2.0 is ~3.5 months / ~80 commits stale; users waiting on shipped fixes.
- [ ] **T40 · Delete 11 merged-but-undeleted branches** from the 07-14/15 merge train.
- [ ] **T41 · Verify #392 (BIO subword) fixed by entity-hygiene train → close; resolve #318 hold/rebase and stale #231.**

## P4 — LOW / optional

- [ ] **T42 · Remove dead `spreading_activation_retrieve` wrapper** (graph_retrieval.rs:1010, zero `src/` callers).
- [ ] **T43 · Sanitize/length-prefix RocksDB composite index key components** (`:` collisions can drop rows). `src/memory/storage.rs:1904/1917/1938`.
- [ ] **T44 · Decide fate of stale Feb/Mar branches tied to memory-leak #90** before deleting (possible salvage).

---

### Dropped after verification (do NOT track)
- ~~Committed `nul` file~~ — refuted, no such tracked file.
- ~~`storage.rs:2029` plaintext-downgrade blocker~~ — not in tree; lives only in unmerged PR #318.
- ~~`streaming.rs:774` WebSocket deadlock~~ — already fixed.
- "Raw transcript stored by hook" — overstated; only scored assistant text blocks (the `.env` tool-output leak, T29, is the real part).
