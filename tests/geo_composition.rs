//! Geo composition test (Task 2 of the geotemporal plan).
//!
//! Composes `Query::geo_filter` with semantic retrieval: an in-radius memory
//! that is semantically UNRELATED to the query text must still surface via
//! the Layer 0.45 geo prefetch + additive pool injection, while the hard geo
//! predicate (`Query::matches`) at hydration must still exclude out-of-radius
//! and geo-less memories.
//!
//! A 3-memory corpus cannot discriminate this: `vector_top_k = query.max_results
//! * 3` (30 by default) trivially returns every memory in a tiny corpus
//! regardless of relevance, so the semantically-unrelated in-radius memory
//! rides in via the ordinary vector leg and the injection assertion passes
//! even with no engine change. `FILLER_COUNT` fillers crowd the natural
//! candidate window so only the Layer 0.45/4.46 injection path can surface it
//! — see the `FILLER_COUNT` doc comment below for the full argument.
//!
//! Storage lives under `std::env::temp_dir()` via `tempfile::TempDir`, NOT
//! under any OneDrive-watched path — the tantivy file-watcher corrupts
//! commits under watched directories (see the BM25 onedrive finding).

use shodh_memory::constants::{DEFAULT_MAX_RESULTS, MAX_GEO_PREFETCH_CANDIDATES};
use shodh_memory::memory::storage::SearchCriteria;
use shodh_memory::memory::{
    Experience, ExperienceType, ForgetCriteria, GeoFilter, MemoryConfig, MemorySystem, Query,
    RetrievalMode,
};
use tempfile::TempDir;

/// Regression test for the storage-layer geo index in isolation from the
/// rest of the retrieval pipeline: a memory's geohash index entry is written
/// synchronously as part of `remember()` (storage.rs `store_inner` calls
/// `update_indices` before returning), so `advanced_search(ByLocation)` must
/// find it immediately, with no consolidation/promotion delay. Layer 0.45's
/// prefetch depends on this holding — if this test ever regresses, the bug
/// is in storage/indexing, not in the Layer 0.45/4.46 wiring in
/// `semantic_retrieve_inner`.
#[test]
fn advanced_search_finds_geo_memory_synchronously() {
    let (system, _temp) = setup_memory_system();
    let inside = [39.2904, -76.6122, 0.0];
    store_with_geo(&system, "harbor patrol completed", Some(inside));

    let found = system
        .advanced_search(SearchCriteria::ByLocation {
            lat: 39.2904,
            lon: -76.6122,
            radius_meters: 25_000.0,
            limit: None,
        })
        .expect("advanced_search should succeed");

    let texts: Vec<&str> = found
        .iter()
        .map(|m| m.experience.content.as_str())
        .collect();
    assert!(
        texts.iter().any(|t| t.contains("harbor patrol")),
        "advanced_search(ByLocation) did not find the geo-tagged memory: {texts:?}"
    );
}

/// Create test memory system with storage under `std::env::temp_dir()`.
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

    let memory_system = MemorySystem::new(config, None).expect("Failed to create memory system");
    (memory_system, temp_dir)
}

/// Store a memory with optional geo_location `[lat, lon, alt]`.
fn store_with_geo(system: &MemorySystem, content: &str, geo: Option<[f64; 3]>) {
    let experience = Experience {
        content: content.to_string(),
        experience_type: ExperienceType::Observation,
        geo_location: geo,
        ..Default::default()
    };
    system
        .remember(experience, None)
        .expect("remember should succeed");
}

/// Store a memory with an explicit `importance_override`, so
/// `ForgetCriteria::LowImportance` can be used to soft-forget a specific,
/// deterministically-chosen memory without depending on the calculated
/// importance heuristic.
fn store_with_geo_and_importance(
    system: &MemorySystem,
    content: &str,
    geo: Option<[f64; 3]>,
    importance: f32,
) {
    let experience = Experience {
        content: content.to_string(),
        experience_type: ExperienceType::Observation,
        geo_location: geo,
        importance_override: Some(importance),
        ..Default::default()
    };
    system
        .remember(experience, None)
        .expect("remember should succeed");
}

