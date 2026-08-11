//! Toponym linking: place mentions resolved to coordinates, kept strictly
//! apart from where a memory was recorded.
//!
//! Three things are pinned here:
//!
//! 1. **Resolution is correct and deterministic**, including the
//!    population-weighted argmax that decides homonyms.
//! 2. **Mention is not location.** A memory that merely *talks about*
//!    Baltimore must not answer a geo radius query centred on Baltimore.
//!    This is the invariant the whole design exists to protect: `geo_location`
//!    drives the geohash index, `toponyms` does not, and once a wrong
//!    coordinate is indexed there is no way to tell it from a right one.
//! 3. **Old records still decode.** Storage is postcard — positional, no
//!    per-field presence — so adding a field is a wire-format change and has
//!    to be proven against bytes written before the field existed.
//!
//! Storage lives under `std::env::temp_dir()` via `tempfile::TempDir`, NOT
//! under any watched path — the tantivy file-watcher corrupts commits under
//! watched directories (see the BM25 file-watcher finding).

use chrono::{DateTime, Utc};
use serde::Serialize;
use tempfile::TempDir;
use uuid::Uuid;

use shodh_memory::gazetteer;
use shodh_memory::memory::compression::CompressionPipeline;
use shodh_memory::memory::storage::{deserialize_memory_for_migration, SearchCriteria};
use shodh_memory::memory::types::{
    EntityRef, Experience, ExperienceType, MemoryRevision, MemoryTier, NerEntityRecord, Toponym,
};
use shodh_memory::memory::{MemoryConfig, MemoryId, MemorySystem, TodoId};
use shodh_memory::serialization::{encode_raw, wrap_sho_v2};

// ============================================================================
// TEST INFRASTRUCTURE
// ============================================================================

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
    let system = MemorySystem::new(config, None).expect("Failed to create memory system");
    (system, temp_dir)
}

fn loc(text: &str) -> NerEntityRecord {
    NerEntityRecord {
        text: text.to_string(),
        entity_type: "LOC".to_string(),
        confidence: 0.99,
        start_char: None,
        end_char: None,
        fine_label: None,
    }
}

fn named(text: &str, entity_type: &str) -> NerEntityRecord {
    NerEntityRecord {
        text: text.to_string(),
        entity_type: entity_type.to_string(),
        confidence: 0.99,
        start_char: None,
        end_char: None,
        fine_label: None,
    }
}

// ============================================================================
// RESOLUTION
// ============================================================================

#[test]
fn resolves_loc_entities_to_coordinates() {
    let toponyms = gazetteer::resolve_ner_locations(&[loc("Baltimore")]);

    assert_eq!(toponyms.len(), 1);
    let baltimore = &toponyms[0];
    assert_eq!(baltimore.mention, "Baltimore");
    assert_eq!(baltimore.name, "Baltimore");
    assert_eq!(baltimore.country, "US");
    assert!((baltimore.lat - 39.29038).abs() < 1e-5);
    assert!((baltimore.lon - -76.61219).abs() < 1e-5);
    assert!(baltimore.population > 500_000);
}

#[test]
fn homonyms_are_decided_by_population() {
    // cities15000 holds two Londons:
    //   London  51.50853   -0.12574  GB  8961989
    //   London  42.98339  -81.23304  CA   422324
    // Population-weighted argmax must pick England's, deterministically, with
    // no context and no tie-breaking randomness.
    let toponyms = gazetteer::resolve_ner_locations(&[loc("London")]);

    assert_eq!(toponyms.len(), 1);
    let london = &toponyms[0];
    assert_eq!(london.country, "GB", "the larger London must win");
    assert_eq!(london.population, 8_961_989);
    assert!((london.lat - 51.50853).abs() < 1e-5);
    // Not Ontario.
    assert!((london.lat - 42.98339).abs() > 1.0);
}

#[test]
fn only_location_entities_are_resolved() {
    // Person and organisation names collide with place names constantly.
    // Resolving them would mint confident, wrong coordinates.
    let entities = vec![
        named("Jordan", "PER"),
        named("Amazon", "ORG"),
        named("Phoenix", "MISC"),
    ];
    assert!(
        gazetteer::resolve_ner_locations(&entities).is_empty(),
        "non-LOC entities must never be resolved to places"
    );

    // The same surface form as a LOC does resolve.
    assert_eq!(gazetteer::resolve_ner_locations(&[loc("Phoenix")]).len(), 1);
}

