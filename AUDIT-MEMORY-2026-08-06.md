# Memory Subsystem Audit — 2026-08-06 (INCOMPLETE — halted at user request)

**Status: PARTIAL.** Seven parallel Fable review agents were dispatched across the memory
subsystem and **all seven were stopped mid-flight** when the session hit a usage limit. None
returned a final report. This document contains only what was **verified first-hand**, plus the
scope/method needed to resume. Do not read the absence of findings in a slice as a clean bill.

Scope assumption: "the memory" = the memory subsystem of this repo — `src/memory/**`,
`src/graph_memory.rs`, `src/handlers/{remember,recall,crud,state,todos}.rs`, `src/decay.rs`,
`src/relevance.rs`, `mcp-server/index.ts`, `hooks/` — not the `~/.claude` markdown store.

Baseline: prior audit `AUDIT-TASKS-2026-07-21.md` (T1–T44) + `AUDIT-DATAFLOW-2026-07-21.md`
(W/R/D/M/C) at commit `e69ce0dd`. HEAD is `4a7ae671`, **36 commits / +6817 −170 across 31 files**
ahead — geotemporal Phase 0+1, GDELT ingest, eval harness, CI stack.

---

## 1. Verified findings (first-hand, this session)

### A1 · `cargo clippy --all-targets` does NOT compile on this branch — P1

`tests/memory_tiering_tests.rs:452-455`:

```rust
assert!(
    forgotten >= 0,
    "Forget operation should complete successfully"
);
```

`forget()` returns an unsigned count, so `forgotten >= 0` is **always true**. Clippy denies this:

```
tests\memory_tiering_tests.rs:453:9: error: this comparison involving the minimum or maximum
element for this type contains a case that is always true or always false
error: could not compile `shodh-memory` (test "memory_tiering_tests") due to 1 previous error
```

Two distinct consequences:

1. **The assertion cannot fail.** The test is named for verifying `ForgetCriteria::LowImportance`
   and its own comment concedes "actual count depends on importance calculation" — so it asserts
   nothing at all. If `forget()` silently became a no-op returning 0, this test still passes. This
   is the exact class `CLAUDE.md` forbids: *"NEVER lower thresholds, weaken assertions, skip tests,
   or relax criteria."* A test that cannot fail is worse than no test.
2. **`clippy --all-targets` is red on `docs/geotemporal-design`.** Worth weighing against the
   "CI was fake-green ~2.5 months" thread — check whether CI runs clippy with `--all-targets` or
   only over `src/`, because the latter would not catch this.

Caveat on method: my clippy invocation was piped to `tail`, so the reported exit code 0 was
`tail`'s, not clippy's. The error text above is from the captured output and is real.

### A2 · `src/memory/storage.rs.patch` is a **tracked** file in the source tree — P3

1646 bytes, dated Jan 23 2026, sitting next to `storage.rs`. It is **committed**, not stray
working-tree detritus (`git ls-files` matches it; last touched by `35ccbdcd style: format code` —
i.e. a formatting commit reached into a `.patch` file).

Its content is **already applied and since superseded**. The patch adds `STORAGE_MAGIC`,
`deserialize_memory`, and `crc32_simple`; all three exist in `storage.rs` today
(`:65`, `:698`, `:1064`) in a more evolved form — the shipped version handles SHO v1 (bincode 2.x)
vs v2 (postcard) with a migration flag, which the patch does not.

So the file is dead documentation that describes an *older* design than the shipped one. Delete it.

**Open question worth one focused check on resume:** the patch's original `deserialize_memory`
verified the CRC32 and, on mismatch, only `tracing::warn!`'d before decoding the payload anyway —
i.e. it tolerated silent corruption by design. The shipped path delegates to
`crate::serialization::unwrap_sho`. **I did not verify whether `unwrap_sho` actually checks the
CRC or what it does on mismatch.** If it warns-and-proceeds, that is a silent-data-corruption
finding on the memory read path and belongs on the T-list. Unverified — do not cite as fact.

### A3 · Reinforcement metric cannot distinguish success from failure — P1 (NEW)

