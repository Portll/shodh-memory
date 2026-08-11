//! Fact Distillation Regression Tests
//!
//! Pins the fixes for the zero-facts investigation (2026-08-09): a realistic
//! corpus produced ZERO semantic facts in production, permanently, because of
//! two structural defects in the incremental extraction watermark:
//!
//! 1. THE BURN. Both `run_maintenance` and `distill_facts` filtered memories
//!    with `created_at > watermark`, ran the consolidator (which only
//!    processes memories at least `min_age_days` old), then advanced the
//!    watermark over everything the FILTER passed — including memories the
//!    age gate had excluded. A memory seen once while too young was excluded
//!    forever: with heavy maintenance every ~6h and a 7-day age floor, every
//!    memory on every live store was burned. Zero facts, structurally.
//!
//! 2. NO CROSS-BATCH CORROBORATION. `CONSOLIDATION_MIN_SUPPORT` requires the
//!    same pattern from >= 2 distinct memories, but sub-threshold clusters
//!    were not persisted, so support could only accumulate within a single
//!    watermark window. Two memories corroborating each other across cycles
//!    could never mint a fact.
//!
//! The fix removes the watermark entirely: extraction re-runs over the full
//! eligible corpus each cycle, and `SemanticFactStore::ingest_candidate`
//! makes re-derivation from already-counted evidence a no-op, so the re-scan
//! is idempotent. These tests fail against the watermark design.

use tempfile::TempDir;

use shodh_memory::memory::{Experience, ExperienceType, MemoryConfig, MemorySystem};

fn setup() -> (MemorySystem, TempDir) {
    let temp_dir = TempDir::new().expect("temp dir");
    let config = MemoryConfig {
        storage_path: temp_dir.path().to_path_buf(),
        working_memory_size: 50,
        session_memory_size_mb: 50,
        max_heap_per_user_mb: 200,
        auto_compress: false,
        compression_age_days: 30,
        importance_threshold: 0.3,
    };
    let system = MemorySystem::new(config, None).expect("memory system");
    (system, temp_dir)
}

/// A plain declarative memory — the shape the bulk of real corpora take.
/// Importance is pinned so cluster-representative selection is deterministic.
fn declarative(content: &str, importance: f32) -> Experience {
    Experience {
        content: content.to_string(),
        experience_type: ExperienceType::Observation,
        importance_override: Some(importance),
        ..Default::default()
    }
}

/// A creation timestamp `days` in the past, pinned to whole milliseconds so
/// timestamp round-trips through storage compare exactly.
fn days_ago(days: i64) -> chrono::DateTime<chrono::Utc> {
    let t = chrono::Utc::now() - chrono::Duration::days(days);
    chrono::DateTime::from_timestamp_millis(t.timestamp_millis()).expect("valid timestamp")
}

// ============================================================================
// DEFECT 1 — THE WATERMARK BURN
// ============================================================================

/// The exact sequence the MCP audit ran: seed a fresh store, consolidate with
/// default thresholds (min_age_days = 1 excludes everything seeded seconds
/// ago), then consolidate again with the age gate lifted.
///
/// Under the watermark design the FIRST call burned the corpus — the
/// watermark advanced past every memory the age gate had excluded — so the
/// second call saw an empty batch and returned zero even though every memory
/// was now eligible. An operator lowering min_age_days to zero after an empty
/// run got zero again, which is exactly what made the empty fact store look
/// like a "young corpus" instead of a defect.
#[test]
fn distill_retry_after_age_gated_run_still_mints() {
    let (system, _dir) = setup();
    let user = "burn-regression";

    system
        .remember(
            declarative(
                "The staging cluster runs on four nodes in the Frankfurt region.",
                0.9,
            ),
            None,
        )
        .expect("remember");
    system
        .remember(
            declarative(
                "The staging cluster in the Frankfurt region is running on four nodes.",
                0.8,
            ),
            None,
        )
        .expect("remember echo");

    // Default API thresholds: min_support 2, min_age_days 1. Nothing seeded
    // seconds ago is eligible — zero facts is CORRECT here (age policy).
    let first = system.distill_facts(user, 2, 1).expect("first distill");
    assert_eq!(
        first.facts_extracted, 0,
        "memories younger than min_age_days must not consolidate"
    );

    // The retry with the age gate lifted must see the memories the first call
    // could not process. The watermark design returned zero here, forever.
    let second = system.distill_facts(user, 2, 0).expect("second distill");
    assert!(
        second.facts_extracted >= 1,
        "an age-gated run must not consume the corpus: retry with \
         min_age_days=0 saw {} facts",
        second.facts_extracted
    );
    let facts = system.get_facts(user, 10).expect("facts");
    assert!(
        facts.iter().any(|f| f.fact.contains("four nodes")),
        "the minted fact must be the corroborated statement, got {facts:?}"
    );
}