#[test]
fn unresolvable_mentions_are_dropped_not_guessed() {
    let entities = vec![
        loc("Zzyzx Nonexistentville"),
        // Near-misses must NOT fuzzy-match: a wrong-but-plausible link is
        // worse than no link, because downstream cannot tell them apart.
        // All three are verified absent from cities15000 under both the
        // `name` and `asciiname` columns.
        loc("Baltimoore"),
        loc("Baltimor"),
        loc("Springfeld"),
    ];
    assert!(gazetteer::resolve_ner_locations(&entities).is_empty());
}

#[test]
fn a_substring_of_a_place_name_is_not_that_place() {
    // "Balti" is deliberately NOT used as a negative case: it is the ASCII
    // form of Bălți, Moldova (pop. 125,000), and resolving it is correct
    // behaviour, not a false positive. That is also what makes it a good
    // positive test of asciiname indexing — a mention written without
    // diacritics still finds the city.
    let balti = gazetteer::resolve_ner_locations(&[loc("Balti")]);
    assert_eq!(balti.len(), 1);
    assert_eq!(balti[0].country, "MD");
    assert_eq!(
        balti[0].name, "Bălţi",
        "canonical name keeps its diacritics"
    );
    assert_eq!(balti[0].mention, "Balti", "the mention is kept verbatim");
}

#[test]
fn repeated_mentions_collapse_to_one_toponym() {
    let entities = vec![loc("Baltimore"), loc("baltimore"), loc("BALTIMORE")];
    let toponyms = gazetteer::resolve_ner_locations(&entities);
    assert_eq!(
        toponyms.len(),
        1,
        "one place mentioned three times is still one place"
    );
}

#[test]
fn resolution_is_deterministic() {
    let entities = vec![loc("Springfield"), loc("London"), loc("Baltimore")];
    let first = gazetteer::resolve_ner_locations(&entities);
    for _ in 0..50 {
        assert_eq!(gazetteer::resolve_ner_locations(&entities), first);
    }
}

// ============================================================================
// MENTION IS NOT LOCATION — the load-bearing separation
// ============================================================================

/// Baltimore's coordinates, per the gazetteer row the resolver returns.
const BALTIMORE: [f64; 3] = [39.29038, -76.61219, 0.0];

#[test]
fn a_memory_mentioning_a_place_does_not_match_a_radius_query_there() {
    // THE test. A note about the Baltimore robotics team, recorded anywhere in
    // the world, carries Baltimore's coordinates in `toponyms` — and must
    // still be invisible to "what did I record within 25km of Baltimore".
    let (system, _temp) = setup_memory_system();

    let mentions_baltimore = Experience {
        content: "The Baltimore robotics team shipped the new gripper".to_string(),
        experience_type: ExperienceType::Observation,
        ner_entities: vec![loc("Baltimore")],
        toponyms: gazetteer::resolve_ner_locations(&[loc("Baltimore")]),
        // Recorded nowhere in particular — this is the whole point.
        geo_location: None,
        ..Default::default()
    };
    assert_eq!(
        mentions_baltimore.toponyms.len(),
        1,
        "precondition: the memory really does carry Baltimore's coordinates"
    );
    let mention_id = system
        .remember(mentions_baltimore, None)
        .expect("remember should succeed");

    // A control that WAS recorded in Baltimore, so we know the query works.
    let recorded_in_baltimore = Experience {
        content: "harbor patrol completed".to_string(),
        experience_type: ExperienceType::Observation,
        geo_location: Some(BALTIMORE),
        ..Default::default()
    };
    let recorded_id = system
        .remember(recorded_in_baltimore, None)
        .expect("remember should succeed");

    let found = system
        .advanced_search(SearchCriteria::ByLocation {
            lat: BALTIMORE[0],
            lon: BALTIMORE[1],
            radius_meters: 25_000.0,
            limit: None,
        })
        .expect("advanced_search should succeed");

    let found_ids: Vec<MemoryId> = found.iter().map(|m| m.id.clone()).collect();

    assert!(
        found_ids.contains(&recorded_id),
        "control: a memory actually recorded in Baltimore must match"
    );
    assert!(
        !found_ids.contains(&mention_id),
        "a memory that only MENTIONS Baltimore must not match a radius query there — \
         toponyms must never reach the geo index"
    );
}

#[test]
fn toponyms_never_populate_geo_location() {
    // Belt and braces on the same invariant, at the field level: whatever the
    // resolver produces, `geo_location` stays exactly what the caller supplied.
    let (system, _temp) = setup_memory_system();

    let experience = Experience {
        content: "Notes from the London and Springfield offices".to_string(),
        experience_type: ExperienceType::Observation,
        ner_entities: vec![loc("London"), loc("Springfield")],
        toponyms: gazetteer::resolve_ner_locations(&[loc("London"), loc("Springfield")]),
        geo_location: None,
        ..Default::default()
    };
    let id = system.remember(experience, None).expect("remember");

    let stored = system.get_memory(&id).expect("stored memory");
    assert_eq!(stored.experience.toponyms.len(), 2, "toponyms persisted");
    assert!(
        stored.experience.geo_location.is_none(),
        "resolving toponyms must never write geo_location"
    );
}