`src/memory/mod.rs:7740-7761`, `record_reinforcement`. Verified first-hand:

```rust
match graph.read().record_memory_coactivation(&memory_uuids) {
    Ok(count) => { stats.associations_strengthened = count; }
    Err(e) => {
        tracing::warn!(error = %e, "Failed to record memory coactivation");
        // Fallback: count pairs
        let n = memory_ids.len();
        stats.associations_strengthened = n * (n - 1) / 2;
    }
}
} else {
    // No graph memory available — count pairs directly
    let n = memory_ids.len();
    stats.associations_strengthened = n * (n - 1) / 2;
}
```

Three paths write `associations_strengthened`, and **two of them fabricate `C(n,2)` from the input
length without touching the graph** — one when `graph_memory` is `None`, one when the real call
*errored*. So the reported figure is maximal precisely when the subsystem failed, and 0 when it
succeeded (because the shipped strengthen-only default returns 0 for fresh pairs — see A4).

Failure scenario: graph lock poisoned or RocksDB read error during `record_memory_coactivation`
on a 10-memory recall. The real path fails; `stats.associations_strengthened` is set to 45 — the
value a *perfectly wired* graph would report. The only signal is a `warn!`. Any dashboard, eval,
or consolidation report reading this field sees peak Hebbian activity at the moment the layer
broke. This inverts the metric, and it violates the brain-fidelity north star in the same way
Class C findings do: the plasticity signal is produced by bookkeeping, not by use.

### A4 · The Hebbian memory↔memory layer is inert, and 11 tests pin the no-op — P1 (corroborated)

A subagent hunt for tests-that-cannot-fail survived the shutdown and returned verified results;
its central claim is confirmed against source above.

**Mechanism.** `record_memory_coactivation` (`src/memory/mod.rs:7740-7761`) is strengthen-only by
default (`SHODH_COACT_STRENGTHEN_ONLY`, default-on since `f6b730ee`, 2026-07-10). The *mint*
branch is the only writer of the `mem_edge:{a}:{b}` pair index that the *strengthen* branch reads —
so it returns 0 for every fresh memory pair, permanently. This is the concrete mechanism behind
the long-standing "layer INERT since 07-10" thread.

**Correction to MEMORY.md:** the pin set is **11 tests, not ~14** —
`tests/hebbian_learning_tests.rs:284, 327, 397, 833, 908, 995, 1043, 1115`;
`tests/consolidation_tests.rs:951, 1039`; `tests/brutal_stress_tests.rs:607`.

These are **deliberate, documented pins**, not accidents — `tests/consolidation_tests.rs:1076-1077`
states: *"Pinned positively so a future revive of the layer will trip this test rather than
silently passing."* That is defensible engineering. The cost is that reviving the layer fails all
11, which is the real content of the pending remove-vs-revive decision.

**Three test names assert the opposite of their bodies** — `test_coactivation_during_retrieve_forms_edges`
(`:995`) asserts zero edges form; `test_co_retrieval_strengthens_association` (`:284`) asserts
nothing is strengthened; `test_repeated_co_retrieval_increases_strength` (`:327`) asserts `(0,0,0)`.
Anyone grepping test names for Hebbian coverage gets three false positives.

**Additional tautological assertions found** (same class as A1):
- `tests/adaptive_memory_tests.rs:980` — `assert!(stats.node_count >= 0)` on a `usize`; it is the
  *only* assertion in `test_graph_maintenance`, so the test checks panic-freedom and nothing else.
- `tests/adaptive_memory_tests.rs:951` — `assert!(node_count > 0 || edge_count >= 0)`; the right
  disjunct is unconditionally true, killing the left one, which is the check that would catch an
  empty graph after ingest.
- `tests/adaptive_memory_tests.rs:212, 284` — the suite's only *positive* `associations_strengthened`
  assertions (`3` and `1`) pin the `graph_memory: None` arithmetic fallback from A3, not Hebbian
  work. `create_test_system()` never calls `set_graph_memory`. They cannot detect any regression.
- `tests/hebbian_learning_tests.rs:377, 464` assert `Default::default()` back to itself — both
  fields are structurally unreachable from non-zero (`len() >= 2` gate; empty-slice early return).
