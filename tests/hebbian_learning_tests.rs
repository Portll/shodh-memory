//! Hebbian Learning Tests
//!
//! Tests for the Hebbian feedback loop:
//! - "Neurons that fire together wire together"
//! - Reinforcement from task outcomes
//! - Association strengthening between co-retrieved memories
//! - Importance boost/decay based on helpfulness
//! - NER integration for entity extraction

use std::sync::Arc;

use shodh_memory::embeddings::ner::{NerConfig, NeuralNer};
use shodh_memory::graph_memory::GraphMemory;
use shodh_memory::memory::{
    Experience, ExperienceType, MemoryConfig, MemorySystem, Query, RetrievalOutcome,
};
use tempfile::TempDir;

/// Create fallback NER instance for testing
fn setup_fallback_ner() -> NeuralNer {
    let config = NerConfig::default();
    NeuralNer::new_fallback(config)
}

/// Create test memory system
fn setup_memory_system() -> (MemorySystem, TempDir) {
    let temp_dir = TempDir::new().expect("Failed to create temp dir");
    let config = MemoryConfig {
        storage_path: temp_dir.path().to_path_buf(),
        working_memory_size: 100,
        session_memory_size_mb: 50,
        max_heap_per_user_mb: 200,
        auto_compress: false,
        compression_age_days: 30,
        importance_threshold: 0.7,
    };

    let mut memory_system =
        MemorySystem::new(config, None).expect("Failed to create memory system");

    // Wire up GraphMemory for Hebbian association tests
    let graph_path = temp_dir.path().join("graph");
    let graph_memory = GraphMemory::new(&graph_path, None).expect("Failed to create graph memory");
    memory_system.set_graph_memory(Arc::new(shodh_memory::parking_lot::RwLock::new(
        graph_memory,
    )));

    (memory_system, temp_dir)
}

/// Create experience with specified content
fn create_experience(content: &str) -> Experience {
    Experience {
        content: content.to_string(),
        experience_type: ExperienceType::Observation,
        ..Default::default()
    }
}

/// Create experience with NER-extracted entities
fn create_experience_with_ner(content: &str, ner: &NeuralNer) -> Experience {
    let entities = ner.extract(content).unwrap_or_default();
    let entity_names: Vec<String> = entities.iter().map(|e| e.text.clone()).collect();
    Experience {
        content: content.to_string(),
        experience_type: ExperienceType::Observation,
        entities: entity_names,
        ..Default::default()
    }
}

// =============================================================================
// RETRIEVAL TRACKING TESTS
// =============================================================================

#[test]
fn test_retrieve_returns_memories() {
    let (mut memory, _temp) = setup_memory_system();

    // Record some memories
    memory
        .remember(
            create_experience("Robot detected obstacle at entrance"),
            None,
        )
        .unwrap();
    memory
        .remember(create_experience("Drone completed patrol route"), None)
        .unwrap();

    // Retrieve
    let query = Query {
        query_text: Some("obstacle detection".to_string()),
        max_results: 5,
        ..Default::default()
    };

    let results = memory.recall(&query).unwrap();
    assert!(!results.is_empty(), "Should find relevant memories");
}

#[test]
fn test_retrieve_multiple_related() {
    let (mut memory, _temp) = setup_memory_system();

    // Record related memories
    for i in 0..10 {
        memory
            .remember(
                create_experience(&format!("Warehouse section {} inventory check complete", i)),
                None,
            )
            .unwrap();
    }

    let query = Query {
        query_text: Some("warehouse inventory".to_string()),
        max_results: 10,
        ..Default::default()
    };

    let results = memory.recall(&query).unwrap();
    assert!(results.len() >= 5, "Should find multiple related memories");
}

// =============================================================================
// REINFORCEMENT OUTCOME TESTS
// =============================================================================

#[test]
fn test_reinforce_helpful_boosts_importance() {
    let (mut memory, _temp) = setup_memory_system();

    // Record memory
    let id = memory
        .remember(
            create_experience("Critical safety procedure: always check battery before flight"),
            None,
        )
        .unwrap();

    // Get initial importance
    let initial = memory.get_memory(&id).unwrap();
    let initial_importance = initial.importance();

    // Reinforce as helpful
    let ids = vec![id];
    let stats = memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();

    assert!(
        stats.importance_boosts > 0,
        "Should have boosted importance"
    );

    // Check importance increased
    let after = memory.get_memory(&ids[0]).unwrap();
    assert!(
        after.importance() > initial_importance,
        "Importance should increase after helpful feedback"
    );
}

