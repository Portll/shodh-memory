//! Edge-tier consolidation on a BATCH-INGESTED store.
//!
//! Every import, every eval run and every seeded deployment ingests its corpus
//! in one pass, so every edge is created within minutes of every other edge.
//! Promotion used to be gated purely on wall-clock separation since an edge
//! entered its tier (30 min L1→L2, 24 h L2→L3), which such a store can never
//! satisfy: the entire graph stayed at `L1Working`, carrying `EDGE_TIER_TRUST_L1`
//! (0.20, a 4x retrieval-trust penalty against L3) and aging out on the L1 prune
//! schedule. The gate now also accepts distinct attesting *episodes*, which is
//! what the clock was standing in for.
//!
//! These tests measure that on a real RocksDB store built from a real corpus
//! through the real `add_relationship` ingest path, and pin the invariants that
//! keep the result defensible in BOTH directions: no edge may be promoted
//! without independent evidence, and no edge WITH independent evidence may be
//! left frozen at L1.
//!
//! Run with `--nocapture` to see the census and the episode histogram.

use shodh_memory::constants::{
    L1_INITIAL_WEIGHT, TIER_PROMOTION_L2_MIN_EPISODES, TIER_PROMOTION_L3_MIN_EPISODES,
    TIER_PROMOTION_WORKING_AGE_SECS,
};
use shodh_memory::graph_memory::{
    EdgeTier, EntityLabel, EntityNode, GraphMemory, LtpStatus, RelationType, RelationshipEdge,
};
use shodh_memory::uuid::Uuid;
use std::collections::HashMap;
use std::path::PathBuf;

/// Where test stores live.
///
/// NOT under the repo and NOT under any synced/indexed directory: a file watcher
/// of the search-indexer/AV class silently drops tantivy commits there, which
/// makes a store look intact while being subtly wrong. Short path also keeps
/// RocksDB's internal filenames inside MAX_PATH on Windows.
fn store_root(name: &str) -> PathBuf {
    let base = std::env::var("SHODH_TEST_STORE_ROOT").unwrap_or_else(|_| "C:/smt".to_string());
    PathBuf::from(base).join(format!("tierstore-{name}-{}", Uuid::new_v4()))
}

struct Store {
    /// `Option` so `Drop` can CLOSE the database before deleting its directory.
    /// `Drop::drop` runs before the struct's fields are dropped, so holding a
    /// plain `GraphMemory` here meant RocksDB still had the files open when
    /// `remove_dir_all` ran: on Windows the delete fails, and because the
    /// result was discarded it failed silently, leaving a multi-megabyte store
    /// behind after every run. Always `take()` and drop the handle first.
    graph: Option<GraphMemory>,
    path: PathBuf,
}

impl Store {
    fn open(name: &str) -> Self {
        let path = store_root(name);
        std::fs::create_dir_all(&path).expect("create store dir");
        let graph = GraphMemory::new(&path, None).expect("open graph memory");
        Store {
            graph: Some(graph),
            path,
        }
    }

    fn graph(&self) -> &GraphMemory {
        self.graph.as_ref().expect("store is open")
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        // Close the DB first (see the field comment), then delete.
        drop(self.graph.take());
        if let Err(e) = std::fs::remove_dir_all(&self.path) {
            // Report rather than swallow: a test store left under C:\smt is a
            // real leak, and a silent one is how it goes unnoticed.
            eprintln!(
                "warning: could not delete test store {}: {e}",
                self.path.display()
            );
        }
    }
}

/// One corpus item: the unit that becomes one memory, i.e. one *episode*.
struct CorpusItem {
    id: String,
    content: String,
}

/// Load the LoCoMo gate corpus — 629 real conversational turns, the same text
/// the CI recall gate runs on. Deliberately a REAL corpus: the only property
/// this measurement depends on is how often the same entity pair recurs across
/// DIFFERENT episodes, and that distribution must come from real data rather
/// than from a shape chosen by whoever wrote the test.
fn load_corpus() -> Vec<CorpusItem> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/recall/corpora/locomo-gate.jsonl");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read corpus {}: {e}", path.display()));

    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let v: serde_json::Value = serde_json::from_str(line).expect("corpus line is JSON");
            CorpusItem {
                id: v["id"].as_str().expect("corpus item id").to_string(),
                content: v["content"]
                    .as_str()
                    .expect("corpus item content")
                    .to_string(),
            }
        })
        .collect()
}