/// Maintenance variant of the burn: a heavy cycle runs while the store holds
/// only ineligible (young) memories, then ELIGIBLE memories arrive (a
/// backfill/import with historical timestamps). The watermark left by the
/// first cycle sat at "now", so the backdated memories arrived already behind
/// it and were never extracted. Post-fix the next heavy cycle sees them.
#[test]
fn maintenance_extracts_memories_that_arrive_behind_a_prior_cycle() {
    let (system, _dir) = setup();
    let user = "maintenance-backfill";

    // A young memory; the heavy cycle that follows must not poison the store.
    system
        .remember(
            declarative("Deploy window for the search service is under review.", 0.5),
            None,
        )
        .expect("remember young");
    system
        .run_maintenance(1.0, user, true)
        .expect("heavy maintenance on young store");
    assert!(
        system.get_facts(user, 10).expect("facts").is_empty(),
        "nothing eligible yet"
    );

    // Backfill: corroborating memories with historical timestamps, older than
    // CONSOLIDATION_MIN_AGE_DAYS (7) — eligible immediately.
    system
        .remember(
            declarative(
                "The ingestion pipeline writes batches to the events topic every thirty seconds.",
                0.9,
            ),
            Some(days_ago(8)),
        )
        .expect("remember backfill");
    system
        .remember(
            declarative(
                "Every thirty seconds the ingestion pipeline writes batches into the events topic.",
                0.8,
            ),
            Some(days_ago(8)),
        )
        .expect("remember backfill echo");

    system
        .run_maintenance(1.0, user, true)
        .expect("heavy maintenance after backfill");

    let facts = system.get_facts(user, 10).expect("facts");
    assert!(
        facts.iter().any(|f| f.fact.contains("ingestion pipeline")),
        "a heavy cycle must extract eligible memories even when a previous \
         cycle already ran, got {facts:?}"
    );
}

// ============================================================================
// DEFECT 2 — CROSS-CYCLE CORROBORATION
// ============================================================================

/// Corroboration must be able to accumulate across consolidation cycles. A
/// statement seen once does not mint (that is the min_support policy); the
/// same claim arriving later from a DISTINCT memory is exactly the evidence
/// min_support asks for — and under the watermark design the two could never
/// meet in one batch, so the fact could never mint.
#[test]
fn corroboration_accumulates_across_distill_cycles() {
    let (system, _dir) = setup();
    let user = "cross-cycle";

    system
        .remember(
            declarative(
                "Payment retries were disabled on the checkout service after the duplicate charge incident.",
                0.9,
            ),
            None,
        )
        .expect("remember");
    let first = system.distill_facts(user, 2, 0).expect("first distill");
    assert_eq!(
        first.facts_extracted, 0,
        "a single uncorroborated statement must not mint a fact"
    );

    system
        .remember(
            declarative(
                "After the duplicate charge incident the checkout service has payment retries disabled.",
                0.8,
            ),
            None,
        )
        .expect("remember corroboration");
    let second = system.distill_facts(user, 2, 0).expect("second distill");
    assert!(
        second.facts_extracted >= 1,
        "corroboration arriving on a later cycle must mint the fact"
    );
    let facts = system.get_facts(user, 10).expect("facts");
    assert!(
        facts
            .iter()
            .any(|f| f.fact.to_lowercase().contains("payment retries")),
        "expected the corroborated claim, got {facts:?}"
    );
}

// ============================================================================
// CONTRADICTION ARBITRATION FROM A BULK-SEEDED STORE
// ============================================================================