#[test]
fn test_reinforce_misleading_decays_importance() {
    let (mut memory, _temp) = setup_memory_system();

    // Record memory with high importance
    let id = memory
        .remember(
            Experience {
                content: "Outdated procedure that no longer applies".to_string(),
                experience_type: ExperienceType::Decision,
                ..Default::default()
            },
            None,
        )
        .unwrap();

    // Get initial importance
    let initial = memory.get_memory(&id).unwrap();
    let initial_importance = initial.importance();

    // Reinforce as misleading
    let ids = vec![id];
    let stats = memory
        .reinforce_recall(&ids, RetrievalOutcome::Misleading)
        .unwrap();

    assert!(
        stats.importance_decays > 0,
        "Should have decayed importance"
    );

    // Check importance decreased
    let after = memory.get_memory(&ids[0]).unwrap();
    assert!(
        after.importance() < initial_importance,
        "Importance should decrease after misleading feedback"
    );
}

#[test]
fn test_reinforce_neutral_no_change() {
    let (mut memory, _temp) = setup_memory_system();

    // Record memory
    let id = memory
        .remember(
            create_experience("General observation about warehouse"),
            None,
        )
        .unwrap();

    // Get initial importance
    let initial = memory.get_memory(&id).unwrap();
    let _initial_importance = initial.importance();

    // Reinforce as neutral
    let ids = vec![id];
    let stats = memory
        .reinforce_recall(&ids, RetrievalOutcome::Neutral)
        .unwrap();

    // Check stats
    assert_eq!(stats.importance_boosts, 0, "Neutral should not boost");
    assert_eq!(stats.importance_decays, 0, "Neutral should not decay");
}

// =============================================================================
// ASSOCIATION STRENGTHENING TESTS (Fire Together Wire Together)
// =============================================================================
//
// SHIPPED-SEMANTICS NOTE for every test in this file that co-retrieves plain
// memories and then looks at memory-to-memory associations.
//
// `f6b730ee` (2026-07-10) flipped `SHODH_COACT_STRENGTHEN_ONLY` to default-ON
// ("strengthen-not-create"): `GraphMemory::record_memory_coactivation`
// (src/graph_memory.rs:5620) now only STRENGTHENS a memory-to-memory edge that
// already exists between a co-active pair; it no longer mints a `CoRetrieved`
// edge for every co-retrieved pair. That un-gated all-pairs minting was
// measured at ~80% of all graph edges and was the recall-time OOM driver.
//
// The consequence these tests hit: the mint branch is the ONLY writer of the
// `mem_edge:{a}:{b}` pair index that `find_edge_between_entities` reads (every
// other reference in the tree is a reader). With minting off by default, that
// lookup returns `None` for every memory pair, so the strengthen branch has
// nothing to find and `record_memory_coactivation` returns 0. Downstream:
// `reinforce_recall` sets `stats.associations_strengthened` from that count
// (src/memory/mod.rs:7630) so it is always 0, and `graph_stats()`
// (src/memory/mod.rs:8087) reports `edge_count == 0`, `avg_strength == 0.0`,
// `potentiated_count == 0` for these memories.
//
// This is the current, intentional contract, not a bug — but note a
// remove-vs-revive decision on the memory-to-memory coactivation layer is
// PENDING. The tests below therefore pin CURRENT shipped behavior and
// deliberately assert nothing about whether the layer *should* mint.
//
// The both-modes contract (mint when strengthen_only=false; strengthen-not-mint
// when strengthen_only=true and a prior edge exists; mint nothing when
// strengthen_only=true and no prior edge exists) is pinned by the unit tests in
// src/graph_memory.rs:
//   - coactivation_strengthen_only_creates_no_new_edges
//   - coactivation_strengthen_only_still_strengthens_existing
//   - coactivation_strengthen_only_actually_increments_activation_and_strength
// Durability of those edges is pinned by (same module):
//   - coactivation_edges_survive_graph_reopen
//   - coactivation_edge_strength_survives_graph_reopen
//   - coactivation_ltp_status_survives_graph_reopen
// Those tests can reach the mint path because `record_memory_coactivation_impl`
// takes `strengthen_only` as a PARAMETER. Integration tests cannot: the only
// lever from here is the `SHODH_COACT_STRENGTHEN_ONLY` env var, and
// `std::env::set_var` is process-global — flipping it inside one `#[test]`
// would change coactivation semantics for every sibling test running
// concurrently in this same binary. So it is deliberately not used here.
//
// Assertions are written as deltas (before vs. after) rather than absolute
// totals wherever `graph_stats().edge_count` is involved, because that counter
// is the WHOLE-graph relationship count and these tests do not control what, if
// anything, entity-level ingest already placed in the graph.