- `src/recall_harness/bridge_harness.rs:863-935` — `#[ignore]`d *and* its three substantive
  assertions sit behind `SHODH_BRIDGE_GATE=strict` (default off). The default-path assertion has
  0.2 slack on a [0,1] recall metric whose baseline the comment concedes is "~0". Declared openly
  in-comment, so a known ratchet rather than a hidden one — but it is not coverage.

Explicitly cleared by that hunt (worth recording so they are not re-flagged): the
`consolidation_tests.rs` event-buffer trio was deliberately rewritten to be non-vacuous;
`cognitive_stress_test.rs`'s hebbian matches are fixture strings and timers only; the nine
`#[ignore]`s are runtime-cost exclusions with stated reasons, none suppressing a broken feature.

### A5 · `SHODH_SPREAD_FIX` silently applies to only half the queries — the eval arm measures a blend — P1 (NEW)

A second surviving subagent (diverged-duplicate-logic hunt) found this; I verified it directly.

`grep -rn "spread_fix" src/ --include=*.rs` returns **exactly two lines**: the bind at
`src/memory/graph_retrieval.rs:184` and the single use at `:241`, both inside
`spread_single_direction` — which is called only from `bidirectional_spread` (`:399`, `:408`).

The unidirectional path at `graph_retrieval.rs:1423-1428` is an **inline copy** of the spreading
formula that never reads the flag and still runs the acknowledged double-use of `effective`
(it sets the decay rate *and* is multiplied in — precisely what the fix removes).

Branch selection is `graph_retrieval.rs:1318`: `else if entity_data.len() >= BIDIRECTIONAL_MIN_ENTITIES`.
So a query resolving to **2+ focal entities** gets the fixed formula; a query resolving to
**exactly 1 focal entity** silently keeps the buggy one regardless of the env var.

**Why this is the serious one.** `src/recall_harness/runner.rs:1343` registers the eval arm
`("+spread-fix", vec![("SHODH_SPREAD_FIX", "1")])`. Single-entity queries contribute *unchanged
baseline* numbers to that arm. The measured effect of the spread fix is therefore diluted by an
unknown fraction of the query set, and the dilution is invisible in the reported number. Any
decision taken on that arm — including a decision not to ship the fix because the gain looked
small — rests on a blended measurement. This belongs in the same family as the fake-green CI
thread: the number is real, but it does not measure what its name says.

### A6 · Graph leg and semantic leg score the same memory with 2×–5× different boost weights — P1 (NEW)

Verified directly. `src/constants.rs:1190,1202,1213` define `RECENCY_BOOST_SCALE = 0.5`,
`AROUSAL_BOOST_SCALE = 0.15`, `CREDIBILITY_BOOST_SCALE = 0.2`. The semantic leg
(`mod.rs:4772-4799`) uses them. The graph leg (`graph_retrieval.rs:1739-1759`) **hardcodes**
`0.1`, `0.05`, `0.1` — a 5×, 3×, and 2× divergence.

Corroborating detail: `constants.rs:3177-3180` documents all three as having a single call site
(`memory/mod.rs`), i.e. the graph-leg copies are untracked by the project's own constant registry.
The graph-leg comments are self-inconsistent with their own code — `// Source credibility boost
(5% contribution)` sits directly above `* 0.1`.

Failure scenario: a 1-day-old memory contributes a recency term of `exp(-0.24)*0.1 ≈ 0.079` via the
graph leg but `exp(-0.24)*0.5 ≈ 0.393` via the semantic leg. `graph_retrieval.rs:1765-1766` sorts
by that sum and truncates at `GRAPH_CANDIDATE_CAP = 200`, so the same memory can survive in one leg
and be cut in the other purely from which leg surfaced it — before RRF fusion ever sees it.
Additionally, the caller-supplied `query.recency_weight` override (`mod.rs:4761`) has **no effect
at all** on the graph leg.

### A7 · Further divergences reported by that hunt — NOT independently verified

Recorded for follow-up. I confirmed A5/A6 against source; the four below I did **not**, and they
should be re-checked before being acted on:

- **`formatSurfacedMemories` duplicated in `mcp-server/index.ts:568-576` (live) vs
  `string-utils.ts:37-50` (dead but the only one under test).** The tested copy appends a bare
  `...` even to complete content, which `memory-format.ts:1-9` explicitly names as the failure
  class it exists to remove. `tests/string-utils.test.ts:~176` pins the obsolete behavior. Same
  drift vector for `getContent`/`getType` (currently byte-equivalent).
- **`SHODH_FEEDBACK_MOMENTUM_SCALE` applied to the score (`mod.rs:4745-4748,4885-4893`) but not to
  the attribution reported for it (`capture_l5_diagnostics`, `mod.rs:4994-5005`, which uses the
  raw constant).** The recall diagnostics panel surfaced via `index.ts:2133` would disagree with
  the ranking it claims to explain — exactly when someone is tuning the knob.
- **Three `split_sentences` implementations**; the fact-extraction copy (`compression.rs:1396-1417`)
  lacks the abbreviation/decimal guard that `query_parser.rs:1594-1632` and
  `segmentation.rs:233-250` have. Claimed consequence: sentences containing a decimal or a titled
  name get severed into sub-20-char fragments and dropped by the length filter at
  `compression.rs:1120`, so retrieval indexes a sentence fact-extraction never stored.
- **`cosine_similarity_inline` (`distance_inline.rs:444-457`) guards length with `debug_assert_eq!`**,
  a no-op in release, while every sibling copy returns `0.0` on mismatch. One non-test caller
  (`vamana.rs:759`). The agent explicitly flagged this as its weakest finding — no call site
  proven to pass mismatched dimensions — so it is a guard divergence, not a demonstrated bug.
  (This overlaps prior finding **T28**.)

Also worth recording: that hunt verified several *suspected* duplicates as genuinely equivalent —
fact decay (`mod.rs:10078-10095` vs `compression.rs:1483-1496`), todo RocksDB index key
construction, and tag-key lowercasing. Those need not be re-walked.

### A8 · Constant/env drift: the tuning surface is substantially fictional — P1 (NEW)

A third surviving subagent ran a grep-proven constants/env sweep. I re-verified its dead-constant
claims independently — `grep -rlw <NAME> src/ tui/src crates/ --include=*.rs | grep -v constants.rs`
returns **0 files** for every one of: `SPREADING_DECAY_RATE`, `IMPORTANCE_TYPE_OBSERVATION`,
`EDGE_HALF_LIFE_HOURS`, `EdgeWeight`, `L1_TARGET_DENSITY`, `TIER_RETRIEVAL_SUCCESS_BOOST`.

The unifying defect: **`constants.rs` carries a self-documenting usage table (`:3054-3180`) that
names call sites which do not exist.** The file is the project's tuning interface and it is lying
in at least four places. Verified instances:

- **`SPREADING_DECAY_RATE = 0.5`** (`constants.rs:966-974`) is documented with the formula
  `A(d) = A₀ × e^(-λd)` and listed at `:3120` as used by `graph_retrieval.rs`. It is read
  **nowhere**. Real decay comes from `calculate_importance_weighted_decay`
  (`graph_retrieval.rs:109-113`) yielding **λ ∈ [0.05, 0.15]**. At hop 6 that is
  `e^-0.3 ≈ 0.74` retention versus the advertised `e^-3 ≈ 0.05` — spreading reaches vastly more
  of the graph than the named constant implies, and lowering it to tighten recall does nothing.
- **`EDGE_INITIAL_STRENGTH` / `EDGE_MIN_STRENGTH` / `EDGE_HALF_LIFE_HOURS`**
  (`constants.rs:167,177,202`) are listed at `:3054-3056` as used by `EdgeWeight::default()` and
  `EdgeWeight::decay()`. **The `EdgeWeight` type does not exist in the repo** — those three comment
  lines are its only remaining trace. Edge forgetting actually runs through the LTP path
  (`LTP_DECAY_HALF_LIFE_DAYS = 14.0`), a **14-day** half-life where the constant file promises 24
  hours.