#[test]
fn toponyms_survive_a_storage_round_trip() {
    let (system, _temp) = setup_memory_system();

    let toponyms = gazetteer::resolve_ner_locations(&[loc("Baltimore")]);
    let experience = Experience {
        content: "Baltimore harbor survey".to_string(),
        experience_type: ExperienceType::Observation,
        toponyms: toponyms.clone(),
        ..Default::default()
    };
    let id = system.remember(experience, None).expect("remember");

    let stored = system.get_memory(&id).expect("stored memory");
    assert_eq!(
        stored.experience.toponyms, toponyms,
        "toponyms must survive serialize/deserialize intact"
    );
}

// ============================================================================
// OLD-FORMAT COMPATIBILITY
// ============================================================================

/// `MemoryFlat` exactly as it was encoded BEFORE the trailing `toponyms` field
/// was added — same fields, same order, same types.
///
/// `Experience` is embedded here as the real type on purpose: its `toponyms`
/// field is `#[serde(skip)]`, so encoding it reproduces the historical bytes
/// byte-for-byte. If someone ever removes that `skip`, this struct starts
/// emitting the field mid-payload and the test below fails — which is exactly
/// the regression we want to catch, because that is the shape that decodes to
/// silently wrong values in production rather than erroring.
#[derive(Serialize)]
struct MemoryFlatPreToponyms {
    id: MemoryId,
    experience: Experience,
    importance: f32,
    access_count: u32,
    created_at: DateTime<Utc>,
    last_accessed: DateTime<Utc>,
    compressed: bool,
    tier: MemoryTier,
    entity_refs: Vec<EntityRef>,
    activation: f32,
    last_retrieval_id: Option<Uuid>,
    agent_id: Option<String>,
    run_id: Option<String>,
    actor_id: Option<String>,
    temporal_relevance: f32,
    score: Option<f32>,
    external_id: Option<String>,
    version: u32,
    history: Vec<MemoryRevision>,
    related_todo_ids: Vec<TodoId>,
    parent_id: Option<MemoryId>,
}

#[test]
fn records_written_before_toponyms_existed_still_decode() {
    let id = MemoryId(Uuid::new_v4());
    let now = Utc::now();

    let legacy = MemoryFlatPreToponyms {
        id: id.clone(),
        experience: Experience {
            content: "A memory written before toponyms existed".to_string(),
            experience_type: ExperienceType::Learning,
            entities: vec!["gripper".to_string()],
            ..Default::default()
        },
        // Distinctive values: these are precisely the fields a mis-decode
        // corrupts, because `toponyms` read from the middle of the payload
        // would consume the first byte of `importance` as a Vec length and
        // shift everything after it.
        importance: 0.625,
        access_count: 7,
        created_at: now,
        last_accessed: now,
        compressed: false,
        tier: MemoryTier::Working,
        entity_refs: Vec::new(),
        activation: 0.375,
        last_retrieval_id: None,
        agent_id: Some("agent-7".to_string()),
        run_id: None,
        actor_id: None,
        temporal_relevance: 0.5,
        score: None,
        external_id: Some("ext-42".to_string()),
        version: 3,
        history: Vec::new(),
        related_todo_ids: Vec::new(),
        parent_id: None,
    };

    // Encode exactly as the storage layer did before the field existed:
    // raw postcard payload inside a SHO v2 envelope.
    let payload = encode_raw(&legacy).expect("encode legacy record");
    let record = wrap_sho_v2(&payload);

    let decoded = deserialize_memory_for_migration(&record).expect(
        "a record written before `toponyms` existed must still decode — \
         postcard has no #[serde(default)] EOF tolerance, so this only works \
         if the field is appended at the tail and defaulted by the decoder",
    );

    // The new field defaults to empty...
    assert!(
        decoded.experience.toponyms.is_empty(),
        "an old record has no toponyms"
    );

    // ...and, critically, nothing else shifted. A silent mis-decode would
    // still leave `toponyms` empty while corrupting these.
    assert_eq!(decoded.id, id);
    assert_eq!(decoded.tier, MemoryTier::Working);
    assert_eq!(
        decoded.experience.content,
        "A memory written before toponyms existed"
    );
    assert_eq!(decoded.experience.entities, vec!["gripper".to_string()]);
    assert_eq!(decoded.experience.experience_type, ExperienceType::Learning);
    assert!(
        (decoded.importance() - 0.625).abs() < 1e-6,
        "importance corrupted: got {}",
        decoded.importance()
    );
    assert_eq!(decoded.access_count(), 7, "access_count corrupted");
    assert_eq!(decoded.agent_id.as_deref(), Some("agent-7"));
    assert_eq!(decoded.external_id.as_deref(), Some("ext-42"));
    assert_eq!(decoded.version, 3);
}