#[test]
fn test_co_retrieval_strengthens_association() {
    let (mut memory, _temp) = setup_memory_system();

    // Record related memories
    let id1 = memory
        .remember(
            create_experience("Battery level monitoring is critical for drone safety"),
            None,
        )
        .unwrap();
    let id2 = memory
        .remember(
            create_experience("Low battery triggers automatic return to base"),
            None,
        )
        .unwrap();

    // Reinforce both together as helpful. These two memories have no
    // pre-existing memory-to-memory edge, so under the shipped strengthen-only
    // default there is nothing to strengthen: the reinforcement is a no-op at
    // the association layer. See the module note above.
    let edges_before = memory.graph_stats().edge_count;
    let ids = vec![id1, id2];
    let stats = memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();
    let edges_after = memory.graph_stats().edge_count;

    assert_eq!(
        stats.associations_strengthened, 0,
        "strengthen-only default (f6b730ee, 2026-07-10) reports zero strengthened \
         associations for a co-retrieved pair with no prior edge between them"
    );
    assert_eq!(
        edges_after, edges_before,
        "co-retrieval must mint zero NEW edges under the shipped default: \
         before={edges_before}, after={edges_after}"
    );
    // The reinforcement itself still succeeded — it just did not wire anything.
    assert_eq!(stats.memories_processed, 2);
}

#[test]
fn test_repeated_co_retrieval_increases_strength() {
    let (mut memory, _temp) = setup_memory_system();

    // Record related memories
    let id1 = memory
        .remember(
            create_experience("Obstacle A detected at north entrance"),
            None,
        )
        .unwrap();
    let id2 = memory
        .remember(create_experience("Obstacle A is a forklift"), None)
        .unwrap();

    let ids = vec![id1, id2];
    let edges_before = memory.graph_stats().edge_count;

    // Reinforce multiple times. Repetition is the point of this test: under the
    // pre-2026-07-10 semantics the FIRST co-retrieval minted the edge and the
    // second and third strengthened it, so all three reported > 0. Under the
    // shipped strengthen-only default no edge is ever minted, so repetition
    // never bootstraps one — every pass stays at zero. See the module note.
    let stats1 = memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();
    let stats2 = memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();
    let stats3 = memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();

    assert_eq!(
        (
            stats1.associations_strengthened,
            stats2.associations_strengthened,
            stats3.associations_strengthened
        ),
        (0, 0, 0),
        "repeated co-retrieval must not bootstrap a memory-to-memory edge under \
         the shipped strengthen-only default"
    );
    assert_eq!(
        memory.graph_stats().edge_count,
        edges_before,
        "three co-retrieval passes must still mint zero NEW edges"
    );
}

#[test]
fn test_single_memory_no_associations() {
    let (mut memory, _temp) = setup_memory_system();

    let id = memory
        .remember(create_experience("Single isolated memory"), None)
        .unwrap();

    let ids = vec![id];
    let stats = memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();

    // Single memory can't have associations with itself
    assert_eq!(
        stats.associations_strengthened, 0,
        "Single memory has no associations"
    );
}

#[test]
fn test_many_co_retrieved_associations() {
    let (mut memory, _temp) = setup_memory_system();

    // Record many related memories
    let mut ids = Vec::new();
    for i in 0..10 {
        let id = memory
            .remember(
                create_experience(&format!("Mission log entry {}: patrol sector {}", i, i)),
                None,
            )
            .unwrap();
        ids.push(id);
    }

    // Reinforce all together. Before 2026-07-10 this minted C(10,2) = 45
    // all-pairs CoRetrieved edges (under the MAX_COACTIVATION_SIZE=20 cap,
    // which only starts truncating above 20 inputs). Under the shipped
    // strengthen-only default none of the 45 pairs has a prior edge, so the
    // count is zero and the O(n²) cap is no longer observable from here — the
    // cap itself is exercised by the unit tests named in the module note.
    let edges_before = memory.graph_stats().edge_count;
    let stats = memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();

    assert_eq!(
        stats.associations_strengthened, 0,
        "10 co-retrieved memories with no prior edges between them strengthen \
         nothing under the shipped strengthen-only default"
    );
    assert_eq!(
        memory.graph_stats().edge_count,
        edges_before,
        "bulk co-retrieval must mint zero NEW edges under the shipped default"
    );
    assert_eq!(stats.memories_processed, 10);
}

// =============================================================================
// REINFORCEMENT STATS TESTS
// =============================================================================

