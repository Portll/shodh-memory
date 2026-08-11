# Graph construction audit

Branch `fix/reinforce-tracked-unification`. Every claim below is grounded in a
`file:line` on this branch. Constants are resolved to their numeric values.

**Evidence rules used.** Doc comments in this codebase are frequently stale, so
nothing here rests on one. Where a comment and its code disagree, the
contradiction is reported as a finding. Historical measurements (edge-cull
percentages, extraction-quality conclusions, category censuses) are **not**
re-derivable from source and are therefore **not** cited — where a number would
have been useful and cannot be re-derived, that is stated instead.

---

## 1. The pipeline as it is

### 1.0 Where construction actually lives

Graph *policy* is not in `graph_memory.rs`. That file owns storage, dedup,
Hebbian mechanics, decay and pruning. The decisions about **which pairs become
edges** live in `AppState::process_experience_into_graph`
(`src/handlers/state.rs:2589`–`3925`) and `MemorySystem::upsert`
(`src/memory/mod.rs:8437`–`8619`). An audit confined to `graph_memory.rs` misses
the PMI gate, the hub cap, the fragment mask and the whole typing chain.

Ingest is fire-and-forget: `remember` spawns it at
`src/handlers/remember.rs:782`.

### 1.1 Text → NER

`src/handlers/remember.rs:412` fetches the process-wide `NeuralNer`, built once
at `src/handlers/state.rs:733`. NER and YAKE run in parallel
(`remember.rs:417-442`); NER failure degrades to an empty vector
(`remember.rs:433-437`), never fatal.

**GLiNER bi-edge v2 is the live typer** — `src/embeddings/ner.rs:312-336`
dispatches on `use_fallback` (set at `ner.rs:270` from `gliner.is_available()`)
into `GlinerTyper::extract` (`src/embeddings/gliner.rs:311`). It emits **141
fine labels** and **18 coarse** from `src/entity_type/entity-type-schema.json`,
rolled to a 4-class view (`PER`/`ORG`/`LOC`/`MISC`) on `Experience.ner_entities`
(`ner.rs:38-69`), with the precise class preserved on `fine_label`.

Live thresholds: GLiNER sigmoid **0.3** (`gliner.rs:440`, `:460`);
`NER_ENTITY_MIN_LENGTH` **3** (`constants.rs:3300`, applied `state.rs:2673`);
`NER_GRAPH_CONFIDENCE_FLOOR` **0.6** (`constants.rs:3308`, applied
`state.rs:2681`); `MAX_ENTITIES_PER_MEMORY` **50** (`validation.rs:15`), then a
hard cap of **10** per memory at `state.rs:3203` (`config.rs:347`).

A 14-gate filter runs at `state.rs:2668-2862` (blocklist, pure-numeric,
punctuation-only, `tool:`/`source:`/`file:` prefixes, a ~65-entry `VERB_NOISE`
list at `:2749-2819`, path fragments, sentence fragments, ≤2-char non-acronyms).
A graph-reputation filter follows at `:2881-2899` (hard-reject degree > **200**
with selectivity < **0.1**; soft penalty below selectivity **0.15**).

**Model-missing behaviour contradicts its own header.** `ner.rs:10-12` says
absent assets fall back to the rule-based extractor. The code first attempts a
**network download** (`ner.rs:249-260`) unless `SHODH_OFFLINE` is set, and only
degrades if that also fails (`ner.rs:261-265`).

The fallback extractor (`ner.rs:423-479`) maps everything outside
Person/Org/Team/Location/Environment to `Misc`, sets `fine_label: None`, and
emits a **zero-width span `(0,0)`** for surfaces it cannot locate in the source
text (`ner.rs:461`).

### 1.2 Entity records → canonicalization

**Two resolvers exist; one is dead.** `src/entity_resolution.rs`'s `cluster()`
(`:304`) and `resolve()` (`:433`) have **zero production callers** — only
`tests/entity_resolution_bridge.rs:80`. Its header (`:1-26`) presents its
head-block union-find as *the* resolver; it does not run. Only
`parse_mention_tokens()` (`:181`) is live, used at `graph_memory.rs:2982`.

The live resolver is **`fs_matcher::cluster`**, a Fellegi-Sunter model, entered
from `GraphMemory::canonicalize_entities` (`graph_memory.rs:2956-3138`) at
`:3027` with match probability **0.9** and **20** EM iterations. Blocking at
`fs_matcher.rs:411-416` folds `Gpe|Facility → Location`. Comparison levels:
Jaro-Winkler `[0.92, 0.75, 0.5]`, name-embedding cosine `[0.85, 0.70, 0.55]`
(`fs_matcher.rs:63-67`).