- **The entire `IMPORTANCE_TYPE_*` table** (`constants.rs:548-593`, 10 constants) is dead.
  `mod.rs:6029-6038` hardcodes the literals in a match arm that **omits `Observation`** — which
  `types.rs:114` makes the *default* experience type — so it falls to `_ => 0.05`, exactly half the
  documented `IMPORTANCE_TYPE_OBSERVATION = 0.10`. Auto-captured memories therefore clear
  `DEFAULT_IMPORTANCE_THRESHOLD`/`REPLAY_IMPORTANCE_THRESHOLD` less often than the table implies.
  A third scale exists in `streaming.rs:1133-1135` (base `0.5` with its own ladder), so streamed
  and remembered memories are not on a comparable importance scale at all.
- **Five tier constants dead** (`L1/L2/L3_TARGET_DENSITY`, `TIER_RETRIEVAL_SUCCESS_BOOST`,
  `TIER_LTP_THRESHOLD`) while their block-siblings are live — which is what makes the gap
  non-obvious. Nothing enforces per-tier density; graph density is bounded only by
  `MAX_ENTITY_DEGREE = 500`.

**`SHODH_TOPOLOGY_AWARE_DECAY` — a CI-visible variant of the fake-green pattern.** Verified:

```rust
// feature gate, graph_memory.rs:6617-6619  → "0" means OFF
.map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false)

// test gate,    graph_memory.rs:12456-12458 → "0" means SET, so SKIP
if std::env::var_os("SHODH_TOPOLOGY_AWARE_DECAY").is_some() { return; }
```

A CI job that pins `SHODH_TOPOLOGY_AWARE_DECAY=0` to assert "feature off" gets the feature off
**and** silently skips the byte-identical-pruning regression test guarding it. The test's own
comment says "No in-suite test sets it, so this is normally live" — that assumption breaks the
moment the var is set anywhere in the environment, and the skip is invisible in a green run.

**Reported but NOT independently verified** (re-check before acting):
- Rust/TS request-limit disagreement: content `50_000` (`validation.rs:9`) vs `100_000`
  (`index.ts:204`) — client cap **fails open**, so 50–100k content passes the client and 400s at
  the server; query `50_000` vs `10_000` and limit `10_000` vs `250` fail closed. Aggravated by JS
  UTF-16 `.length` vs Rust UTF-8 `.len()`, so a 40k-char CJK payload is ~120k bytes. A fourth
  private cap `MAX_LIST_LIMIT` duplicates `validation::MAX_LIMIT` (`crud.rs:52`). Overlaps **W12**.
- `SHODH_API_URL` vs `SHODH_SERVER_URL`: the `Tui` subcommand (`cli.rs:102-108`) is the only one
  reading `SHODH_SERVER_URL`; the TUI binary is also internally split — statusline honors both
  (`tui/src/main.rs:607-609`), dashboard and search honor only `SHODH_SERVER_URL` (`:739-742`,
  `:817-820`). Everything else (MCP, all hooks) reads `SHODH_API_URL` only.
- `SHODH_OFFLINE` parsed case-sensitively at three sites and case-insensitively at a fourth, all
  within model init — so `SHODH_OFFLINE=TRUE` splits the offline decision mid-path, which the
  comment at `gliner.rs:149-151` warns can poison ort's global mutex.

That sweep also verified as **consistent** (need not be re-walked): `SHODH_IPC_REQUIRED`,
`SHODH_ZENOH_ENABLED`, `SHODH_FUSION_V2`, `SHODH_COMPANION_WEIGHT`, `SHODH_ONNX_THREADS`,
`SHODH_PORT`, `SHODH_ENV`, `RECENCY_DECAY_RATE`, `SHODH_ROCKSDB_BLOCK_CACHE_MB`.

---

## 2. Toolchain / environment state

- **`code-review-graph` rebuilt at HEAD.** It was stale at `e69ce0dd` — the exact prior-audit
  baseline. Now: **7817 nodes / 105521 edges / 284 files** (was 7576 / 102991 / 275).
  Delta: +241 nodes, +2530 edges, +9 files. The MCP server is configured in `.mcp.json` but
  **failed to connect this session**; the CLI (`python -m code_review_graph`) works.