#[test]
fn test_reinforcement_stats_counts() {
    let (mut memory, _temp) = setup_memory_system();

    // Record memories
    let id1 = memory
        .remember(create_experience("Memory 1"), None)
        .unwrap();
    let id2 = memory
        .remember(create_experience("Memory 2"), None)
        .unwrap();
    let id3 = memory
        .remember(create_experience("Memory 3"), None)
        .unwrap();

    let ids = vec![id1, id2, id3];
    let stats = memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();

    assert_eq!(stats.memories_processed, 3, "Should process all memories");
}

#[test]
fn test_reinforcement_empty_ids() {
    let (mut memory, _temp) = setup_memory_system();

    let ids: Vec<shodh_memory::memory::MemoryId> = vec![];
    let stats = memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();

    assert_eq!(stats.memories_processed, 0);
    assert_eq!(stats.associations_strengthened, 0);
    assert_eq!(stats.importance_boosts, 0);
    assert_eq!(stats.importance_decays, 0);
}

#[test]
fn test_reinforcement_invalid_ids() {
    let (mut memory, _temp) = setup_memory_system();

    // Create random IDs that don't exist
    let ids = vec![
        shodh_memory::memory::MemoryId(shodh_memory::uuid::Uuid::new_v4()),
        shodh_memory::memory::MemoryId(shodh_memory::uuid::Uuid::new_v4()),
    ];

    let stats = memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();

    // memories_processed counts input IDs, not found memories
    // This is by design - the function accepts any IDs and silently skips non-existent ones
    assert_eq!(stats.memories_processed, 2);
    // But importance boosts should be 0 since no actual memories were found
    assert_eq!(stats.importance_boosts, 0);
}

// =============================================================================
// HEBBIAN LEARNING FORMULA TESTS
// =============================================================================

#[test]
fn test_importance_boost_formula() {
    let (mut memory, _temp) = setup_memory_system();

    // Create memory with known importance
    let id = memory
        .remember(
            Experience {
                content: "Test content".to_string(),
                experience_type: ExperienceType::Observation,
                ..Default::default()
            },
            None,
        )
        .unwrap();

    let before = memory.get_memory(&id).unwrap();
    let before_importance = before.importance();

    // Reinforce as helpful
    memory
        .reinforce_recall(&[id.clone()], RetrievalOutcome::Helpful)
        .unwrap();

    let after = memory.get_memory(&id).unwrap();
    let after_importance = after.importance();

    // Verify boost occurred
    assert!(after_importance > before_importance);

    // Verify boost is reasonable (not too extreme)
    let delta = after_importance - before_importance;
    assert!(
        delta > 0.0 && delta < 0.5,
        "Boost should be moderate, got {}",
        delta
    );
}

#[test]
fn test_importance_decay_formula() {
    let (mut memory, _temp) = setup_memory_system();

    // Create memory with high importance
    let id = memory
        .remember(
            Experience {
                content: "High importance memory".to_string(),
                experience_type: ExperienceType::Decision,
                entities: vec!["critical".to_string()],
                ..Default::default()
            },
            None,
        )
        .unwrap();

    let before = memory.get_memory(&id).unwrap();
    let before_importance = before.importance();

    // Reinforce as misleading
    memory
        .reinforce_recall(&[id.clone()], RetrievalOutcome::Misleading)
        .unwrap();

    let after = memory.get_memory(&id).unwrap();
    let after_importance = after.importance();

    // Verify decay occurred
    assert!(after_importance < before_importance);

    // Verify decay is reasonable
    let delta = before_importance - after_importance;
    assert!(
        delta > 0.0 && delta < 0.5,
        "Decay should be moderate, got {}",
        delta
    );
}

// =============================================================================
// LONG-TERM POTENTIATION (LTP) TESTS
// =============================================================================

#[test]
fn test_ltp_after_multiple_reinforcements() {
    let (mut memory, _temp) = setup_memory_system();

    let id1 = memory
        .remember(create_experience("Pattern A observation"), None)
        .unwrap();
    let id2 = memory
        .remember(create_experience("Pattern A confirmation"), None)
        .unwrap();

    // Get initial importance
    let initial1 = memory.get_memory(&id1).unwrap().importance();
    let initial2 = memory.get_memory(&id2).unwrap().importance();

    let ids = vec![id1.clone(), id2.clone()];

    // Reinforce many times to trigger LTP (threshold is typically 3-5)
    // Each reinforcement adds +5% importance (clamped to 1.0)
    for _ in 0..10 {
        memory
            .reinforce_recall(&ids, RetrievalOutcome::Helpful)
            .unwrap();
    }

    // After LTP, associations should be very strong
    // This is tested by checking the memories have higher importance
    let mem1 = memory.get_memory(&id1).unwrap();
    let mem2 = memory.get_memory(&id2).unwrap();

    // Importance should have increased significantly after many reinforcements
    // With 10 reinforcements at +5% each, importance increases by 0.5 (capped at 1.0)
    assert!(
        mem1.importance() > initial1,
        "Repeated helpful feedback should increase importance (was {}, now {})",
        initial1,
        mem1.importance()
    );
    assert!(
        mem2.importance() > initial2,
        "Repeated helpful feedback should increase importance (was {}, now {})",
        initial2,
        mem2.importance()
    );

    // Verify significant boost: 10 reinforcements × HEBBIAN_BOOST_HELPFUL (0.025) = 0.25
    let expected_boost = 0.2; // Conservative: at least 0.2 of the theoretical 0.25
    assert!(
        mem1.importance() >= initial1 + expected_boost || mem1.importance() >= 0.95,
        "Importance should boost significantly: {} + {} vs {}",
        initial1,
        expected_boost,
        mem1.importance()
    );
}