/// Extract entity mentions with the production NER.
///
/// Uses the real GLiNER weights, never `new_fallback`: the fallback extractor
/// produces a different entity population and therefore a different
/// cross-episode repeat distribution, which is the ONLY thing this measurement
/// reads. A census taken through the fallback would be a census of the fallback.
fn build_ner() -> shodh_memory::embeddings::ner::NeuralNer {
    use shodh_memory::embeddings::ner::{NerConfig, NeuralNer};
    let ner = NeuralNer::new(NerConfig::from_env()).expect("construct NER");
    // `NeuralNer::new` NEVER returns Err for a missing model — it logs a warning
    // and degrades to the rule-based fallback. A census taken through the
    // fallback is a census of the fallback: a different entity population gives
    // a different cross-episode repeat distribution, which is the only input
    // this measurement reads. Fail loudly instead.
    assert!(
        !ner.is_fallback_mode(),
        "this measurement requires the real GLiNER weights and refuses to \
         silently substitute the rule-based fallback. Set SHODH_GLINER_MODEL_PATH \
         to a directory containing model.onnx, tokenizer.json and \
         label_embeddings.bin"
    );
    ner
}

/// Ingest a corpus the way `MemorySystem::connect_entities_in_graph` does:
/// resolve each mention to an entity, then attest a `CoOccurs` edge for every
/// unordered pair of distinct entities in the episode, tagged with that
/// episode's id. `add_relationship` does the rest — dedup onto the existing
/// edge, provenance merge, strengthen, promotion.
///
/// Returns the wall-clock seconds the ingest took, which is load-bearing: the
/// "before" figure in this measurement is a theorem, not an estimate, and it
/// only holds while the whole pass fits inside one promotion window.
fn ingest(graph: &GraphMemory, corpus: &[CorpusItem]) -> i64 {
    let ner = build_ner();
    let started = chrono::Utc::now();
    // Entity name -> uuid, so the same name in different episodes is the same node.
    let mut entities: HashMap<String, Uuid> = HashMap::new();

    for item in corpus {
        // One corpus item = one memory = one episode, minted exactly once here.
        // This id is what `merge_provenance` deduplicates on, and therefore what
        // "distinct attesting episodes" counts.
        debug_assert!(!item.id.is_empty(), "corpus item must have an id");
        let episode_id = Uuid::new_v4();

        let mut names: Vec<String> = ner
            .extract(&item.content)
            .unwrap_or_default()
            .into_iter()
            .map(|e| e.text.trim().to_string())
            .filter(|n| !n.is_empty())
            .collect();
        names.sort();
        names.dedup();
        if names.len() < 2 {
            continue;
        }

        let mut ids = Vec::with_capacity(names.len());
        for name in &names {
            let id = match entities.get(name) {
                Some(id) => *id,
                None => {
                    let node = EntityNode {
                        uuid: Uuid::new_v4(),
                        name: name.clone(),
                        labels: vec![EntityLabel::Concept],
                        created_at: chrono::Utc::now(),
                        last_seen_at: chrono::Utc::now(),
                        mention_count: 1,
                        summary: String::new(),
                        attributes: HashMap::new(),
                        name_embedding: None,
                        salience: 0.5,
                        is_proper_noun: true,
                        selectivity: None,
                        fine_type: None,
                        kb_id: None,
                    };
                    let id = graph.add_entity(node).expect("add entity");
                    entities.insert(name.clone(), id);
                    id
                }
            };
            ids.push(id);
        }

        for i in 0..ids.len() {
            for j in (i + 1)..ids.len() {
                let now = chrono::Utc::now();
                let edge = RelationshipEdge {
                    uuid: Uuid::new_v4(),
                    from_entity: ids[i],
                    to_entity: ids[j],
                    relation_type: RelationType::CoOccurs,
                    strength: L1_INITIAL_WEIGHT,
                    created_at: now,
                    valid_at: now,
                    invalidated_at: None,
                    source_episode_id: Some(episode_id),
                    context: String::new(),
                    last_activated: now,
                    activation_count: 1,
                    ltp_status: LtpStatus::None,
                    tier: EdgeTier::L1Working,
                    activation_timestamps: None,
                    entity_confidence: Some(0.8),
                    endpoint_selectivity: None,
                    forman_curvature: None,
                    provenance: Vec::new(),
                    promoted_at: None,
                };
                graph.add_relationship(edge).expect("add relationship");
            }
        }
    }

    (chrono::Utc::now() - started).num_seconds()
}