- Clippy: see A1. Other output is test/bench-only lint noise (unused imports, redundant closures,
  never-used test helpers) — not reported as findings.

---

## 3. Literature cross-read — two papers, mapped onto this codebase

Both were requested mid-session. Both are directly on-target, and both were read in full text
(WebFetch returned only PDF metadata; text was extracted locally via PyMuPDF).

### 3.1 · Reddy & Challaram, *Reliable Post-Retrieval Assembly for Agent Memory* (arXiv 2606.01435v2, COLM 2026 Lifelong Agent Workshop)

**Claim.** Retrieval success does not guarantee reliable *use* of retrieved evidence.
Factoring answer generation into `K = E(q,R)` (LLM extracts a structured candidate set, version
metadata preserved) then `ŷ = A_π(K)` (a separate stage executes an explicit policy) beats a
direct one-call pipeline by **+10.8 pp average, +21 pp at 262K** on MAB v3 FactConsolidation —
with *identical top-10 retrieved evidence in both arms*. Reaches 82%/93% single-hop
(gpt-4o-mini/gpt-4o) vs HippoRAG-v2 54%, BM25 48%, Mem0 18%, Zep 7%; GPT-4o long-context 60%.

**The load-bearing ablation, and why it matters here.** Swapping the *policy executor* from LLM to
deterministic code contributes only **+2.0 pp average and 0 pp at 262K**. So the gain is **not**
from deterministic selection — it is from *externalising semantic matching into an inspectable
intermediate representation before the decision*. Authors are explicit: "reliable systems should
separate evidence identification from explicit policy execution whenever the policy and metadata
are known."

**Honest bound (they state it themselves).** LongMemEval knowledge-update is a **null result**:
26/45 structured vs 29/45 baseline, paired exact McNemar **p = 0.45**. The benefit is scoped to
*current-value questions with explicit version markers*. It does not address partial orders,
historical queries ("what was the previous status"), aggregation, or Yes/No synthesis — those are
precisely the five baseline-only wins they inspected. Do not cite this paper as a general win.

**Bearing on shodh-memory.** This repo's entire measured surface is the *retrieval* half
(fusion, boost stack, PPR, recall@k). The assembly half is delegated implicitly to the calling
LLM via the MCP response. The paper's contribution is to name that as a distinct reliability
boundary that should be *designed and evaluated explicitly*. Two known findings are assembly-layer
defects in this exact sense, not retrieval defects:
- **R1** (recall persists the query-specific final score into the record, and stale scores re-enter
  later rankings) — the intermediate representation is not clean; it is contaminated by a prior
  decision.
- **R10** (post-truncation score mutations only conditionally re-sorted, so demotion is a no-op on
  the default path) — the policy is not actually executed.

### 3.2 · Ziming Wang, *TOKI: A Bitemporal Operator Algebra for Contradiction Resolution in LLM-Agent Persistent Memory* (arXiv 2606.06240v1, cs.DB, 4 Jun 2026)

**Claim.** Contradiction resolution *is* write-time concurrency control. The four production
heuristics — last-writer-wins `⊕t`, evidence-weighted `⊕p`, await-confirmation `⊕?`, per-rule `⊕c`
— are one isolation-indexed operator family over a dual-row bitemporal schema. Each carries an
isolation precondition (RC / SI / RC+cb / SR) and admits a named Berenson–Adya anomaly
(P4 lost update / A5B write skew / callback boundary / P3 phantom). Every write commits a
**current** row beside an **audit** row holding the losing fact plus provenance, under a
CHECK-bound `row_kind` discriminator.

**The three agent-specific anomalies** the classical alphabet cannot name — this is the useful
part for us:
- **N1 replay inconsistency** — re-adjudicating the same contradiction returns a different winner.
- **N2 belief-drift skew** — concurrent confidence revisions corrupt a (subject, predicate) partition.
- **N3 audit erasure** — the overwritten fact becomes unrecoverable.