// =============================================================================
// INTEGRATION WITH RETRIEVAL TESTS
// =============================================================================

#[test]
fn test_retrieve_then_reinforce_cycle() {
    let (mut memory, _temp) = setup_memory_system();

    // Record memories
    for i in 0..20 {
        memory
            .remember(
                create_experience(&format!("Warehouse zone {} status: operational", i)),
                None,
            )
            .unwrap();
    }

    // Retrieve some memories
    let query = Query {
        query_text: Some("warehouse zone status".to_string()),
        max_results: 5,
        ..Default::default()
    };

    let results = memory.recall(&query).unwrap();
    assert!(!results.is_empty());

    // Collect IDs from results
    let ids: Vec<_> = results.iter().map(|m| m.id.clone()).collect();

    // Reinforce
    let stats = memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();

    assert!(stats.memories_processed > 0);
}

#[test]
fn test_reinforced_memories_rank_higher() {
    let (mut memory, _temp) = setup_memory_system();

    // Record several memories about the same topic
    let id_target = memory
        .remember(
            create_experience("Target memory: critical safety protocol"),
            None,
        )
        .unwrap();

    for i in 0..10 {
        memory
            .remember(
                create_experience(&format!("Background memory {} about safety", i)),
                None,
            )
            .unwrap();
    }

    // Reinforce the target memory multiple times
    for _ in 0..5 {
        memory
            .reinforce_recall(&[id_target.clone()], RetrievalOutcome::Helpful)
            .unwrap();
    }

    // Retrieve and check if target ranks highly
    let query = Query {
        query_text: Some("safety protocol".to_string()),
        max_results: 5,
        ..Default::default()
    };

    let results = memory.recall(&query).unwrap();

    // Target should be in top results due to higher importance
    let target_found = results.iter().any(|m| m.id == id_target);
    assert!(
        target_found,
        "Reinforced memory should appear in top results"
    );
}

// =============================================================================
// EDGE CASE TESTS
// =============================================================================

#[test]
fn test_reinforce_same_memory_twice() {
    let (mut memory, _temp) = setup_memory_system();

    let id = memory
        .remember(create_experience("Duplicate test"), None)
        .unwrap();

    // Pass same ID twice
    let ids = vec![id.clone(), id.clone()];
    let stats = memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();

    // Should deduplicate or handle gracefully
    assert!(stats.memories_processed <= 2);
}

#[test]
fn test_alternating_feedback() {
    let (mut memory, _temp) = setup_memory_system();

    let id = memory
        .remember(create_experience("Alternating feedback test"), None)
        .unwrap();

    // Alternate helpful and misleading
    memory
        .reinforce_recall(&[id.clone()], RetrievalOutcome::Helpful)
        .unwrap();
    memory
        .reinforce_recall(&[id.clone()], RetrievalOutcome::Misleading)
        .unwrap();
    memory
        .reinforce_recall(&[id.clone()], RetrievalOutcome::Helpful)
        .unwrap();
    memory
        .reinforce_recall(&[id.clone()], RetrievalOutcome::Misleading)
        .unwrap();

    // Memory should still exist and be valid - get_memory returns Result<Memory>, success means it exists
    let mem = memory.get_memory(&id);
    assert!(
        mem.is_ok(),
        "Memory should still exist after alternating feedback"
    );
}

#[test]
fn test_high_volume_reinforcement() {
    let (mut memory, _temp) = setup_memory_system();

    // Record many memories
    let mut ids = Vec::new();
    for i in 0..100 {
        let id = memory
            .remember(
                create_experience(&format!("High volume memory {}", i)),
                None,
            )
            .unwrap();
        ids.push(id);
    }

    // Reinforce in batches
    for chunk in ids.chunks(10) {
        let chunk_ids: Vec<_> = chunk.to_vec();
        let stats = memory
            .reinforce_recall(&chunk_ids, RetrievalOutcome::Helpful)
            .unwrap();
        assert!(stats.memories_processed > 0);
    }
}