/// A corpus seeded in one burst (the demo-store shape) that contains a claim,
/// its corroboration, and a later corrected report. One distillation pass must
/// mint both sides — polarity-aware clustering keeps a claim and its negation
/// in separate clusters — and arbitration must leave the correction active
/// and the claim invalidated.
///
/// Under the pre-fix pipeline this scenario produced either nothing (each
/// statement burned while young) or, when everything landed in one batch, a
/// SINGLE merged fact: the claim and its negation share enough stems to
/// exceed the Jaccard clustering threshold, so the correction was absorbed
/// into the claim's cluster and the contradiction machinery had nothing to
/// arbitrate.
#[test]
fn bulk_seeded_correction_supersedes_claim_in_one_pass() {
    let (system, _dir) = setup();
    let user = "bulk-correction";

    const CLAIM: &str =
        "Initial reports said four crew members were injured in the bridge collapse.";
    const CLAIM_ECHO: &str =
        "Early reports said four crew members were injured in the bridge collapse.";
    const CORRECTION: &str =
        "Corrected reports confirm no crew members were injured in the bridge collapse.";
    const CORRECTION_ECHO: &str =
        "Later reports confirm no crew members were injured in the bridge collapse.";

    system
        .remember(declarative(CLAIM, 0.9), Some(days_ago(40)))
        .expect("claim");
    system
        .remember(declarative(CLAIM_ECHO, 0.8), Some(days_ago(40)))
        .expect("claim echo");
    system
        .remember(declarative(CORRECTION, 0.9), Some(days_ago(20)))
        .expect("correction");
    system
        .remember(declarative(CORRECTION_ECHO, 0.8), Some(days_ago(20)))
        .expect("correction echo");

    let result = system.distill_facts(user, 2, 7).expect("distill");
    assert!(
        result.facts_extracted >= 2,
        "claim and correction must mint as separate facts, got {}",
        result.facts_extracted
    );

    let facts = system.get_facts(user, 20).expect("facts");
    let claim_fact = facts
        .iter()
        .find(|f| f.fact.contains("four crew members were injured"))
        .unwrap_or_else(|| panic!("claim fact missing, got {facts:?}"));
    let correction_fact = facts
        .iter()
        .find(|f| f.fact.contains("no crew members were injured"))
        .unwrap_or_else(|| panic!("correction fact missing, got {facts:?}"));

    assert!(
        correction_fact.is_active(),
        "the newer corrected report must be the active fact"
    );
    assert!(
        !claim_fact.is_active(),
        "the superseded claim must be invalidated, not deleted"
    );
    assert_eq!(
        claim_fact.invalidated_by.as_deref(),
        Some(correction_fact.id.as_str()),
        "the invalidation must point at the correction that displaced it"
    );
}

// ============================================================================
// IDEMPOTENCE — RE-SCANNING MUST NOT RATCHET
// ============================================================================

/// The watermark existed to stop re-derived facts from ratcheting confidence
/// and support forever. Its replacement is evidence-based idempotence in
/// `ingest_candidate`: re-derivation from already-counted source memories is
/// a no-op. Distilling the same corpus repeatedly must not change the store.
#[test]
fn repeated_distillation_is_idempotent() {
    let (system, _dir) = setup();
    let user = "idempotence";

    system
        .remember(
            declarative(
                "The telemetry exporter batches spans every five seconds by default.",
                0.9,
            ),
            Some(days_ago(8)),
        )
        .expect("remember");
    system
        .remember(
            declarative(
                "By default the telemetry exporter batches spans every five seconds.",
                0.8,
            ),
            Some(days_ago(8)),
        )
        .expect("remember echo");

    system.distill_facts(user, 2, 7).expect("first distill");
    let after_first = system.get_facts(user, 10).expect("facts");
    assert_eq!(after_first.len(), 1, "one corroborated fact expected");
    let baseline = after_first[0].clone();

    for _ in 0..3 {
        system.distill_facts(user, 2, 7).expect("re-distill");
    }
    let after_rescans = system.get_facts(user, 10).expect("facts");
    assert_eq!(
        after_rescans.len(),
        1,
        "re-scanning must not mint duplicates"
    );
    let rescanned = &after_rescans[0];
    assert_eq!(rescanned.id, baseline.id);
    assert_eq!(
        rescanned.support_count, baseline.support_count,
        "re-derivation from already-counted evidence must not ratchet support"
    );
    assert_eq!(
        rescanned.confidence, baseline.confidence,
        "re-derivation from already-counted evidence must not ratchet confidence"
    );
}