#[test]
fn batch_ingest_consolidates_by_evidence_not_by_clock() {
    let store = Store::open("census");
    let corpus = load_corpus();
    assert!(
        corpus.len() > 100,
        "expected the real gate corpus, got {} items",
        corpus.len()
    );

    let ingest_secs = ingest(store.graph(), &corpus);
    let census = store.graph().edge_tier_census().expect("census");
    let edges = store.graph().get_all_relationships().expect("all edges");

    // --- Episode histogram: the evidence the gate actually reads. ---
    let mut hist: HashMap<usize, usize> = HashMap::new();
    for e in &edges {
        *hist.entry(e.distinct_attesting_episodes()).or_default() += 1;
    }
    let with_at_least = |n: usize| -> usize {
        edges
            .iter()
            .filter(|e| e.distinct_attesting_episodes() >= n)
            .count()
    };
    let total = edges.len();
    let pct = |n: usize| {
        if total == 0 {
            0.0
        } else {
            100.0 * n as f64 / total as f64
        }
    };

    println!(
        "\n=== batch-ingested store: {} episodes, {total} edges ===",
        corpus.len()
    );
    println!("ingest wall-clock: {ingest_secs}s");
    println!(
        "AFTER (episode-aware gate):  L1 {} ({:.1}%)  L2 {} ({:.1}%)  L3 {} ({:.1}%)",
        census.l1_working,
        pct(census.l1_working),
        census.l2_episodic,
        pct(census.l2_episodic),
        census.l3_semantic,
        pct(census.l3_semantic),
    );
    println!(
        "BEFORE (clock-only gate):    L1 {total} (100.0%)  L2 0 (0.0%)  L3 0 (0.0%)  [see assertion below]"
    );
    println!(
        "mean strength: L1 {:.4}  L2 {:.4}  L3 {:.4}   below-prune-threshold: {}",
        census.l1_mean_strength,
        census.l2_mean_strength,
        census.l3_mean_strength,
        census.below_prune_threshold
    );
    let mut keys: Vec<_> = hist.keys().copied().collect();
    keys.sort();
    for k in keys {
        println!("  edges attested by {k} distinct episode(s): {}", hist[&k]);
    }
    println!(
        ">= {TIER_PROMOTION_L2_MIN_EPISODES} episodes: {} ({:.1}%)   >= {TIER_PROMOTION_L3_MIN_EPISODES} episodes: {} ({:.1}%)",
        with_at_least(TIER_PROMOTION_L2_MIN_EPISODES),
        pct(with_at_least(TIER_PROMOTION_L2_MIN_EPISODES)),
        with_at_least(TIER_PROMOTION_L3_MIN_EPISODES),
        pct(with_at_least(TIER_PROMOTION_L3_MIN_EPISODES)),
    );

    assert_eq!(
        census.l1_working + census.l2_episodic + census.l3_semantic,
        census.total_scanned,
        "every scanned edge must land in exactly one tier bucket"
    );
    // This ingest invalidates nothing, so the census (which counts all edges)
    // and `get_all_relationships` (which drops invalidated ones) must agree. A
    // shortfall here means the census swallowed a decode failure, which would
    // make every percentage below a fraction of the wrong denominator.
    assert_eq!(
        census.total_scanned, total,
        "census scanned {} edges but the store holds {total}",
        census.total_scanned
    );
    assert!(total > 0, "ingest produced no edges");

    // --- The "before" figure is a theorem, not a measurement. ---
    // The clock arm anchors at `promoted_at.unwrap_or(created_at)`, and every
    // edge here was created during this ingest. If the whole pass fits inside
    // one L1->L2 window, then NO edge could have satisfied the clock arm, so a
    // clock-only gate leaves 100% of this store at L1. That is the entire
    // defect: the outcome is a property of the ingest schedule, not of the
    // evidence.
    assert!(
        ingest_secs < TIER_PROMOTION_WORKING_AGE_SECS,
        "ingest took {ingest_secs}s, which is longer than the {TIER_PROMOTION_WORKING_AGE_SECS}s \
         L1->L2 window; the 100%-L1 'before' figure only holds for a pass that fits inside it"
    );

    // --- Direction 1: nothing is promoted without independent evidence. ---
    // This is the anti-burst intent, checked on every edge in a real store
    // rather than on a hand-built one.
    for e in &edges {
        match e.tier {
            EdgeTier::L1Working => {}
            EdgeTier::L2Episodic => assert!(
                e.distinct_attesting_episodes() >= TIER_PROMOTION_L2_MIN_EPISODES,
                "L2 edge {} has only {} distinct attesting episode(s)",
                e.uuid,
                e.distinct_attesting_episodes()
            ),
            EdgeTier::L3Semantic => assert!(
                e.distinct_attesting_episodes() >= TIER_PROMOTION_L3_MIN_EPISODES,
                "L3 edge {} has only {} distinct attesting episode(s) — a semantic-tier \
                 edge carries a 4x retrieval-trust multiplier and must be corroborated",
                e.uuid,
                e.distinct_attesting_episodes()
            ),
        }
    }

    // --- Direction 2: no edge WITH real support is left frozen at L1. ---
    // An L1 edge may only be there because it lacks corroboration or because it
    // has not reached the strength threshold; never because the wall clock
    // refused to move during a batch ingest.
    for e in &edges {
        if e.tier == EdgeTier::L1Working
            && e.distinct_attesting_episodes() >= TIER_PROMOTION_L2_MIN_EPISODES
        {
            assert!(
                e.strength < EdgeTier::L1Working.promotion_threshold().unwrap(),
                "edge {} has {} distinct attesting episodes and strength {} — it is \
                 frozen at L1 for no reason the gate can justify",
                e.uuid,
                e.distinct_attesting_episodes(),
                e.strength
            );
        }
    }

    // --- The store must actually consolidate something. ---
    // Without this the two invariants above are trivially satisfiable by never
    // promoting anything, which is precisely the defect.
    assert!(
        census.l2_episodic + census.l3_semantic > 0,
        "a batch-ingested real corpus must consolidate SOME edges; got 100% L1, \
         which is the clock-only behaviour this change exists to fix"
    );

    // --- And it must not consolidate everything. ---
    // The other failure mode: a census on this class of store once showed 81%
    // L3 under burst promotion. Rather than pinning a percentage (which would
    // be a number chosen to match today's corpus), pin the structural claim:
    // the L3 population cannot exceed the population that has the evidence for
    // it. Combined with the histogram printed above, that bounds the outcome
    // with a fact about the data instead of a tuned constant.
    assert!(
        census.l3_semantic <= with_at_least(TIER_PROMOTION_L3_MIN_EPISODES),
        "more L3 edges ({}) than edges with {TIER_PROMOTION_L3_MIN_EPISODES}+ distinct \
         attesting episodes ({})",
        census.l3_semantic,
        with_at_least(TIER_PROMOTION_L3_MIN_EPISODES)
    );
}