/// Number of filler memories needed to push A (semantically unrelated to the
/// query) outside the natural vector-search candidate window.
///
/// `semantic_retrieve_inner`'s Layer 3 sets `vector_top_k = query.max_results
/// * 3` (mod.rs, grep "let vector_top_k ="); with `DEFAULT_MAX_RESULTS = 10`
/// that window is 30. In a bare 3-memory corpus, Vamana's kNN trivially
/// returns all 3 regardless of relevance (k > corpus size), so A enters the
/// fused pool via the ordinary vector leg and the injection assertion below
/// passes vacuously — verified empirically: the 3-memory version of this
/// test is GREEN even without the Layer 0.45/4.46 engine change. These
/// fillers are moderately relevant to the query (share one of
/// "bridge"/"inspection" but never the exact two-word phrase) so they rank
/// between B/C (exact-phrase match, stay in-pool so the real hydration
/// predicate is what excludes them) and A (zero lexical/semantic overlap,
/// pushed below rank 30). None contain "report" or "summary" — those
/// substrings are asserted absent from the final results.
const FILLER_COUNT: usize = 40;

// Three memories: (A) geo-tagged inside radius, semantically UNRELATED to query text;
// (B) geo-tagged outside radius, semantically related; (C) no geo, semantically related.
// Plus FILLER_COUNT geo-less, moderately-relevant filler memories so A cannot
// ride into the fused pool via the ordinary vector/BM25 legs (see FILLER_COUNT doc).
// Query: Hybrid mode, text matching B/C, geo_filter centered on A's location.
#[test]
fn hybrid_mode_geo_filter_composes() {
    let (system, _temp) = setup_memory_system();

    let inside = [39.2904, -76.6122, 0.0]; // Baltimore
    let outside = [51.5074, -0.1278, 0.0]; // London
    store_with_geo(&system, "harbor patrol completed", Some(inside)); // A
    store_with_geo(&system, "bridge inspection report", Some(outside)); // B
    store_with_geo(&system, "bridge inspection summary", None); // C

    for i in 0..FILLER_COUNT {
        let content = if i % 2 == 0 {
            format!(
                "traffic diverted while crews repaired the old stone bridge near the river, case {i}"
            )
        } else {
            format!("quarterly safety inspection completed for the downtown facility, case {i}")
        };
        store_with_geo(&system, &content, None);
    }

    let query = Query::builder()
        .query_text("bridge inspection")
        .retrieval_mode(RetrievalMode::Hybrid)
        .geo_filter(GeoFilter::new(39.2904, -76.6122, 25_000.0))
        .build();
    let results = system
        .recall_with_diagnostics(&query)
        .expect("recall should succeed");

    let texts: Vec<&str> = results
        .memories
        .iter()
        .map(|m| m.experience.content.as_str())
        .collect();
    // Hard predicate: B (outside radius) and C (no geo) MUST be excluded.
    assert!(
        !texts.iter().any(|t| t.contains("report")),
        "outside-radius memory leaked: {texts:?}"
    );
    assert!(
        !texts.iter().any(|t| t.contains("summary")),
        "geo-less memory leaked through geo filter: {texts:?}"
    );
    // Recall via injection: A is semantically unrelated to the query — it can only
    // arrive via the geo prefetch union. This is the recall-improvement assertion.
    assert!(
        texts.iter().any(|t| t.contains("harbor patrol")),
        "geo prefetch did not inject in-radius memory: {texts:?}"
    );
}