It runs on the **~6-hourly heavy maintenance cycle** (`state.rs:2162`;
`is_heavy = cycle % 6` at `state.rs:1936`, interval 3600 s at `config.rs:342`)
and on demand at `POST /api/graph/{user_id}/canonicalize`
(`handlers/graph.rs:295`). **It does not run on the per-request remember path.**

Ingest-side, `add_entity` (`graph_memory.rs:3282-3483`) does a 4-tier dedup:
alias table → exact name → lowercase → Porter stem (skipped for proper nouns) →
embedding cosine ≥ **0.85** (`ENTITY_CONCEPT_MERGE_THRESHOLD`,
`constants.rs:221`) over a **10,000**-entry cache (`constants.rs:231`).

### 1.3 Entity linking

*Superseded — this section described the pre-vendored-asset state, in which KB
linking was inert. It now reads:*

**Identity stamping is always on; merging is still gated.** A Wikidata slice is
vendored in-repo (`src/kb/wikidata-slice.tsv`, 14.2k organisations and
software/products at ≥12 Wikipedia sitelinks, 1.06 MB, CC0), so `src/kb/mod.rs` resolves
surfaces with no configuration, no network and no model. `add_entity` stamps
`EntityNode.kb_id` with the QID on every write, at no extra I/O, and the field
is write-once: an established identity is never overwritten by a later mention.

Linking abstains by default. A surface links only if its label maps to a KB type
(`Organization`, `Product`, `Technology` — `Person` and the internal-ish labels
are deliberately excluded), and only if exactly one type-compatible candidate
exists or the leading one outranks the runner-up 5× in sitelinks. `ACM` and
`WTO` therefore resolve to nothing rather than to the wrong organisation.

`kb_link_entities` (`SHODH_KB_LINKING=1`, still default off) is the separate,
riskier half: it seeds surface→canonical aliases and so changes graph structure
and retrieval. It is opt-in until measured against the recall gate.

With the gate off, world-knowledge *merges* (`Google` → `Alphabet Inc.`) still
do not happen — but the identity needed to perform them is now recorded on the
nodes, which it previously was not.

### 1.4 Node creation

Nine construction sites (`state.rs:2949`, `:3000`, `:3073`, `:3106`, `:3154`;
`graph_memory.rs:2777`; `memory/mod.rs:8125`, `:8515`; `handlers/mif.rs:379`).
All set `mention_count: 1` and `selectivity: None` — **selectivity is never set
at birth**; `get_entity_reputation` (`graph_memory.rs:3824`) defaults it to
`1.0`.

On a dedup hit (`graph_memory.rs:3336-3386`): first-seen name wins; labels are
**union-merged with the incoming label first** (`:3348-3353`); `fine_type` is
preserved when the incoming is `None`; salience is recomputed as
`existing.salience * (1 + 0.1*ln(mention_count))` capped at 1.0 (`:3384-3385`).

> **Contradiction.** The comment at `:3382-3383` describes a single-application
> formula "capping at about 1.3x at 20 mentions". The code compounds off
> `existing.salience`, making salience a geometric series that climbs to the 1.0
> cap.

### 1.5 Edge creation

Eight production paths. Ranked by volume:

| Path | Site | Gated by PMI? |
|---|---|---|
| **A** co-occurrence pair loop (dominant) | `state.rs:3528-3791` | **yes** |
| **B** semantic typing pre-pass (types only, no edges) | `state.rs:3225-3290` | n/a |
| **C** causal spine (OpenIE + CATENA) | `graph_memory.rs:2848-2946` | no |
| **D** second co-occurrence loop in `upsert` | `memory/mod.rs:8558-8617` | **no** |
| **E** fact consolidation | `memory/mod.rs:8195-8230` | no |
| **F** lineage bridge | `graph_memory.rs:6050-6135` | no |
| **G** manual API | `handlers/mif.rs:476` | no |
| **H** co-retrieval mint | `graph_memory.rs:5745` | dead (§2.5) |

Path A is a full `i × j>i` loop with **no pair budget** — up to **C(10,2) = 45
candidate pairs per memory**. Birth strength is `L1_INITIAL_WEIGHT` **0.4**,
modulated by reward and by `experience_type.edge_weight_multiplier()` (0.25–1.0,
`constants.rs:1530-1543`).

**Typing precedence as implemented** (`state.rs:3643-3726`):
fragment mask → **cue extractor** → **semantic typer** → learned pairs (off) →
static label-pair table → `CoOccurs`.

> **Contradiction.** `relation_typer.rs:9-10` claims the chain is
> "semantic → cue extractor → label-pair table". The code runs **cue before
> semantic** (`state.rs:3648` vs `:3674`), and `state.rs:3614-3626` documents the
> deliberate reversal. The header is stale.

### 1.6 The PMI edge gate

Real and **on by default** — `state.rs:3737-3748`:

```rust
let is_generic_prunable = !(fragment_of_comention[i] || fragment_of_comention[j])
    && matches!(relation_type, RelationType::CoOccurs | RelationType::RelatedTo);
if is_generic_prunable && (typed_only || (pmi_gate && birth_pmi < pmi_gate_min)) { continue; }
```

`birth_pmi = log2(total_episodes / (df_i * df_j))` (`state.rs:3534-3539`), where
`df` is entity `mention_count`. `SHODH_GRAPH_PMI_GATE` defaults **on**
(`:3444-3446`); `SHODH_GRAPH_PMI_GATE_MIN` defaults **0.0** (`:3449-3452`). So
the gate fires iff **`df_i · df_j > N`**.

It filters **Path A only**, and within Path A only untyped, non-fragment pairs.
Paths C–G bypass it entirely.

> **Contradiction.** `state.rs:3441` says gating "applies at edge BIRTH". The
> `continue` at `:3747` precedes `add_relationship` at `:3787`, which is where
> dedup/strengthen lives — so the gate also **suppresses re-attestation of
> already-existing generic edges** once `df_i·df_j > N`. Frequently-mentioned
> pairs silently stop being reinforced. (The comment's second half — "existing
> dense graphs don't shrink retroactively" — is correct.)
>
> Second-order: `add_entity` increments `mention_count` at `state.rs:3328`
> *before* the pair loop reads it at `:3531`, so an entity's current mention
> inflates its own `df` in its own gate decision.

**Historical cull percentages are not re-derivable from source** and are not
quoted here.

### 1.7 Weights, tiers and decay

Resolved constants: `L1_INITIAL_WEIGHT` **0.4**, `L1_PROMOTION_THRESHOLD`
**0.5**, `L2_PROMOTION_WEIGHT` **0.5**, `L2_PROMOTION_THRESHOLD` **0.7**,
`L3_PROMOTION_WEIGHT` **0.7**; prune thresholds **0.1 / 0.2 / 0.3**;
`LTP_LEARNING_RATE` **0.1**; `TIER_CO_ACCESS_BOOST` **0.15**;
`STRENGTHEN_IMPORTANCE_FLOOR` **0.2** (`constants.rs:2527`–`2613`, `:1570`,
`:1592`).

Full treatment in §4.

---

## 2. What limits quality today

### 2.1 The visible graph was rendering a keyword matcher's guesses — FIXED on this branch

`remember` writes the merged entity list into **both** `experience.entities` and
`experience.tags` (`remember.rs:633-634`, `:1021`, `:1189`). The NER phase typed
each surface from GLiNER (`state.rs:2940-2947`); the **tag phase typed the same
surfaces again** via `classify_tag_label` (`graph_memory.rs:385+`), whose
fallthrough was `EntityLabel::Technology`.

Because `add_entity` dedups by name and writes **incoming labels first**
(`graph_memory.rs:3348-3353`), the last-added twin owned `labels[0]` — and
`labels.first()` is what the graph payload renders. **GLiNER's 141-way typing
was discarded at display time by a dev-ops keyword matcher.** This is exactly
what `graph_memory.rs:297`'s stated invariant ("GLiNER typing must never degrade
a schema-recognized coarse class") exists to prevent; the twin routed around it.

It also explains fragment entities surviving *with GLiNER active*: the tag path
applies **none** of the NER phase's 14 admission gates, so surfaces the NER phase
rejected re-entered through it.

**Fixed on this branch** (commit `dc0028d4`): the tag phase skips NER-claimed
surfaces, and the fallthrough is now the honest `Concept`.

### 2.2 The predicate-fragment gate does not do what its name suggests

`graph_memory.rs:2035-2051` disqualifies an endpoint **whose mention span
overlaps the fired cue's span**, inside `extract_directed_predicate`. It is a
*relation-typing* guard, not an *entity-admission* guard: it prevents a cue word
from becoming a causal endpoint. It cannot stop `"baltimore suspended"` or
`"current design standard"` from becoming **nodes** — node admission happens
upstream at `state.rs:2668-2862`, and (pre-fix) the tag path bypassed even that.

### 2.3 Co-occurrence dominates by construction, not by accident

Per memory, Path A offers up to **45** candidate pairs. The extraction arms are
`O(extractions)` and mostly only *retype* Path-A pairs — the cue extractor and
semantic typer add **no edges**. The only genuinely additive relation-extraction
source in a default deployment is the causal spine (Path C), and **that is inert
without a spaCy bundle**.

**The spaCy cascade is the single biggest quality lever, and it is invisible.**
`dep_parser::load_bundle` (`dep_parser.rs:91-101`) probes
`SHODH_SPACY_MODEL_PATH` → cache dir → `models/en_core_web_sm` (relative to
**process CWD**), and — unlike GLiNER — **there is no downloader**
(`src/embeddings/downloader.rs` exposes only `download_models`,
`download_gliner_models`, `download_onnx_runtime`). When it fails, **five**
subsystems become silent no-ops with no log at the call site:

- OpenIE triples (`graph_memory.rs:2855-2857`)
- CATENA event links (same guard)
- Appositive alias minting (`graph_memory.rs:2669-2671`)
- `canonicalize_entities` (`graph_memory.rs:2960-2962`)
- `entity_resolution::resolve` (`entity_resolution.rs:434`)

So on a deployment without the bundle, the graph has **no causal/temporal
extraction and no entity canonicalization at all** — and nothing says so.

The semantic typer also has a coverage ceiling:

> **Contradiction.** `state.rs:3254-3255` says the 20-pair budget "mirrors the
> Phase-2 pair cap (20)". **Phase 2 has no pair cap.** With 10 entities there are
> 45 pairs, so ~25 can never be semantically typed and fall through to the label
> table or `CoOccurs`.

Additionally, `state.rs:3234`/`:3287` use `try_read` — if a writer holds the user
lock, **typing is skipped entirely for that memory**, silently.

### 2.4 `MemorySystem::upsert` voids the PMI gate

`POST /api/memory/upsert` (`remember.rs:1208` → `:1253`) runs **both** Path D and
`process_experience_into_graph` on the same request. Path D
(`memory/mod.rs:8558-8617`) mints pure `CoOccurs` with **no PMI gate, no hub cap,
no selectivity skip, no fragment mask and no typing**. Every PMI guarantee is
void for upsert and webhook traffic (`integrations.rs:144`, `:221`, `:382`,
`:460`, `:518`).

Also note `Experience.cooccurrence_pairs` is empty at every construction site, so
the `else` branch at `memory/mod.rs:8542` always fires and rebuilds a
1000+-line-dictionary `EntityExtractor` **per upsert**.

### 2.5 The mem↔mem coactivation layer is inert

`record_memory_coactivation` (`graph_memory.rs:5679`) reads
`SHODH_COACT_STRENGTHEN_ONLY`, **default true** (`:5685-5687`). In that mode it
only strengthens edges found via `find_edge_between_entities`, which resolves
through the `mem_edge:` index — and `mem_edge:` keys have **exactly one writer**,
`graph_memory.rs:5773-5774`, inside the `!strengthen_only` mint branch.

**Default on ⇒ no key is ever written ⇒ the strengthen branch never finds
anything ⇒ the function returns 0 for every call.** Consequence:
`stats.associations_strengthened` (`memory/mod.rs:7771`) is always 0 when a
graph is present, while the no-graph fallback reports `n(n-1)/2` — a system
**with** a graph reports fewer associations than one without.

### 2.6 The read path filters nothing

The UI consumes **`GET /api/graph/{user_id}/universe`**
(`router.rs:242` → `handlers/graph.rs:211` → `GraphMemory::get_universe`,
`graph_memory.rs:7117`).

`get_universe` calls `get_all_entities()` and `get_all_relationships()` and
projects **all of both** — no cap, no strength floor, no tier sampling, no
PMI-informed filter. Connection strength is `rel.effective_strength()`
(`:7198`, decay-aware) and entity salience *is* used (star radius, `:7137`).
Dangling endpoints are impossible here: `entity_indices.get(...)?` inside
`filter_map` drops them (`:7190-7191`).

> **Correction to an earlier framing.** `visualization::get_graph_data`
> (`/api/graph/data/{user_id}`) is the **legacy** surface — `visualization.rs:250-254`
> is a tombstone explaining the retirement. Its known defects (flat strength
> 1.0, 200-per-tier truncation, independently-selected nodes and edges producing
> dangling endpoints) are real but **do not affect the UI**. Analysis targeting
> that endpoint does not transfer.

So the near-clique the user sees is a **faithful rendering of what construction
produced**. Nothing is being hidden and nothing is being invented — the fix must
be at creation, or a deliberate new read-side floor.

---

## 3. Memory tiers and the facts layer

### 3.1 Memory tiers

`MemoryTier::{Working, Session, LongTerm, Archive}` (`memory/types.rs:981-991`).

- **Working → Session**: importance ≥ **0.35** (graph-adjusted) AND age ≥ **1800 s**
  (`memory/mod.rs:6248-6252`; `constants.rs:841`, `:852`).
- **Session → LongTerm**: importance ≥ **0.5** AND age ≥ **86400 s**
  (`mod.rs:6308-6312`; `constants.rs:861`, `:872`).
- Triggered both per-request (`mod.rs:1297`, `:1423`) and by background
  maintenance (`mod.rs:8713`).

> **Contradiction.** `mod.rs:6215-6217` documents "0.4 / 5 minutes" and
> "0.6 / 1 hour". **All four values are wrong.**

**Three defects:**

1. **`Archive` is unreachable.** `Memory::promote()` (`types.rs:1346`) is the
   only code that can set it, and its two production call sites
   (`mod.rs:6273`, `:6332`) operate on working and session memories
   respectively. Nothing assigns `Archive` anywhere in `src/`.
   `MEMORY_TIER_GRAPH_MULT_ARCHIVE = 1.2` (`constants.rs:1514`) is an
   unreachable branch, and `constants.rs:1511-1513` ("archived memories are
   gold") describes a path that cannot execute.
2. **Demotion does not exist.** `Memory::demote()` (`types.rs:1361-1369`) has
   **zero production callers** — only tests and benches.
3. **The persisted tier is almost always `Working`.** Working→Session is a
   pure in-memory map move with **no storage write** (`mod.rs:6272-6275`); only
   Session→LongTerm rewrites the record (`mod.rs:6342`). The one place recall
   reads tier — `graph_retrieval.rs:1731-1735`, multiplying the graph leg by
   **0.3 / 0.6 / 1.0 / 1.2** — materializes memories from **storage**
   (`mod.rs:3159-3165`). So every memory in its first 24 h, and every memory
   that never clears the 0.5 bar, is scored at the **0.3** multiplier, and the
   `Session` (0.6) branch is effectively unreachable.

Elsewhere tier is only `format!("{:?}")`-ed into response payloads
(`recall.rs:828`, `:1054`, `:2398`, … `crud.rs:359`, `export.rs:131`).

### 3.2 Facts

Extraction runs on the **heavy cycle only** (`mod.rs:8889-8893`), gated by a
dirty flag, over memories aged ≥ **7 days** (`CONSOLIDATION_MIN_AGE_DAYS`,
`constants.rs:632`), clustered by stemmed-token Jaccard **0.45**
(`constants.rs:641`).

A new fact starts at `support_count: 1` (`compression.rs:617`) regardless of
cluster size. Increments are guarded on genuinely new source memories
(`mod.rs:8981-8983`, `:9595-9597`) and are **+1 per cycle, not +N per source**.

**The key finding: facts can never be corrected.** `SemanticFact`
(`compression.rs:399-419`) has **no** `invalidated_at`, `superseded_by`,
`valid_until` or `retracted` field — while `RelationshipEdge` **does** have
`invalidated_at` (`graph_memory.rs:661-662`), an `invalidate_relationship`
(`:5391-5403`), traversal honouring, and an HTTP endpoint (`router.rs:260-261`).
None of that machinery extends to facts.

The polarity check at `facts.rs:419-423` is a **dedup guard, not contradiction
handling**: when a negated variant appears, `find_similar` returns `None`, so the
negation is stored as a **separate row**. Assertion and negation then coexist,
each accumulating its own support and its own confidence ratchet, **with no link
and no read-time arbitration**. `CausalFactLink.relation == "superseded_by"`
(`compression.rs:472`) is narrative text in a presentation object; it mutates
nothing.

The only downward pressure is **disuse decay** (`mod.rs:10127-10205`): 90-day
grace, then half-life `180 + support_count*30` days, hard delete below
confidence 0.1. A wrong fact that keeps being re-derived resets
`last_reinforced` and never enters the grace window — and **the better supported
it is, the longer its half-life**. A well-supported wrong fact is the most
durable object in the system.

`fact_source_boost`: the score multiply **is live** (up to **1.3×**,
`mod.rs:4534`), but the `ScoreAttribution.fact_source_boost` field
(`types.rs:3113`) is **write-only** — assigned at `:4155`, `:4210`, `:4538` and
read nowhere in `src/`. Provenance is intact: `source_memories: Vec<MemoryId>`
(`compression.rs:409-410`) is populated, persisted and used as the join key.
It is one-directional, and deleting a source memory leaves a dangling id with no
cleanup path.

### 3.3 Do the two consolidation systems interact? — No, and that is defensible

Memory tiers and edge tiers are **fully independent clocks**. Nothing in
`promote_working_to_session` / `promote_session_to_longterm` touches edge tiers,
and nothing in `strengthen()` reads `Memory.tier`. The single crossing point is
one direction only and at *scoring* time, not promotion time:
`graph_retrieval.rs:1731` multiplies the graph leg by the memory's tier.

**Verdict: principled, but under-exploited.** Synaptic consolidation (edge
strength/LTP) and systems consolidation (memory tier) genuinely are different
mechanisms in the literature this design cites, so independent clocks are
defensible. But the *inputs* are shared — a memory that reached LongTerm has by
definition survived importance and age filters that its edges never see — and
today nothing uses that. Coupling promotion (not just scoring) is a real,
un-taken opportunity.

---

## 4. The three edge tiers — rules, verification, verdict

`EdgeTier::{L1Working, L2Episodic, L3Semantic}` (`graph_memory.rs:493-501`).

### 4.1 The rules as they are

**Promotion** (`graph_memory.rs:1044-1050`, mirrored `:1157-1162`):

```rust
if let Some(threshold) = self.tier.promotion_threshold() {
    if self.strength >= threshold {
        if let Some(next_tier) = self.tier.next_tier() {
            self.tier = next_tier;
            self.strength = self.strength.max(next_tier.initial_weight());
```

**Strength is the only criterion.** No activation-count floor, no age floor, no
confidence gate — `activation_count` is incremented (`:991`) but never consulted.
At most one promotion per call.

**Boost**: `(LTP_LEARNING_RATE + tier_boost) * (1 - strength)`, where `tier_boost`
= `0.15 × {L1: 1.0, L2: 0.8, L3: 0.5}` (`:999-1001`) — coefficient **0.25 at L1**,
**0.22 at L2**.

**Decay** (`:1424-1447`): L1 uses `tier_decay_factor(h, 0, ltp)` =
`exp(-0.029 · ltp · h)`. **L2 and L3 both** use
`hybrid_decay_factor(days, is_potentiated)` (`decay.rs:74-108`): exponential
λ=0.693 below 3 days, power-law β=0.5 above.

### 4.2 The two promotion sites — verified identical

Both blocks were compared statement by statement and are **byte-identical** after
comment/whitespace stripping. They have **not** drifted.

The real difference is one line *above* each: `strengthen()` uses
`(0.1 + tier_boost)(1-s)` (`:1003`); `strengthen_with_importance()` multiplies by
`scale = 0.2 + importance*0.8` (`:1105`, `:1119`) — a **5× spread** in arrival
rate at identical criteria. That is deliberate, not drift.

**Verdict: not unified.** The criteria are identical today, and a hand-copied
block is a latent drift risk — but extracting a shared helper is a refactor with
no behavioural change, and this branch already carries three behavioural fixes.
Recorded as R6 below rather than done blind.

### 4.3 Invariants

| # | Invariant | Verdict |
|---|---|---|
| a | Edge is in exactly one tier | **HOLDS** — `tier: EdgeTier` is a single `Copy` field (`:693`); structurally unrepresentable otherwise |
| b | Promotion monotonic | **HOLDS** — the only two tier writes in the codebase (`:1048`, `:1161`) both go up |
| c | Not reachable by one burst | **VIOLATED** — see below |
| d | Decay orders L1 > L2 > L3 | **VIOLATED** — see below |
| e | Survives persistence | **HOLDS** — `tier` is field 13 of 19, read before the 3-byte default suffix (`:920`) can apply |

**(c) VIOLATED — the arithmetic.** From birth weight 0.4:

| call | tier | boost | strength | result |
|---|---|---|---|---|
| 1 | L1 | 0.25 × 0.600 = 0.150 | **0.550** | ≥ 0.5 → **promote L2** |
| 2 | L2 | 0.22 × 0.450 = 0.099 | 0.649 | — |
| 3 | L2 | 0.22 × 0.351 = 0.077 | **0.726** | ≥ 0.7 → **promote L3** |

**One call to L2, three to L3** (3–5 across real birth weights). And three
independent strengthen paths hit the same entity edges **within one request**:
`batch_strengthen_synapses` during retrieval (`graph_retrieval.rs:1855`), then
`reinforce_recall_with_momentum` → `batch_strengthen_synapses_with_importance`
(`memory/mod.rs:7818`), then `strengthen_episode_entity_edges` per helpful memory
(`recall.rs:1719`). **One noisy conversation can promote an edge to
"near-permanent semantic".** There is no cooldown, no minimum age, no
`last_promoted_at`.

**(d) VIOLATED, two ways.** L2 and L3 dispatch to the *same* function with **no
tier argument** (`:1429-1436`) — identical decay. At 30 days unpotentiated both
give `exp(-0.693×3) × 10^-0.5 = 0.0395`. They differ only in prune gates (720 h
vs 2160 h; 0.2 vs 0.3). And L1 vs L2 barely differ over the first two days:
at 48 h, L1 = `exp(-0.029×48)` = **0.2487** vs L2 = `exp(-0.693×2)` = **0.2500**.
L1's λ = 0.029/hr = 0.696/day is a numerical near-twin of L2's 0.693/day.

`L2_DECAY_PER_DAY` (0.031) and `L3_DECAY_PER_MONTH` (0.02) have **zero
production references**.

> **Contradictions.** `graph_memory.rs:1342-1344` states L2 "~3.1%/day" and L3
> "~2%/month" — neither rate is used. `:1347-1349` claims LTP graduation
> 2×/3×/10× — true for L1 only; for L2/L3 all three collapse to the boolean
> `ltp_factor <= 0.5` at `:1435`. `:697` says history capacity "L2 = 20, L3 = 50";
> actual values are **30** and **200** (`constants.rs:1795`, `:1806`).

**Tier is a permanent ratchet decoupled from strength.** `batch_weaken_synapses`
(`:5554-5601`) and `decay_at` (`:1386-1492`) both change strength and **never
touch tier**. An L3 edge decayed to the 0.01 floor keeps `EDGE_TIER_TRUST_L3` =
**0.80** in retrieval scoring (`graph_retrieval.rs:551`, vs L1's **0.20**) and
keeps the 2160-hour prune shield.

**Two production paths mint directly into L2**, skipping the L1 gate:
lineage bridges (`:6100`) and fact edges (`memory/mod.rs:8242`). And a
reward-modulated edge can be **born at 0.56** — above L1's promotion threshold —
yet tagged L1 (`state.rs:3382-3397`), promoting on its next touch regardless of
what that touch is.

### 4.4 Tier population is not measurable

`GraphStats` (`graph_memory.rs:7342-7346`) has no tier breakdown. The only
surface that reports one is the **legacy** `get_graph_data`, whose counters
saturate at 200 per tier (`visualization.rs:378-392`). `grep` across `tui/`,
`mcp-server/src` and `front/` for the tier variants returns **zero matches**.

**So the "is L3 empty or is L1 overwhelmed?" question cannot be answered today.**
Given §4.3(c) — three strengthens to L3, three strengthen paths per request — the
structural expectation is the opposite of the usual worry: **L3 should fill
quickly**, not stay empty. But that is a prediction from arithmetic, not a
measurement, and I am not reporting it as one. Instrumentation is R1.

---

## 5. Ranked recommendations

Framed as: what gets the entity graph from what is rendered today to
"constructing well and looking amazing", in dependency order.
**[≤Aug 10]** = safe before the demo. **[after]** = needs measurement or has
blast radius.

### DONE on this branch

- **D1. Tag twins no longer discard GLiNER's types** (`dc0028d4`). This was the
  reason the graph was one flat class *with the model loaded*. Highest-impact
  visible change available, and it is already in.
- **D2. `classify_tag_label` fallthrough is `Concept`, not `Technology`.** The
  legend no longer lies when the matcher does not recognise something.

### R1 — Tier census instrumentation **[≤Aug 10]** · small

Add tier counts to `GraphStats` (`graph_memory.rs:7342`) — an uncapped scan
bucketing by `edge.tier`, surfaced on the stats endpoint. **Blocks every other
tier decision**: the user is about to colour the graph by tier, which publishes
the distribution whether or not anyone has measured it. Two hours, no behaviour
change, and it converts §4.4's prediction into a fact before the demo.

### R2 — A read-side floor on the universe projection **[≤Aug 10]** · small

`get_universe` (`graph_memory.rs:7117`) renders **everything**. The near-clique
is real data, so the honest options are (a) drop connections below an
`effective_strength` floor, and/or (b) drop bare `CoOccurs` when a typed edge
already joins the same pair. Do this **at read**, not by deleting edges: the
substrate is still useful for retrieval even where it is too noisy to draw.
Make the floor a query parameter with a sane default so the demo and the
recall path can disagree.

*Why read-side and why now:* it is reversible, it needs no re-ingest, and it is
the only lever that changes the rendered picture within three days.

### R3 — Provision the spaCy bundle, or say loudly that it is missing **[≤Aug 10]** · small

Five subsystems — OpenIE, CATENA, appositives, canonicalization, entity
resolution — are silent no-ops without it (§2.3), and unlike GLiNER there is
**no downloader**. Two parts: (i) ship or document the bundle for the demo
machine, (ii) emit one startup warning naming exactly what is disabled. Today a
deployment with no causal extraction and no canonicalization looks identical to
a healthy one.

This is the difference between "essentially one typed edge" and having a causal
spine at all.

### R4 — Close the `upsert` PMI bypass **[≤Aug 10]** · small

Path D (`memory/mod.rs:8558-8617`) mints ungated `CoOccurs` on the same request
that runs the gated loop (§2.4). Route it through the same gate, or drop it
where `process_experience_into_graph` already ran. Directly reduces visible
near-clique density for upsert/webhook corpora.

### R5 — Promotion needs sustained evidence, not three touches **[after]** · medium

§4.3(c): one request can promote an edge L1→L3, and L3 carries a 4× retrieval
trust multiplier and a 90-day prune shield. Add a per-edge promotion cooldown or
require activations across ≥2 distinct sessions/days. **Behavioural, affects
ranking — needs R1's census first** so the change can be measured rather than
guessed. Do not ship blind before the demo.

### R6 — Unify the two promotion blocks; decide L2 vs L3 decay **[after]** · medium

The blocks are identical today (§4.2) — extract a shared helper so they cannot
drift. Separately, L2 and L3 currently decay **identically** (§4.3(d)) while
three constants documenting distinct rates sit unused. Either give L3 a genuinely
slower curve or delete the dead constants and the comments that promise them.
Pure refactor + a deliberate parameter decision; no reason to rush it.

### R7 — Entity linking: generalize the gazetteer pattern **[after]** · medium

The toponym gazetteer shipped on `feat/toponym-gazetteer` is the first real
KB-linking instance in this codebase, and its pattern — **embedded reference
data, case-insensitive exact match, deterministic population-weighted argmax,
results in a field of their own rather than overwriting an existing one** —
generalizes directly to organizations and persons via a Wikidata subset.

That pattern is strictly better than what `kb.rs` does today: `kb.rs` is gated
off by default behind **two** independent gates with no bundled asset
(§1.3), and even when on it only seeds aliases and **discards the QID it
loaded**. A deterministic, always-on, embedded linker would give the visible
graph stable canonical names and real types for the entities users actually
recognize — which is exactly the "looks amazing" axis. Persisting the QID would
also give the graph its first stable external identity.

### R8 — Facts need an invalidation path **[after]** · medium

§3.2: a wrong fact cannot be corrected, only out-waited, and better support
makes it **more** durable. `RelationshipEdge` already has the full
invalidate/supersede machinery; extending it to `SemanticFact` is a known
shape, not a new design. Not demo-blocking — facts need 7 days plus three heavy
cycles to influence anything — but it is the clearest correctness gap in the
consolidation story.

### Explicitly NOT recommended

- **Deleting co-occurrence edges at creation.** They are the retrieval
  substrate; §2.6 shows the visible problem is that nothing filters at *read*.
  Fix the picture at read (R2) before touching what ingest stores.
- **Re-tuning PMI thresholds for the demo.** `SHODH_GRAPH_PMI_GATE_MIN` is a
  live knob, but moving it without R1's census is exactly the "lower the
  threshold until it looks right" move the project's standards forbid.

---

## Appendix — comment/code contradictions found

| # | Location | Contradiction |
|---|---|---|
| 1 | `ner.rs:10-12` | "falls back when assets absent" — omits the network download at `:249-266` |
| 2 | `relation_typer.rs:9-10` | claims semantic→cue order; code runs cue→semantic (`state.rs:3648` vs `:3674`) |
| 3 | `entity_resolution.rs:1-26` | describes the head-block resolver as live; it has no production caller |
| 4 | `state.rs:3441` | PMI gate "applies at birth"; it also blocks re-attestation of existing edges |
| 5 | `state.rs:3254-3255` | references a "Phase-2 pair cap (20)" that does not exist |
| 6 | `graph_memory.rs:2948-2955` | canonicalize "re-points every edge"; member↔canonical edges become self-loops and are deleted uncounted (`:3113-3118`) |
| 7 | `graph_memory.rs:3382-3383` | salience boost described as one-shot; code compounds |
| 8 | `graph_memory.rs:1342-1349` | L2/L3 decay rates and LTP graduation — neither matches the executed path |
| 9 | `graph_memory.rs:697` | history capacity "L2=20, L3=50"; actual 30 / 200 |
| 10 | `graph_memory.rs:6584-6588`, `:6676` vs `:6630` | homeostasis documented as step 4; the early return skips it whenever nothing prunes |
| 11 | `memory/mod.rs:6215-6217` | all four memory-tier promotion thresholds stale |
| 12 | `memory/types.rs:1050` | "Working → Session → LongTerm → Archive"; the last arrow does not exist |
| 13 | `facts.rs:419` | "prevents merging contradictions" — it lets contradictions coexist unlinked |
| 14 | `constants.rs:1511-1513` | describes Archive behaviour that cannot execute |
| 15 | `graph_memory.rs:765` | `TypingMethod::Glirel` has no construction site; GLiREL is not wired |

## Appendix — dead or unreachable in the default path

`entity_resolution::{cluster, resolve}` · `MemoryTier::Archive` ·
`Memory::demote()` · `MemorySystem::reinforce_fact` ·
`ScoreAttribution.fact_source_boost` as a scoring input · `TypingMethod::Glirel` ·
`record_memory_coactivation` (returns 0 always, §2.5) ·
`EDGE_INITIAL_STRENGTH` / `EDGE_MIN_STRENGTH` / `EDGE_HALF_LIFE_HOURS` /
`L2_DECAY_PER_DAY` / `L3_DECAY_PER_MONTH` / `GRAPH_PMI_WEIGHT_FLOOR` ·
`Experience.cooccurrence_pairs` (empty at every construction site) ·
`SHODH_NER_CONFIDENCE` / `SHODH_NER_MODEL_PATH` on the GLiNER path
