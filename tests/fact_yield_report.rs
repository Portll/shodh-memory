//! Fact-yield instrument.
//!
//! The zero-facts defect (see tests/fact_distillation_tests.rs) went
//! unnoticed for months because NOTHING measured what distillation produces:
//! `search_facts` returning nothing was explained away as "young corpus" on
//! stores where consolidation had already run. This harness is the
//! measurement that was missing. It seeds a store from a recall fixture
//! corpus, runs distillation, and reports:
//!
//!   * facts per 100 memories (yield),
//!   * active vs invalidated counts (is arbitration ever exercised?),
//!   * the full fact list, so quality is hand-checkable in the test output.
//!
//! It pins INVARIANTS (eligibility, idempotence), not yields: yield numbers
//! are a property of corpus content and extraction policy, and pinning them
//! would turn every deliberate policy change into a test-fixing chore. The
//! printed report is the instrument; read it when extraction behaviour is in
//! question.
//!
//! Known quality reading as of 2026-08-09 (record updated observations in
//! the commit message when they change):
//!   * shodh-smoke (80 engineering-log memories): 0 facts — the corpus
//!     restates nothing, so corroboration (min_support >= 2 distinct
//!     memories) never fires. Zero is the policy, not a plumbing failure;
//!     the report's `memories eligible` line is what distinguishes the two.
//!   * locomo-gate (629 conversational memories, `--ignored`, ~3-6 min):
//!     4 facts, byte-identical across repeat runs (clustering is
//!     deterministic). Three are corroborated pleasantries ("Nate: Wow,
//!     that looks great Joanna", 16 sources) — on dialog corpora,
//!     repetition (the corroboration signal) selects small talk, and
//!     speaker-prefixed interjections pass `is_fact_shaped`. The fourth
//!     ("I won a really big video game tournament last week", 4 sources)
//!     clusters DIFFERENT tournament wins into one claim. Distillation
//!     over conversation needs discourse-aware extraction, not a lower
//!     support bar.

use tempfile::TempDir;

use shodh_memory::memory::{Experience, ExperienceType, MemoryConfig, MemorySystem};

fn setup() -> (MemorySystem, TempDir) {
    let temp_dir = TempDir::new().expect("temp dir");
    let config = MemoryConfig {
        storage_path: temp_dir.path().to_path_buf(),
        working_memory_size: 50,
        session_memory_size_mb: 50,
        max_heap_per_user_mb: 500,
        auto_compress: false,
        compression_age_days: 3650,
        importance_threshold: 0.3,
    };
    let system = MemorySystem::new(config, None).expect("memory system");
    (system, temp_dir)
}

fn exp_type(s: &str) -> ExperienceType {
    match s {
        "conversation" => ExperienceType::Conversation,
        "decision" => ExperienceType::Decision,
        "learning" => ExperienceType::Learning,
        "task" => ExperienceType::Task,
        "error" => ExperienceType::Error,
        "discovery" => ExperienceType::Discovery,
        "pattern" => ExperienceType::Pattern,
        _ => ExperienceType::Observation,
    }
}

/// Seed a store from a recall-fixture corpus (jsonl with content,
/// memory_type, created_at), preserving fixture timestamps so the corpus is
/// age-eligible exactly as it would be on a mature store.
fn seed_corpus(system: &MemorySystem, path: &str) -> usize {
    let corpus =
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("fixture corpus {path}: {e}"));
    let mut n = 0usize;
    for line in corpus.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(line).expect("jsonl line");
        let content = v["content"].as_str().expect("content").to_string();
        let mtype = v["memory_type"].as_str().unwrap_or("observation");
        let created_at = v["created_at"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&chrono::Utc));
        let e = Experience {
            content,
            experience_type: exp_type(mtype),
            ..Default::default()
        };
        system.remember(e, created_at).expect("remember");
        n += 1;
    }
    n
}

fn report(system: &MemorySystem, user: &str, corpus: &str, seeded: usize) {
    let result = system.distill_facts(user, 2, 7).expect("distill");
    let facts = system.get_facts(user, 1000).expect("facts");
    let active = facts.iter().filter(|f| f.is_active()).count();
    let invalidated = facts.len() - active;

    println!("── fact yield: {corpus} ──");
    println!("memories seeded:        {seeded}");
    println!("memories eligible:      {}", result.memories_eligible);
    println!("facts stored:           {}", facts.len());
    println!("  active:               {active}");
    println!("  invalidated:          {invalidated}");
    println!(
        "yield (facts per 100):  {:.2}",
        facts.len() as f64 * 100.0 / seeded.max(1) as f64
    );
    for f in &facts {
        println!(
            "  [{:?}][active={}][sources={}][conf={:.2}] {}",
            f.fact_type,
            f.is_active(),
            f.source_memories.len(),
            f.confidence,
            f.fact
        );
    }

    // Invariants — the properties that must hold regardless of corpus:
    // a mature corpus is fully eligible, and re-distilling is a no-op.
    assert_eq!(
        result.memories_eligible, seeded,
        "a fixture corpus with historical timestamps must be fully eligible"
    );
    let before = facts.len();
    system.distill_facts(user, 2, 7).expect("re-distill");
    let after = system.get_facts(user, 1000).expect("facts").len();
    assert_eq!(
        before, after,
        "re-distilling the same corpus must not change the fact count"
    );
}

/// Engineering-log corpus — the domain the specialist extractors (procedure,
/// definition, error-pattern, preference) were written for.
#[test]
fn smoke_corpus_fact_yield_report() {
    let (system, _dir) = setup();
    let seeded = seed_corpus(&system, "tests/recall/corpora/shodh-smoke.jsonl");
    report(
        &system,
        "yield-smoke",
        "shodh-smoke (engineering log)",
        seeded,
    );
}

/// Conversational corpus (LoCoMo gate). ~2 minutes: 629 memories are embedded
/// through the real ONNX encoder at remember() time. Run on demand:
/// `cargo test --test fact_yield_report -- --ignored --nocapture`
#[test]
#[ignore = "measurement harness, ~2 min of ONNX embedding — run with --ignored when extraction behaviour is in question"]
fn locomo_gate_fact_yield_report() {
    let (system, _dir) = setup();
    let seeded = seed_corpus(&system, "tests/recall/corpora/locomo-gate.jsonl");
    report(
        &system,
        "yield-locomo",
        "locomo-gate (conversation)",
        seeded,
    );
}