/// Filler count for `geo_prefetch_respects_candidate_cap`, same discipline as
/// `FILLER_COUNT` above (review finding: the first version of this test was
/// vacuous). With no fillers, all `cap + 1` "sensor ping N" memories are the
/// *entire* corpus, so `vector_top_k = query.max_results * 3 = 30` — barely
/// smaller than the 31-memory corpus — lets the ordinary vector leg admit
/// nearly all of them regardless of geo distance or the cap logic; whichever
/// one the ANN's own tie-breaking happens to drop is unrelated to which one
/// Layer 0.45's cap is supposed to drop, so the test could pass whether the
/// cap works, is broken, or is deleted. These fillers are moderately
/// relevant to the query ("wildlife"/"survey", never the exact phrase) so
/// they outrank the zero-overlap "sensor ping N" entries on the ordinary
/// vector/BM25 legs, push all `cap + 1` of them below `vector_top_k`, and
/// make geo injection the *only* path any "sensor ping" content can reach
/// results through — confirmed empirically below (temporarily neutralizing
/// the cap flips this test red, restoring it flips back to green).
const CAP_TEST_FILLER_COUNT: usize = 40;

/// Verifies Layer 0.45's prefetch cap (`MAX_GEO_PREFETCH_CANDIDATES`, review
/// finding on this task): `search_by_location` must bound its candidate set
/// BEFORE hydrating anything (storage.rs), not after — a stale cap enforced
/// only on the already-hydrated `Vec<Memory>` would still fetch every
/// in-radius memory from RocksDB regardless of corpus size within the
/// radius.
///
/// Stores `cap + 1` in-radius memories at strictly increasing haversine
/// distance from the query center (`lat = base + i * 0.001`, i.e. ~111m
/// steps — see `haversine_distance`), all semantically unrelated to the
/// query text (so they can only ever surface via geo injection, never the
/// ordinary vector/BM25 legs — see `CAP_TEST_FILLER_COUNT` doc for why
/// filler crowding is required to make this true), plus `CAP_TEST_FILLER_COUNT`
/// geo-less fillers crowding the ordinary candidate window. Layer 0.45
/// selects the nearest `cap` by distance (ties broken by MemoryId) before
/// injecting, so the single farthest ("sensor ping {cap}", index `cap`, one
/// step beyond the cap boundary) must never reach the fused pool and
/// therefore can never appear in results — a real, deterministic assertion
/// of the cap's effect, not an inference from aggregate counts. All `cap`
/// in-cap candidates share the same GEO_INJECT_FLOOR score, so final ranking
/// among them is by MemoryId tie-break (arbitrary distance-wise) — this test
/// does not assert which of the nearest `cap` appear, only that the
/// cap-excluded one never does, and that capping still leaves room for real
/// results (correctness preserved).
#[test]
fn geo_prefetch_respects_candidate_cap() {
    let (system, _temp) = setup_memory_system();

    let cap = DEFAULT_MAX_RESULTS * MAX_GEO_PREFETCH_CANDIDATES;
    let base_lat = 39.2904_f64;
    let base_lon = -76.6122_f64;

    // cap + 1 memories inside the radius, strictly increasing distance from
    // the query center. Index `cap` (the (cap+1)-th, farthest) must be
    // excluded from the prefetch's cap.
    for i in 0..=cap {
        let lat = base_lat + (i as f64) * 0.001; // ~111m per step
        store_with_geo(
            &system,
            &format!("sensor ping {i}"),
            Some([lat, base_lon, 0.0]),
        );
    }

    // Crowd the ordinary vector/BM25 window so none of the sensor-ping
    // memories above can enter it — see CAP_TEST_FILLER_COUNT doc comment.
    for i in 0..CAP_TEST_FILLER_COUNT {
        let content = if i % 2 == 0 {
            format!("annual wildlife population count near the nature reserve, case {i}")
        } else {
            format!("ecological survey team documented species migration patterns, case {i}")
        };
        store_with_geo(&system, &content, None);
    }

    let query = Query::builder()
        .query_text("wildlife survey") // shares no terms with "sensor ping N"
        .retrieval_mode(RetrievalMode::Hybrid)
        .geo_filter(GeoFilter::new(base_lat, base_lon, 5_000.0)) // covers all cap+1 points (~111*cap m spread)
        .build();
    let results = system
        .recall_with_diagnostics(&query)
        .expect("recall should succeed");

    let texts: Vec<&str> = results
        .memories
        .iter()
        .map(|m| m.experience.content.as_str())
        .collect();

    // (b) cap respected: the cap-excluded farthest memory must never appear.
    let excluded_marker = format!("sensor ping {cap}");
    assert!(
        !texts.iter().any(|t| t.contains(&excluded_marker)),
        "cap-excluded farthest memory leaked past MAX_GEO_PREFETCH_CANDIDATES: {texts:?}"
    );

    // (a) results still correct: capping must not break injection entirely —
    // some in-cap, semantically-unrelated sensor-ping memory must still
    // surface via the geo prefetch (fillers dominate the ordinary legs, so
    // any "sensor ping" presence can only come from geo injection).
    assert!(
        texts.iter().any(|t| t.contains("sensor ping")),
        "capped geo prefetch surfaced nothing: {texts:?}"
    );
}