#[test]
fn corroborated_edges_survive_the_lazy_prune_path() {
    // The second half of the defect: an edge frozen at L1 also faced lazy-prune
    // deletion once its decayed strength fell under `L1_PRUNE_THRESHOLD`. The
    // promotion fix alone does NOT rescue it — L2's prune threshold is double
    // L1's at essentially the same executed decay rate over the first three
    // days, so a promoted-but-unprotected edge becomes prunable EARLIER. What
    // rescues it is that the same distinct-episode evidence which earns
    // promotion also shields it from strength-based pruning.
    let store = Store::open("prune");
    let corpus: Vec<CorpusItem> = load_corpus().into_iter().take(200).collect();
    ingest(store.graph(), &corpus);

    let edges = store.graph().get_all_relationships().expect("all edges");
    let corroborated: Vec<_> = edges
        .iter()
        .filter(|e| e.distinct_attesting_episodes() >= TIER_PROMOTION_L2_MIN_EPISODES)
        .collect();
    assert!(
        !corroborated.is_empty(),
        "corpus produced no corroborated edges; the rest of this test is vacuous"
    );

    for e in &corroborated {
        assert!(
            e.is_prune_protected(),
            "edge {} is attested by {} distinct episodes and must not be deletable \
             by the strength-only lazy prune path",
            e.uuid,
            e.distinct_attesting_episodes()
        );
    }

    // Singletons are NOT protected. The fix rescues corroborated knowledge, not
    // everything: an entity pair seen exactly once and never again still ages
    // out, which is what L1/working memory means.
    let singletons: Vec<_> = edges
        .iter()
        .filter(|e| e.distinct_attesting_episodes() <= 1)
        .collect();
    if !singletons.is_empty() {
        assert!(
            singletons.iter().all(|e| !e.is_prune_protected()),
            "single-attestation edges must remain subject to normal pruning"
        );
    }
    println!(
        "corroborated (protected): {}   singletons (unprotected): {}",
        corroborated.len(),
        singletons.len()
    );
}
