//! Feedback-momentum writes on the reinforcement path.
//!
//! `feedback_multiplier` in `ScoreAttribution` reads the momentum EMA, so
//! momentum is the ranking factor that means "this memory proved useful".
//! `MemorySystem::reinforce_recall` is what moves it — and it is reached two
//! different ways:
//!
//! 1. **Explicitly**, by a caller asserting an outcome: `POST /api/reinforce`,
//!    the seat harness confirming a tool-recalled memory, the eval harnesses.
//!    Nothing else has touched momentum for those memories, so the call owns
//!    the write.
//! 2. **Implicitly**, as the second stage of `proactive_context`, which has
//!    already applied its own graded, confidence-weighted signal per memory and
//!    only then classifies them into helpful/misleading buckets to reinforce.
//!
//! These tests pin that distinction: the explicit path moves momentum in the
//! right direction for each outcome, and the implicit path lands exactly ONE
//! signal per memory rather than two.

use std::sync::Arc;

use parking_lot::RwLock;
use tempfile::TempDir;

use shodh_memory::memory::{
    types::{Experience, ExperienceType},
    FeedbackStore, MemoryConfig, MemoryId, MemorySystem, MomentumPolicy, RetrievalOutcome,
    SignalRecord, SignalTrigger,
};

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

/// A memory system with a feedback store wired up, exactly as
/// `AppState::create_user_memory` does via `set_feedback_store`.
fn system_with_feedback() -> (MemorySystem, Arc<RwLock<FeedbackStore>>, TempDir) {
    let temp_dir = TempDir::new().expect("temp dir");
    let config = MemoryConfig {
        storage_path: temp_dir.path().to_path_buf(),
        working_memory_size: 100,
        session_memory_size_mb: 50,
        max_heap_per_user_mb: 500,
        auto_compress: false,
        compression_age_days: 7,
        importance_threshold: 0.3,
    };
    let mut system = MemorySystem::new(config, None).expect("memory system");
    let store = Arc::new(RwLock::new(FeedbackStore::new()));
    system.set_feedback_store(store.clone());
    (system, store, temp_dir)
}

fn remember(system: &mut MemorySystem, content: &str) -> MemoryId {
    let exp = Experience {
        experience_type: ExperienceType::Learning,
        content: content.to_string(),
        ..Default::default()
    };
    system.remember(exp, None).expect("remember")
}

/// The graded signal `proactive_context` phase 3 applies before it classifies
/// memories into helpful/misleading buckets. Entity overlap of 0.8 is well
/// above the "strong" threshold, so this classifies as helpful — the same
/// memory would then be passed to `reinforce_recall`.
fn graded_implicit_signal() -> SignalRecord {
    SignalRecord::from_entity_overlap(0.8)
}

// ============================================================================
// EXPLICIT REINFORCEMENT MOVES MOMENTUM
// ============================================================================

#[test]
fn explicit_helpful_reinforcement_moves_momentum_positive() {
    let (mut system, store, _tmp) = system_with_feedback();
    let id = remember(&mut system, "Vamando graph traversal uses beam search");

    assert!(
        store.read().get_momentum(&id).is_none(),
        "no momentum should exist before any feedback"
    );

    system
        .reinforce_recall(std::slice::from_ref(&id), RetrievalOutcome::Helpful)
        .expect("reinforce");

    let momentum = store
        .read()
        .get_momentum(&id)
        .expect("explicit reinforcement must create momentum");

    assert!(
        momentum.ema > 0.0,
        "helpful reinforcement must move momentum positive, got {}",
        momentum.ema
    );
    assert_eq!(momentum.signal_count, 1, "exactly one signal recorded");
}

#[test]
fn explicit_misleading_reinforcement_moves_momentum_negative() {
    let (mut system, store, _tmp) = system_with_feedback();
    let id = remember(&mut system, "Vamana alpha is applied during construction");

    system
        .reinforce_recall(std::slice::from_ref(&id), RetrievalOutcome::Misleading)
        .expect("reinforce");

    let momentum = store.read().get_momentum(&id).expect("momentum");

    assert!(
        momentum.ema < 0.0,
        "misleading reinforcement must move momentum negative, got {}",
        momentum.ema
    );
    assert_eq!(momentum.signal_count, 1);
}