Verdict matrix over 8 systems: **every** agent-memory baseline (mem0 v2/v3, Graphiti, Letta, Zep,
MIRIX) admits at least one. N3 is universal among the five with a documented provenance path.
Only TOKI excludes all three while keeping a judge on the write path; WorldDB excludes all three
only by removing the judge entirely.

**Honest bound.** The empirical component is weak relative to the theory: the audit-row defence
moves its natural-workload LoCoMo slice by **0.86 accuracy points**, and ablating the typed memory
layer removes **0.49** on 1,444 answerable LoCoMo questions. The paper explicitly states the
cross-system comparison "stays underpowered and claims no superiority." The contribution is the
**contract**, not a benchmark win. Cite it for vocabulary and soundness framing, not for numbers.

**Bearing on shodh-memory — this is the sharp one.** TOKI's three anomalies name three *already
known* findings in this repo precisely, which is strong evidence they are structural rather than
incidental:

| TOKI anomaly | shodh-memory finding | Site |
|---|---|---|
| **N3 audit erasure** | **M3** — canonicalize-merge destroys merged mentions' episode provenance; `delete_entity` wipes `entity_episodes`, nothing re-indexes under the canonical UUID, `entity_refs` dangle | `graph_memory.rs:3044-3062,3530-3557` |
| **N3 audit erasure** | **M6** — edge repoint is `let _ = delete` then `add`, both failures ignored, no WriteBatch; add-failure destroys edge + provenance permanently | `graph_memory.rs:3054-3057` |
| **N1 replay inconsistency** | **W1** — temporal facts stored twice per memory with *random* ids, so re-stores never overwrite and retries append copy #3+ | `mod.rs:1123-1150`, `remember.rs:848-865`, `temporal_facts.rs:395` |
| **N1 replay inconsistency** | **R7** — facts leg iterates a `HashSet` then `take(10/15)`, so fact sets churn across restarts | `recall.rs:904,2621` |
| **N2 belief-drift skew** | **W7** — graph writes race under a shared `graph.read()`; concurrent check-then-act mints duplicate UUIDs for one entity name | `state.rs:3297`, `graph_memory.rs:3223-3348` |
| **N2 belief-drift skew** | **M4** — canonicalize routes merged edges through the Hebbian `strengthen()` path, inflating strength and resetting recency for edges nobody touched | `graph_memory.rs:3057,3912-3929` |

**The actionable question this raises for the geotemporal work**, which landed since the last audit
and which no agent survived long enough to check: TOKI's core object is a fact stamped with
**both** a valid-time period *and* a system-time period. Does the shipped geotemporal schema
distinguish **valid time** (when the fact was true in the world) from **transaction/system time**
(when it was recorded)? If it collapses them onto one axis, then M3/M4/W1 are not separate bugs —
they are symptoms of a missing bitemporal dimension, and fixing them individually will not hold.
The paper cites TSM recovering **12.2 accuracy points** on LongMemEval and LoCoMo purely by
separating dialogue time from occurrence time — "an axis production memories collapse."

**This is the single highest-value unverified question in this audit.** It is a schema question,
answerable by reading `src/memory/types.rs` + `src/memory/temporal_facts.rs` + the geo diff.

---

## 4. What was NOT covered — resume here

All seven slices were dispatched with evidence requirements (`file:line` + quoted code + concrete
failure scenario) and a full dedupe list against T1–T44 / W/R/D/M/C. All were killed before
reporting. Re-dispatch as-is:

1. **Geotemporal delta** (`e69ce0dd..HEAD`) — filter-bypass interactions, new RocksDB key
   encodings + migration, PRECEDES promotion idempotence under the 6h cycle, whether geo fields
   populate on *all* write routes, back-compat deserialization, and divergence from
   `docs/superpowers/specs/2026-07-28-geotemporal-design.md`. **Add the bitemporal question from
   §3.2.** (This agent's last trace showed it examining Layer 4.46 injection in the fusion flow
   and the default fusion mode — that thread is worth picking up.)
2. **Status verification of T1–T17, W1–W2, R1, M1–M3, D1–D3 at HEAD** — FIXED / STILL OPEN /
   MOVED / REFUTED, plus current defaults for every gating `SHODH_*` env var. Nothing in this
   session re-confirmed any prior finding; **treat all of T1–T44 as still open until this runs.**