// =============================================================================
// HEBBIAN GRAPH PERSISTENCE TESTS
// =============================================================================

/// Test helper to create config for persistence tests
fn create_persistence_config(temp_dir: &tempfile::TempDir) -> MemoryConfig {
    MemoryConfig {
        storage_path: temp_dir.path().to_path_buf(),
        working_memory_size: 100,
        session_memory_size_mb: 50,
        max_heap_per_user_mb: 200,
        auto_compress: false,
        compression_age_days: 30,
        importance_threshold: 0.7,
    }
}

/// Create a MemorySystem with GraphMemory wired up (for persistence tests)
fn create_system_with_graph(config: MemoryConfig) -> MemorySystem {
    let graph_path = config.storage_path.join("graph");
    let mut system = MemorySystem::new(config, None).expect("Failed to create memory system");
    let graph_memory = GraphMemory::new(&graph_path, None).expect("Failed to create graph memory");
    system.set_graph_memory(Arc::new(shodh_memory::parking_lot::RwLock::new(
        graph_memory,
    )));
    system
}

#[test]
fn test_hebbian_graph_persists_across_restart() {
    let temp_dir = tempfile::TempDir::new().expect("Failed to create temp dir");
    let config = create_persistence_config(&temp_dir);

    let id1;
    let id2;
    let edge_count_before_restart;

    // Phase 1: Create memories and form associations
    {
        let mut memory = create_system_with_graph(config.clone());

        id1 = memory
            .remember(create_experience("Hebbian persistence test memory A"), None)
            .unwrap();
        id2 = memory
            .remember(create_experience("Hebbian persistence test memory B"), None)
            .unwrap();

        // Co-retrieve repeatedly. Under the shipped strengthen-only default
        // (see module note) this forms no memory-to-memory edges, so this test
        // can no longer reach the graph-durability question through
        // `reinforce_recall`. That question has NOT been dropped: it is held by
        // src/graph_memory.rs::coactivation_edges_survive_graph_reopen, which
        // seeds edges through `record_memory_coactivation_impl(&ids, false)`
        // and asserts they (and the `mem_edge:` pair index) survive a reopen of
        // the same store. What remains testable here is that a MemorySystem
        // restart is clean and that whatever the graph does hold survives it.
        //
        // Compared as a DELTA against the post-ingest snapshot, never as an
        // absolute zero: `edge_count` is the whole-graph relationship count and
        // this test does not control what entity-level ingest may have put in
        // the graph for these two memories.
        let edges_after_ingest = memory.graph_stats().edge_count;
        let ids = vec![id1.clone(), id2.clone()];
        for _ in 0..5 {
            memory
                .reinforce_recall(&ids, RetrievalOutcome::Helpful)
                .unwrap();
        }

        // Get graph stats before drop
        edge_count_before_restart = memory.graph_stats().edge_count;
        assert_eq!(
            edge_count_before_restart, edges_after_ingest,
            "five co-retrieval passes must form zero NEW memory-to-memory edges \
             under the shipped strengthen-only default: before={}, after={}",
            edges_after_ingest, edge_count_before_restart
        );
    }
    // System dropped - simulates restart

    // Phase 2: Verify persistence across the restart
    {
        let memory = create_system_with_graph(config);

        // Verify memories exist — the non-vacuous half of this test
        let mem1 = memory.get_memory(&id1).expect("Memory 1 should exist");
        let mem2 = memory.get_memory(&id2).expect("Memory 2 should exist");
        assert!(mem1.experience.content.contains("memory A"));
        assert!(mem2.experience.content.contains("memory B"));

        // The graph reopens with exactly the edge population it was closed
        // with: the restart must neither drop edges nor invent memory-to-memory
        // edges that co-retrieval never formed.
        let stats = memory.graph_stats();
        assert_eq!(
            stats.edge_count, edge_count_before_restart,
            "restart must preserve the edge count exactly: before={}, after={}",
            edge_count_before_restart, stats.edge_count
        );
    }
}