#[test]
fn explicit_neutral_reinforcement_writes_no_momentum() {
    // Neutral means "access recorded", not "proved useful either way". An EMA
    // whose entire range is about usefulness should not move on no evidence.
    let (mut system, store, _tmp) = system_with_feedback();
    let id = remember(&mut system, "Neutral observation with no outcome");

    system
        .reinforce_recall(std::slice::from_ref(&id), RetrievalOutcome::Neutral)
        .expect("reinforce");

    assert!(
        store.read().get_momentum(&id).is_none(),
        "neutral must not create a momentum entry"
    );
}

#[test]
fn explicit_reinforcement_records_the_explicit_outcome_trigger() {
    // The trigger is what identifies WHICH path wrote a signal. Every other
    // variant records an inference the system drew; this one records an
    // assertion a caller made. `TemporalCredit` — what this used to record — is
    // multi-turn discounted credit, which an explicit call is not.
    let (mut system, store, _tmp) = system_with_feedback();
    let id = remember(&mut system, "Explicit outcome trigger provenance");

    system
        .reinforce_recall(std::slice::from_ref(&id), RetrievalOutcome::Helpful)
        .expect("reinforce");

    let momentum = store.read().get_momentum(&id).expect("momentum");
    let signal = momentum
        .recent_signals
        .back()
        .expect("a signal was recorded");

    match &signal.trigger {
        SignalTrigger::ExplicitOutcome { outcome } => assert_eq!(outcome, "helpful"),
        other => panic!("expected ExplicitOutcome trigger, got {other:?}"),
    }
}

#[test]
fn repeated_explicit_reinforcement_accumulates_momentum() {
    // Momentum, not forcing: one call nudges, repeated use builds. The EMA is
    // inertia-damped so it must rise monotonically without saturating on the
    // first signal.
    let (mut system, store, _tmp) = system_with_feedback();
    let id = remember(&mut system, "Repeatedly useful memory");

    let mut previous = 0.0_f32;
    for round in 1..=5 {
        system
            .reinforce_recall(std::slice::from_ref(&id), RetrievalOutcome::Helpful)
            .expect("reinforce");
        let ema = store.read().get_momentum(&id).expect("momentum").ema;
        assert!(
            ema > previous,
            "round {round}: EMA must increase, {previous} -> {ema}"
        );
        assert!(ema < 1.0, "round {round}: EMA must not saturate, got {ema}");
        previous = ema;
    }
}

// ============================================================================
// THE IMPLICIT PATH LANDS EXACTLY ONE SIGNAL
// ============================================================================

#[test]
fn implicit_path_applies_exactly_one_momentum_signal() {
    // Reproduces the `proactive_context` sequence: phase 3 applies the graded
    // signal, then the classified ids are handed to reinforce_recall. With
    // MomentumPolicy::Skip the reinforcement stage must not add a second signal
    // for the same piece of evidence.
    let (mut system, store, _tmp) = system_with_feedback();
    let id = remember(&mut system, "Surfaced by proactive context");

    // Phase 3: graded momentum update (recall.rs applies this itself).
    let graded = graded_implicit_signal();
    let ema_after_graded = {
        let mut guard = store.write();
        let momentum = guard.get_or_create_momentum(id.clone(), ExperienceType::Context);
        momentum.update(graded);
        momentum.ema
    };

    // Reinforcement stage: importance/graph updates only, momentum already done.
    system
        .reinforce_recall_with_momentum(
            std::slice::from_ref(&id),
            RetrievalOutcome::Helpful,
            MomentumPolicy::Skip,
        )
        .expect("reinforce");

    let momentum = store.read().get_momentum(&id).expect("momentum");
    assert_eq!(
        momentum.signal_count, 1,
        "one observation must produce one momentum signal, not two"
    );
    assert_eq!(
        momentum.ema, ema_after_graded,
        "the graded EMA must survive the reinforcement stage untouched"
    );
    assert!(
        matches!(
            momentum.recent_signals.back().map(|s| &s.trigger),
            Some(SignalTrigger::EntityOverlap { .. })
        ),
        "the surviving signal must be the graded implicit one, not an explicit outcome"
    );
}