3. **Write path** — `remember.rs` → `mod.rs` → `storage.rs` → indexing → `process_experience_into_graph`.
4. **Read path** — `recall.rs` → fusion → boost stack → expansions; determinism and leg isolation.
5. **MCP + hooks surface** — including whether the MCP layer now exposes geo/temporal recall
   params and whether its validation matches `handlers/recall.rs` (extends C5).
6. **Maintenance / integrity** — canonicalize, rebuild, verify/repair blindness, backup.
   (The Hebbian-inertness half of this slice is **answered** — see A3/A4. Still open: whether
   `verify_index_integrity` can return `is_healthy: true` over live cross-wire corruption, M12's
   core claim, and the M1/M2/M9 rebuild trio.)
7. **Structural rot** — dead code with unkept promises, constant/env-default drift, panic surface,
   and diverged duplicate logic. (The tests-that-cannot-fail hunt is **done** — A1/A4.)

---

## 5. Bottom line

Six findings verified first-hand, plus four recorded-but-unverified (A7). Two are small: a test
assertion that cannot fail and simultaneously breaks `clippy --all-targets` (A1), and a committed
stale `.patch` file describing a superseded storage design (A2). Four are not:

- **A5** — `SHODH_SPREAD_FIX` reaches only the bidirectional spreading path (2+ focal entities).
  Single-entity queries silently run the old double-use formula, so the `+spread-fix` eval arm in
  `runner.rs:1343` reports a **blend of fixed and unfixed behavior** under a name that claims
  otherwise. Fix this before trusting any conclusion drawn from that arm.
- **A6** — the graph leg hardcodes recency/arousal/credibility boosts at 5×/3×/2× off the
  canonical constants the semantic leg uses, and `query.recency_weight` does not reach it at all.
  The same memory ranks differently depending on which leg surfaced it, before fusion.
- **A8** — the tuning surface is substantially fictional. `constants.rs`'s own usage table names
  call sites that do not exist; `SPREADING_DECAY_RATE`, the whole `IMPORTANCE_TYPE_*` table, the
  three `EDGE_*` constants (whose `EdgeWeight` type is gone from the repo), and five tier
  constants are all read nowhere. Real spreading decay is 3–10× weaker than advertised, and the
  default `Observation` experience type scores half its documented importance.

**A common thread across A5, A6 and A8:** the *named, documented* control surface and the *actual*
behavior have drifted apart in at least four independent places, always silently, and in three of
them the stale documentation is a comment table asserting the opposite. Anyone tuning this system
— or reading an eval arm's name — is working from a map that no longer matches the terrain. That
is a single systemic problem, not eight unrelated ones, and it is the same failure shape as the
fake-green CI thread.

- **A3** — `associations_strengthened` is fabricated as `C(n,2)` on two of its three write paths,
  including the *error* path. The metric peaks exactly when the subsystem fails and reads 0 when
  it succeeds. Anything consuming it — dashboards, consolidation reports, eval — is inverted.
- **A4** — the Hebbian memory↔memory layer's inertness now has a precise mechanism (the mint
  branch is the sole writer of the pair index the strengthen branch reads), and the pin set is
  **11 tests, not ~14**. Worth correcting in MEMORY.md. The pins are deliberate and documented;
  the genuine cost of "revive" is those 11 tests, which sharpens the pending decision.

The substantive result of this session is **§3.2**: two independent 2026 papers, read against this
codebase, converge on the same diagnosis. TOKI's N1/N2/N3 anomaly triple maps one-to-one onto six
findings the July audit had already logged as separate bugs across `graph_memory.rs`,
`temporal_facts.rs`, and `recall.rs`. That convergence reframes them as one structural gap —
most likely a collapsed valid-time/system-time axis — rather than six independent defects. If
that holds, the current fix-list attacks symptoms. **Verify the bitemporal schema question before
spending effort on M3/M4/M6/W1 individually.**

Nothing was committed, pushed, or posted. No code was modified.