#[test]
fn test_hebbian_edge_strength_persists() {
    let temp_dir = tempfile::TempDir::new().expect("Failed to create temp dir");
    let config = create_persistence_config(&temp_dir);

    let id1;
    let id2;
    let avg_strength_before;

    // Phase 1: Create strong associations
    {
        let mut memory = create_system_with_graph(config.clone());

        id1 = memory
            .remember(create_experience("Edge strength test A"), None)
            .unwrap();
        id2 = memory
            .remember(create_experience("Edge strength test B"), None)
            .unwrap();

        // Co-retrieve many times. Under the shipped strengthen-only default
        // (see module note) no memory-to-memory edge is minted, so co-retrieval
        // accumulates no edge strength at all — `avg_strength` is unmoved by the
        // ten passes. The Hebbian strength-accumulation-and-persistence question
        // is held by
        // src/graph_memory.rs::coactivation_edge_strength_survives_graph_reopen,
        // which seeds an edge, strengthens it 9 more times through the DEFAULT
        // gate, and asserts the raised strength and activation_count come back
        // after a reopen.
        //
        // Compared against the post-ingest snapshot rather than against an
        // absolute 0.0, since this test does not control what entity-level
        // ingest may have put in the graph.
        let stats_after_ingest = memory.graph_stats();
        let ids = vec![id1.clone(), id2.clone()];
        for _ in 0..10 {
            memory
                .reinforce_recall(&ids, RetrievalOutcome::Helpful)
                .unwrap();
        }

        let stats = memory.graph_stats();
        avg_strength_before = stats.avg_strength;
        assert_eq!(
            stats.edge_count, stats_after_ingest.edge_count,
            "no NEW memory-to-memory edge is minted under the shipped default: \
             before={}, after={}",
            stats_after_ingest.edge_count, stats.edge_count
        );
        assert_eq!(
            avg_strength_before, stats_after_ingest.avg_strength,
            "ten co-retrieval passes must not move avg_strength when nothing \
             was wired: before={}, after={}",
            stats_after_ingest.avg_strength, avg_strength_before
        );
        // src/memory/mod.rs:8095 special-cases the empty relationship set to
        // (0.0, 0) instead of dividing 0/0 — pin that the summary is a real
        // number, never NaN, which is what makes it safe to read while the
        // coactivation layer is inert.
        assert!(
            avg_strength_before.is_finite(),
            "avg_strength must never be NaN/inf: {avg_strength_before}"
        );
    }

    // Phase 2: Verify the reported strength survives the restart unchanged
    {
        let memory = create_system_with_graph(config);

        // Memories themselves must persist — the non-vacuous half of this test.
        let mem1 = memory.get_memory(&id1).expect("Memory 1 should exist");
        assert!(mem1.experience.content.contains("Edge strength test A"));
        assert!(memory.get_memory(&id2).is_ok(), "Memory 2 should exist");

        let stats = memory.graph_stats();
        let avg_strength_after = stats.avg_strength;

        assert!(
            (avg_strength_after - avg_strength_before).abs() < 0.01,
            "Edge strength should persist: {} vs {} (diff: {})",
            avg_strength_after,
            avg_strength_before,
            (avg_strength_after - avg_strength_before).abs()
        );
    }
}

#[test]
fn test_coactivation_during_retrieve_forms_edges() {
    let (mut memory, _temp) = setup_memory_system();

    // Record memories
    let id1 = memory
        .remember(
            create_experience("Coactivation test: robot navigation"),
            None,
        )
        .unwrap();
    let id2 = memory
        .remember(
            create_experience("Coactivation test: robot obstacle avoidance"),
            None,
        )
        .unwrap();

    // Verify no edges initially
    let stats_before = memory.graph_stats();
    let edges_before = stats_before.edge_count;

    // Retrieve both memories together (should auto-coactivate)
    let query = Query {
        query_text: Some("robot navigation obstacle".to_string()),
        max_results: 10,
        ..Default::default()
    };
    let results = memory.recall(&query).unwrap();

    // The recall path runs its own Hebbian coactivation on the competition
    // winners (src/memory/mod.rs:5207) via the same
    // `record_memory_coactivation` entry point as `reinforce_recall`, so it is
    // subject to the same strengthen-only default: co-retrieval through
    // `recall()` also mints nothing. See the module note.
    let both_returned = results.iter().any(|m| m.id == id1) && results.iter().any(|m| m.id == id2);

    if both_returned {
        let stats_after = memory.graph_stats();
        assert_eq!(
            stats_after.edge_count, edges_before,
            "auto-coactivation on the recall path must mint zero NEW edges \
             under the shipped strengthen-only default: before={}, after={}",
            edges_before, stats_after.edge_count
        );
    }
}