#[test]
fn apply_policy_would_double_count_the_implicit_path() {
    // The control for the test above: this is precisely what the implicit path
    // did before it passed Skip. It is pinned so that anyone reverting the
    // policy argument sees the second signal appear, rather than silently
    // charging one observation twice.
    let (mut system, store, _tmp) = system_with_feedback();
    let id = remember(&mut system, "Would be double counted");

    {
        let mut guard = store.write();
        let momentum = guard.get_or_create_momentum(id.clone(), ExperienceType::Context);
        momentum.update(graded_implicit_signal());
    }

    system
        .reinforce_recall_with_momentum(
            std::slice::from_ref(&id),
            RetrievalOutcome::Helpful,
            MomentumPolicy::Apply,
        )
        .expect("reinforce");

    let momentum = store.read().get_momentum(&id).expect("momentum");
    assert_eq!(
        momentum.signal_count, 2,
        "Apply after a graded signal is a second hit — the behaviour Skip exists to prevent"
    );
}

#[test]
fn skip_policy_still_performs_importance_reinforcement() {
    // Skip must suppress ONLY the momentum write. The implicit path still needs
    // importance boosts, coactivation and entity-edge Hebbian updates.
    let (mut system, store, _tmp) = system_with_feedback();
    let id = remember(&mut system, "Importance still moves under skip");

    let stats = system
        .reinforce_recall_with_momentum(
            std::slice::from_ref(&id),
            RetrievalOutcome::Helpful,
            MomentumPolicy::Skip,
        )
        .expect("reinforce");

    assert_eq!(
        stats.importance_boosts, 1,
        "importance must still be boosted"
    );
    assert!(
        store.read().get_momentum(&id).is_none(),
        "skip must not create a momentum entry"
    );
}

// ============================================================================
// DURABILITY
// ============================================================================

#[test]
fn explicit_reinforcement_momentum_survives_restart() {
    // `mark_dirty` alone only queues a write, and `flush` is called exclusively
    // from the proactive_context side. A deployment driven purely through
    // POST /api/reinforce never flushes, so momentum has to be written through
    // at reinforcement time or it dies with the process.
    let store_dir = TempDir::new().expect("temp dir");
    let system_dir = TempDir::new().expect("temp dir");

    let id = {
        let config = MemoryConfig {
            storage_path: system_dir.path().to_path_buf(),
            working_memory_size: 100,
            session_memory_size_mb: 50,
            max_heap_per_user_mb: 500,
            auto_compress: false,
            compression_age_days: 7,
            importance_threshold: 0.3,
        };
        let mut system = MemorySystem::new(config, None).expect("memory system");
        let store = Arc::new(RwLock::new(
            FeedbackStore::with_persistence(store_dir.path()).expect("persistent store"),
        ));
        system.set_feedback_store(store.clone());

        let id = remember(&mut system, "Reinforced only through the explicit API");
        system
            .reinforce_recall(std::slice::from_ref(&id), RetrievalOutcome::Helpful)
            .expect("reinforce");

        // No flush() anywhere — that is the point of the test.
        id
    };
    // Both the system and the store are dropped here, releasing the DB lock.

    let reopened = FeedbackStore::with_persistence(store_dir.path()).expect("reopen store");
    let momentum = reopened
        .get_momentum(&id)
        .expect("momentum must survive restart without an explicit flush");

    assert!(
        momentum.ema > 0.0,
        "restored momentum must retain the helpful signal, got {}",
        momentum.ema
    );
    assert_eq!(momentum.signal_count, 1);
}