/// Regression coverage for `RetrievalMode::Spatial` (`spatial_search`,
/// retrieval.rs), the other `SearchCriteria::ByLocation` construction site
/// touched by the review-finding-1 fix (passes `limit: None` deliberately,
/// preserving pre-fix behavior). No test in this repo previously exercised
/// `spatial_search` end-to-end against a live store (only JSON-deserialize
/// and field-construction tests existed) — added here rather than assumed
/// safe by inspection alone, since this is the exact call site the fix
/// touched.
///
/// Also exercises `search_by_location`'s new always-sort-by-approx-distance
/// behavior with `limit: None`: even though `spatial_search` re-sorts by
/// EXACT distance itself after hydration (so the id order `search_by_location`
/// returns is not directly observable), this confirms the combination still
/// produces correct nearest-first, radius-filtered, limit-truncated results.
#[test]
fn spatial_mode_still_filters_sorts_and_limits() {
    let (system, _temp) = setup_memory_system();

    let base_lat = 39.2904_f64;
    let base_lon = -76.6122_f64;
    // Three in-radius memories at increasing distance, one clearly outside.
    store_with_geo(&system, "nearest site", Some([base_lat, base_lon, 0.0]));
    store_with_geo(
        &system,
        "middle site",
        Some([base_lat + 0.01, base_lon, 0.0]),
    ); // ~1.1km
    store_with_geo(&system, "far site", Some([base_lat + 0.02, base_lon, 0.0])); // ~2.2km
    store_with_geo(&system, "outside site", Some([51.5074, -0.1278, 0.0])); // London — far outside radius

    let query = Query::builder()
        // Spatial mode still requires query_text: `recall_inner` only routes
        // into `semantic_retrieve_inner` (where the Spatial short-circuit
        // that delegates to `spatial_search` lives) when `query_text` is
        // `Some` — production Spatial callers always send one alongside
        // lat/lon (see the zenoh spatial-recall fixture: `"query": "obstacles
        // near entrance"`). Omitting it here would instead take
        // `recall_inner`'s generic filter-based branch, which re-sorts by
        // importance/temporal relevance and does not exercise `spatial_search`
        // at all — confirmed by instrumentation while writing this test.
        .query_text("obstacles near entrance")
        .retrieval_mode(RetrievalMode::Spatial)
        .geo_filter(GeoFilter::new(base_lat, base_lon, 5_000.0)) // covers the 3 in-radius sites, excludes London
        .max_results(2)
        .build();
    let results = system
        .recall_with_diagnostics(&query)
        .expect("spatial recall should succeed");

    let texts: Vec<&str> = results
        .memories
        .iter()
        .map(|m| m.experience.content.as_str())
        .collect();

    assert_eq!(
        texts.len(),
        2,
        "spatial mode should truncate to max_results: {texts:?}"
    );
    assert!(
        !texts.iter().any(|t| t.contains("outside site")),
        "out-of-radius memory leaked into spatial results: {texts:?}"
    );
    assert!(
        !texts.iter().any(|t| t.contains("far site")),
        "spatial mode should keep the two NEAREST sites, not the farthest: {texts:?}"
    );
    assert_eq!(
        texts[0], "nearest site",
        "spatial mode should rank nearest-first: {texts:?}"
    );
}