#[test]
fn test_ltp_persists_across_restart() {
    let temp_dir = tempfile::TempDir::new().expect("Failed to create temp dir");
    let config = create_persistence_config(&temp_dir);

    let id1;
    let id2;
    let stats_before_restart;

    // Phase 1: Create LTP by many co-activations
    {
        let mut memory = create_system_with_graph(config.clone());

        id1 = memory
            .remember(create_experience("LTP persistence test A"), None)
            .unwrap();
        id2 = memory
            .remember(create_experience("LTP persistence test B"), None)
            .unwrap();

        // Co-retrieve many times. LTP is a property of an EDGE
        // (`RelationshipEdge::strengthen` -> `detect_ltp_status`), and under the
        // shipped strengthen-only default (see module note) no memory-to-memory
        // edge exists to potentiate, so `potentiated_count` stays 0. The
        // LTP-survives-restart question is held by
        // src/graph_memory.rs::coactivation_ltp_status_survives_graph_reopen,
        // which drives 15 co-activations onto a seeded edge and asserts the
        // resulting LTP status and strength come back after a reopen.
        //
        // Compared as a DELTA against the post-ingest snapshot, not against an
        // absolute zero — this test does not control entity-level ingest.
        let potentiated_after_ingest = memory.graph_stats().potentiated_count;
        let ids = vec![id1.clone(), id2.clone()];
        for _ in 0..15 {
            memory
                .reinforce_recall(&ids, RetrievalOutcome::Helpful)
                .unwrap();
        }

        stats_before_restart = memory.graph_stats();
        assert_eq!(
            stats_before_restart.potentiated_count, potentiated_after_ingest,
            "15 co-retrieval passes potentiate nothing NEW under the shipped \
             strengthen-only default — there is no memory-to-memory edge to \
             potentiate: before={}, after={}",
            potentiated_after_ingest, stats_before_restart.potentiated_count
        );
    }

    // Phase 2: Verify the restart preserves graph state exactly
    {
        let memory = create_system_with_graph(config);

        // Memories themselves must persist — the non-vacuous half of this test.
        assert!(memory.get_memory(&id1).is_ok(), "Memory 1 should exist");
        assert!(memory.get_memory(&id2).is_ok(), "Memory 2 should exist");

        let stats = memory.graph_stats();
        assert_eq!(
            (stats.edge_count, stats.potentiated_count),
            (
                stats_before_restart.edge_count,
                stats_before_restart.potentiated_count
            ),
            "restart must preserve edge/potentiated counts exactly and invent \
             neither: potentiated={}, avg_strength={}",
            stats.potentiated_count,
            stats.avg_strength
        );
    }
}

#[test]
fn test_graph_stats_accuracy() {
    let (mut memory, _temp) = setup_memory_system();

    // Record several memories
    let mut ids = Vec::new();
    for i in 0..5 {
        let id = memory
            .remember(
                create_experience(&format!("Graph stats test memory {}", i)),
                None,
            )
            .unwrap();
        ids.push(id);
    }

    // Co-retrieve all 5. Before 2026-07-10 this minted C(5,2) = 10 edges, which
    // this test used to assert (`edge_count >= 5`, `avg_strength > 0.0`). Under
    // the shipped strengthen-only default nothing is minted (see module note),
    // so what is checked here is that `graph_stats()` reports the EMPTY graph
    // accurately and consistently rather than producing a stale or NaN summary
    // — that accuracy is this test's actual subject.
    let stats_before = memory.graph_stats();
    memory
        .reinforce_recall(&ids, RetrievalOutcome::Helpful)
        .unwrap();

    let stats = memory.graph_stats();

    assert_eq!(
        stats.edge_count, stats_before.edge_count,
        "co-retrieving 5 memories with no prior edges must mint zero NEW edges: \
         before={}, after={}",
        stats_before.edge_count, stats.edge_count
    );
    // src/memory/mod.rs:8095 special-cases the empty relationship set to
    // (0.0, 0) instead of dividing 0/0. That is the accuracy contract that
    // still bites while the coactivation layer is inert: the summary must be a
    // real number, and must report exactly (0.0, 0) when there is nothing to
    // summarize.
    assert!(
        stats.avg_strength.is_finite(),
        "avg_strength must never be NaN/inf: {}",
        stats.avg_strength
    );
    if stats.edge_count == 0 {
        assert_eq!(
            stats.avg_strength, 0.0,
            "avg_strength must be exactly 0.0 for an empty relationship set: {}",
            stats.avg_strength
        );
        assert_eq!(
            stats.potentiated_count, 0,
            "potentiated_count must be 0 for an empty relationship set: {}",
            stats.potentiated_count
        );
    }
    assert!(
        stats.potentiated_count <= stats.edge_count,
        "potentiated_count ({}) can never exceed edge_count ({})",
        stats.potentiated_count,
        stats.edge_count
    );
    // The memories themselves were still stored — the graph being empty is a
    // property of the coactivation layer, not of ingest.
    assert_eq!(ids.len(), 5);
    for id in &ids {
        assert!(memory.get_memory(id).is_ok(), "memory {id:?} should exist");
    }
}