#[test]
fn current_records_round_trip_with_toponyms_intact() {
    // The other half of the compat story: a record written NOW must decode
    // with its toponyms, through the same entry point.
    let id = MemoryId(Uuid::new_v4());
    let toponyms = vec![Toponym {
        mention: "Baltimore".to_string(),
        name: "Baltimore".to_string(),
        lat: 39.29038,
        lon: -76.61219,
        country: "US".to_string(),
        population: 585_708,
    }];

    let memory = shodh_memory::memory::Memory::new(
        id.clone(),
        Experience {
            content: "Baltimore harbor survey".to_string(),
            experience_type: ExperienceType::Observation,
            toponyms: toponyms.clone(),
            ..Default::default()
        },
        0.5,
        None,
        None,
        None,
        None,
    );

    let payload = encode_raw(&memory).expect("encode current record");
    let record = wrap_sho_v2(&payload);
    let decoded = deserialize_memory_for_migration(&record).expect("decode current record");

    assert_eq!(decoded.experience.toponyms, toponyms);
    assert_eq!(decoded.id, id);
}

#[test]
fn toponyms_survive_compression_round_trip() {
    // `Experience::toponyms` is `#[serde(skip)]`, and the LZ4 compressor
    // encodes `experience` STANDALONE — so the compressed blob does not contain
    // toponyms at all. Decompression must carry them across from the memory's
    // outer experience, or LZ4 compression silently stops being lossless.
    let compressor = CompressionPipeline::new();

    let toponyms = gazetteer::resolve_ner_locations(&[loc("Baltimore"), loc("London")]);
    assert_eq!(toponyms.len(), 2, "precondition: two places resolved");

    let memory = shodh_memory::memory::Memory::new(
        MemoryId(Uuid::new_v4()),
        Experience {
            content: "Coordination between the Baltimore and London teams".repeat(20),
            experience_type: ExperienceType::Observation,
            toponyms: toponyms.clone(),
            ..Default::default()
        },
        // High importance selects the lossless LZ4 strategy — the one that
        // encodes `experience` standalone and so loses skipped fields.
        0.95,
        None,
        None,
        None,
        None,
    );

    let compressed = compressor.compress(&memory).expect("compress");
    assert_eq!(
        compressed
            .experience
            .metadata
            .get("compression_strategy")
            .map(String::as_str),
        Some("lz4"),
        "precondition: this memory must take the LZ4 path"
    );
    let restored = compressor.decompress(&compressed).expect("decompress");

    assert_eq!(
        restored.experience.toponyms, toponyms,
        "decompression must not drop resolved places"
    );
    assert_eq!(restored.experience.content, memory.experience.content);
}

#[test]
fn get_memory_json_exposes_toponyms() {
    // `GET /api/memory/{id}` returns the whole `Memory`, serialized through
    // `MemoryFlat`. Because `toponyms` is carried at the flat struct's tail
    // (see the storage note above), it surfaces as a TOP-LEVEL key rather than
    // nested under `experience` alongside `geo_location`. The data is there;
    // this pins where, so anyone moving it does so deliberately.
    let memory = shodh_memory::memory::Memory::new(
        MemoryId(Uuid::new_v4()),
        Experience {
            content: "Baltimore harbor survey".to_string(),
            experience_type: ExperienceType::Observation,
            toponyms: gazetteer::resolve_ner_locations(&[loc("Baltimore")]),
            ..Default::default()
        },
        0.5,
        None,
        None,
        None,
        None,
    );

    let json: serde_json::Value =
        serde_json::to_value(&memory).expect("Memory must serialize to JSON");

    let toponyms = json
        .get("toponyms")
        .and_then(|t| t.as_array())
        .expect("toponyms present at the top level of the memory object");
    assert_eq!(toponyms.len(), 1);
    assert_eq!(toponyms[0]["name"], "Baltimore");
    assert_eq!(toponyms[0]["country"], "US");

    assert!(
        json["experience"].get("toponyms").is_none(),
        "toponyms is carried on the flat struct, not inside `experience`"
    );
}