/// Verifies review finding 2 (round 3): soft-forget (`ForgetCriteria::LowImportance`
/// / `OlderThan`) must remove the memory's `geo:` index entry, or a
/// soft-forgotten in-radius memory silently consumes one of
/// `search_by_location`'s `MAX_GEO_PREFETCH_CANDIDATES` cap slots and
/// displaces a live memory that would otherwise have survived the cap on
/// its own merits.
///
/// Tests the storage-layer mechanism directly via `advanced_search` with an
/// explicit small `limit` (the same call shape Layer 0.45 uses), rather
/// than through the full Hybrid retrieval pipeline: past the cap, every
/// live in-cap candidate is injected at the same flat `GEO_INJECT_FLOOR`
/// score and tie-broken by `MemoryId` for final ranking, so "did memory X
/// survive the cap" is not reliably observable from a top-`max_results`
/// results list alone (which of ~30 equal-score candidates lands in the
/// top 10 is arbitrary). The direct storage call has no such ambiguity:
/// `LongTermMemory::search`'s hydration loop drops forgotten memories
/// (`!memory.is_forgotten()`) unconditionally, so if the soft-forgotten
/// memory's geo index entry isn't removed at forget-time, it still counts
/// toward the `limit` nearest candidates `search_by_location` selects —
/// and since it's placed at the exact query center (nearest of all), it
/// bumps the single FARTHEST live memory out of the cap entirely (not
/// merely "absent from a later tie-break" — never even attempted).
#[test]
fn soft_forgotten_memory_does_not_consume_geo_cap_slot() {
    let (system, _temp) = setup_memory_system();

    let base_lat = 39.2904_f64;
    let base_lon = -76.6122_f64;
    const CAP_N: usize = 5;

    // CAP_N live, high-importance in-radius memories at increasing distance
    // (none at the exact center — that's reserved for the forgotten one).
    for i in 0..CAP_N {
        let lat = base_lat + (i as f64 + 1.0) * 0.001; // ~111m, ~222m, ...
        store_with_geo_and_importance(
            &system,
            &format!("beacon {i}"),
            Some([lat, base_lon, 0.0]),
            0.9,
        );
    }

    // One NEARER (exact query center — distance 0, nearest of all),
    // low-importance memory. Soft-forgotten below.
    store_with_geo_and_importance(
        &system,
        "will be forgotten",
        Some([base_lat, base_lon, 0.0]),
        0.05,
    );

    let forgotten_count = system
        .forget(ForgetCriteria::LowImportance(0.5))
        .expect("forget should succeed");
    assert_eq!(
        forgotten_count, 1,
        "expected to soft-forget exactly the one low-importance memory"
    );

    let found = system
        .advanced_search(SearchCriteria::ByLocation {
            lat: base_lat,
            lon: base_lon,
            radius_meters: 5_000.0,
            limit: Some(CAP_N), // mirrors Layer 0.45's cap call shape
        })
        .expect("advanced_search should succeed");

    let texts: Vec<&str> = found
        .iter()
        .map(|m| m.experience.content.as_str())
        .collect();

    assert!(
        !texts.iter().any(|t| t.contains("will be forgotten")),
        "soft-forgotten memory leaked into results: {texts:?}"
    );
    assert_eq!(
        texts.len(),
        CAP_N,
        "soft-forgotten memory silently consumed a cap slot, excluding a live memory: {texts:?}"
    );
    for i in 0..CAP_N {
        let marker = format!("beacon {i}");
        assert!(
            texts.iter().any(|t| t.contains(&marker)),
            "expected live memory '{marker}' missing (cap slot likely consumed by the forgotten one): {texts:?}"
        );
    }
}
