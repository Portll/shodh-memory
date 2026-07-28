//! Named Entity Recognition with schema-driven fine typing.
//!
//! Production path: the GLiNER bi-edge span typer ([`GlinerTyper`]) — a
//! schema-driven bi-encoder that predicts 141 fine labels and rolls each up to
//! one of 18 coarse [`EntityLabel`] classes. Every recognized surface carries
//! the fine label of its **top-scoring** span, so downstream ingest can set
//! `EntityNode.fine_type` and pick a precise primary label instead of the old
//! "everything is one bucket" MISC funnel.
//!
//! Degradation: when the GLiNER model assets are absent, extraction falls back
//! to the rule-based [`EntityExtractor`] keyword matcher (logged once at init).
//! The fallback yields coarse 4-class types only (no fine label).
//!
//! The legacy bert-tiny 4-class BIO tagger (`extract_neural`) and its MISC→regex
//! typer (`classify_misc_entity`) have been removed — GLiNER is the sole neural
//! typer, and the schema rollup replaces the keyword heuristics.
//!
//! # Edge Device Optimizations
//! - GLiNER bi-edge fp32 ONNX (~150MB) shares the process ORT runtime with MiniLM.
//! - Lazy loading — the model loads on first inference.
//! - LRU cache keyed by text hash avoids re-processing identical inputs.

use anyhow::Result;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;

use crate::embeddings::gliner::GlinerTyper;
use crate::graph_memory::EntityLabel;

/// Coarse entity types surfaced to downstream query analysis and filtering.
///
/// This is the stable 4-class view every existing consumer already reads. The
/// GLiNER production path rolls its richer 18-class [`EntityLabel`] down to one
/// of these via [`NerEntityType::from_coarse`]; the precise class survives on
/// [`NerEntity::fine_label`] and is re-expanded at graph-insertion time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NerEntityType {
    Person,
    Organization,
    Location,
    Misc,
}

impl NerEntityType {
    pub fn as_str(&self) -> &'static str {
        match self {
            NerEntityType::Person => "PER",
            NerEntityType::Organization => "ORG",
            NerEntityType::Location => "LOC",
            NerEntityType::Misc => "MISC",
        }
    }

    /// Roll a coarse [`EntityLabel`] down to the stable 4-class view. Named-entity
    /// classes with a clear PER/ORG/LOC home map through; everything else (dates,
    /// money, works, cyber, abstract concepts, …) is MISC — the fine label on the
    /// [`NerEntity`] preserves the exact class for the graph.
    pub fn from_coarse(label: &EntityLabel) -> Self {
        match label {
            EntityLabel::Person | EntityLabel::Title | EntityLabel::Role => Self::Person,
            EntityLabel::Organization | EntityLabel::Team | EntityLabel::Norp => Self::Organization,
            EntityLabel::Location
            | EntityLabel::Gpe
            | EntityLabel::Facility
            | EntityLabel::Environment => Self::Location,
            _ => Self::Misc,
        }
    }
}

/// A recognized entity from NER.
#[derive(Debug, Clone)]
pub struct NerEntity {
    /// The entity text (e.g., "Microsoft", "New York").
    pub text: String,
    /// Coarse 4-class type (drives existing query analysis / filtering).
    pub entity_type: NerEntityType,
    /// Confidence score (0.0 - 1.0). GLiNER sigmoid probability, or fallback salience.
    pub confidence: f32,
    /// Start character offset in original text.
    pub start: usize,
    /// End character offset in original text.
    pub end: usize,
    /// GLiNER fine label (schema leaf, e.g. "cargo ship", "bridge") of the
    /// top-scoring span for this surface. `None` on the rule-based fallback path.
    pub fine_label: Option<String>,
}

/// Configuration for the NER stage.
///
/// The GLiNER production path is configured from the environment via
/// [`GlinerConfig::from_env`](crate::embeddings::gliner::GlinerConfig::from_env)
/// (`SHODH_GLINER_MODEL_PATH`, default `./models/gliner-bi-edge`); the fields
/// here carry the fallback confidence floor and are retained for config-API and
/// call-site stability.
#[derive(Debug, Clone)]
pub struct NerConfig {
    /// Legacy model-dir path (unused by the GLiNER path; kept for API stability).
    pub model_path: PathBuf,
    /// Legacy tokenizer path (unused by the GLiNER path; kept for API stability).
    pub tokenizer_path: PathBuf,
    /// Legacy max sequence length (unused by the GLiNER path; kept for stability).
    pub max_length: usize,
    /// Minimum confidence threshold for the rule-based fallback path.
    pub confidence_threshold: f32,
}

impl Default for NerConfig {
    fn default() -> Self {
        Self::from_env()
    }
}

impl NerConfig {
    /// Create configuration from environment variables.
    pub fn from_env() -> Self {
        let base_path = std::env::var("SHODH_NER_MODEL_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| super::downloader::get_ner_models_dir());

        let confidence_threshold = std::env::var("SHODH_NER_CONFIDENCE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.5);

        Self {
            model_path: base_path.join("model.onnx"),
            tokenizer_path: base_path.join("tokenizer.json"),
            max_length: 128,
            confidence_threshold,
        }
    }
}

/// Cache size for NER results (number of unique texts).
const NER_CACHE_SIZE: u64 = 1000;

/// Neural NER model — GLiNER bi-edge production typer with a rule-based fallback.
pub struct NeuralNer {
    /// GLiNER bi-edge span typer (lazy-loaded on first inference).
    gliner: GlinerTyper,
    /// True when GLiNER assets are absent — extraction degrades to rule-based.
    use_fallback: bool,
    /// Lazy-loaded EntityExtractor for comprehensive rule-based fallback.
    entity_extractor: OnceLock<crate::graph_memory::EntityExtractor>,
    /// Minimum confidence for fallback-path entities.
    fallback_confidence_threshold: f32,
    /// LRU cache for extracted entities (keyed by text hash).
    entity_cache: moka::sync::Cache<u64, Vec<NerEntity>>,
}

// ── NER replay hook (offline-entity ablation; env-gated, default OFF) ────────
// When SHODH_NER_REPLAY points at a JSON map {text -> [entities]}, extract()/
// extract_batch() return those entities instead of running the model. Lets us
// ablate a different NER through the REAL pipeline without porting it to Rust.
// JSON: {"<text>": [{"text","type"("PER"|"ORG"|"LOC"|"MISC"),"start","end","conf"}]}.
// A miss falls through to the model.
#[derive(serde::Deserialize)]
struct ReplayEntity {
    text: String,
    #[serde(rename = "type")]
    ty: String,
    start: usize,
    end: usize,
    conf: f32,
}

static NER_REPLAY_MAP: std::sync::OnceLock<
    Option<std::collections::HashMap<String, Vec<NerEntity>>>,
> = std::sync::OnceLock::new();

fn ner_replay_map() -> Option<&'static std::collections::HashMap<String, Vec<NerEntity>>> {
    NER_REPLAY_MAP
        .get_or_init(|| {
            let path = std::env::var("SHODH_NER_REPLAY").ok()?;
            let data = std::fs::read_to_string(&path)
                .map_err(|e| tracing::error!("SHODH_NER_REPLAY read {path} failed: {e}"))
                .ok()?;
            let raw: std::collections::HashMap<String, Vec<ReplayEntity>> =
                serde_json::from_str(&data)
                    .map_err(|e| tracing::error!("SHODH_NER_REPLAY parse failed: {e}"))
                    .ok()?;
            let map: std::collections::HashMap<String, Vec<NerEntity>> = raw
                .into_iter()
                .map(|(k, ents)| {
                    let v = ents
                        .into_iter()
                        .map(|e| NerEntity {
                            text: e.text,
                            entity_type: match e.ty.as_str() {
                                "PER" => NerEntityType::Person,
                                "ORG" => NerEntityType::Organization,
                                "LOC" => NerEntityType::Location,
                                _ => NerEntityType::Misc,
                            },
                            confidence: e.conf,
                            start: e.start,
                            end: e.end,
                            fine_label: None,
                        })
                        .collect();
                    (k, v)
                })
                .collect();
            tracing::warn!(
                "SHODH_NER_REPLAY ACTIVE: {} texts loaded from {} (model NER bypassed on hits)",
                map.len(),
                path
            );
            Some(map)
        })
        .as_ref()
}

fn ner_replay_lookup(text: &str) -> Option<Vec<NerEntity>> {
    ner_replay_map()?.get(text).cloned()
}

fn build_entity_cache() -> moka::sync::Cache<u64, Vec<NerEntity>> {
    moka::sync::Cache::builder()
        .max_capacity(NER_CACHE_SIZE)
        .time_to_live(std::time::Duration::from_secs(3600)) // 1 hour TTL
        .build()
}

impl NeuralNer {
    /// Create a NER stage. Uses the GLiNER bi-edge production typer when its
    /// assets are present, otherwise degrades to the rule-based fallback (logged).
    /// Never fails — the `Result` is retained for call-site stability.
    pub fn new(config: NerConfig) -> Result<Self> {
        let mut gliner = GlinerTyper::from_env();

        // First-run provisioning: if no distribution shipped the assets and we
        // are online, fetch them from the pinned release into the cache dir
        // (a `GlinerConfig::from_env` candidate), then retry — mirroring the
        // MiniLM / ONNX-runtime auto-download. Without this, end users
        // (cargo install / pip / Docker-runtime) silently run the rule-based
        // fallback because only CI ever provisions GLiNER.
        if !gliner.is_available() {
            let offline = std::env::var("SHODH_OFFLINE")
                .map(|v| v == "true" || v == "1")
                .unwrap_or(false);
            if offline {
                tracing::warn!(
                    "GLiNER bi-edge assets not found and SHODH_OFFLINE set — NER degrading to rule-based fallback"
                );
            } else {
                tracing::info!(
                    "GLiNER bi-edge assets not found — downloading from release {}",
                    crate::embeddings::downloader::GLINER_RELEASE_TAG
                );
                let progress = Some(crate::embeddings::downloader::make_stderr_progress(
                    "GLiNER model (149 MB)".to_string(),
                ));
                match crate::embeddings::downloader::download_gliner_models(progress) {
                    Ok(dir) => {
                        tracing::info!("GLiNER bi-edge assets ready at {:?}", dir);
                        gliner = GlinerTyper::from_env();
                    }
                    Err(e) => {
                        tracing::warn!(
                            "GLiNER asset download failed ({e}) — NER degrading to rule-based fallback"
                        );
                    }
                }
            }
        }

        let use_fallback = !gliner.is_available();
        if use_fallback {
            tracing::warn!(
                "GLiNER bi-edge assets not found — NER degrading to rule-based fallback"
            );
        } else {
            tracing::info!("Neural NER initialized (GLiNER bi-edge production typer)");
        }
        Ok(Self {
            gliner,
            use_fallback,
            entity_extractor: OnceLock::new(),
            fallback_confidence_threshold: config.confidence_threshold,
            entity_cache: build_entity_cache(),
        })
    }

    /// Create a NER stage forced into rule-based fallback mode (GLiNER bypassed).
    pub fn new_fallback(config: NerConfig) -> Self {
        Self {
            gliner: GlinerTyper::from_env(),
            use_fallback: true,
            entity_extractor: OnceLock::new(),
            fallback_confidence_threshold: config.confidence_threshold,
            entity_cache: build_entity_cache(),
        }
    }

    /// Check if using rule-based fallback mode (GLiNER assets absent or forced).
    pub fn is_fallback_mode(&self) -> bool {
        self.use_fallback
    }

    /// Compute cache key from text (FNV-1a-style hash for speed).
    fn cache_key(text: &str) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut hasher);
        hasher.finish()
    }

    /// Extract entities (with caching and the optional replay hook).
    pub fn extract(&self, text: &str) -> Result<Vec<NerEntity>> {
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }

        // NER replay hook (SHODH_NER_REPLAY) — offline-entity ablation, default off.
        if let Some(ents) = ner_replay_lookup(text) {
            return Ok(ents);
        }

        // Check cache first.
        let cache_key = Self::cache_key(text);
        if let Some(cached) = self.entity_cache.get(&cache_key) {
            return Ok(cached);
        }

        let entities = if self.use_fallback {
            self.extract_fallback(text)?
        } else {
            self.extract_gliner(text)
        };

        self.entity_cache.insert(cache_key, entities.clone());
        Ok(entities)
    }

    /// Extract entities from multiple texts.
    ///
    /// GLiNER types one text per inference, so this is a cache-aware loop over
    /// [`extract`](Self::extract) — replay, empties, and caching are handled there.
    pub fn extract_batch(&self, texts: &[&str]) -> Result<Vec<Vec<NerEntity>>> {
        let mut results = Vec::with_capacity(texts.len());
        for &text in texts {
            results.push(self.extract(text)?);
        }
        Ok(results)
    }

    /// GLiNER production typing: fine-typed spans → coarse-view [`NerEntity`]s.
    ///
    /// GLiNER performs flat, non-overlapping span selection internally, so each
    /// surface already carries its single top-scoring fine label — that is the
    /// label that lands on the graph node.
    fn extract_gliner(&self, text: &str) -> Vec<NerEntity> {
        let spans = self.gliner.extract(text);
        let entities: Vec<NerEntity> = spans
            .into_iter()
            .filter_map(|span| {
                if span.text.trim().is_empty() {
                    return None;
                }
                Some(NerEntity {
                    entity_type: NerEntityType::from_coarse(&span.coarse),
                    confidence: span.score,
                    start: span.start,
                    end: span.end,
                    fine_label: Some(span.fine_label),
                    text: span.text,
                })
            })
            .collect();
        // GLiNER already yields non-overlapping spans; dedup guards identical surfaces.
        self.deduplicate_entities(entities)
    }

    /// Get cache statistics.
    pub fn cache_stats(&self) -> (u64, u64) {
        (self.entity_cache.entry_count(), NER_CACHE_SIZE)
    }

    /// Clear the entity cache.
    pub fn clear_cache(&self) {
        self.entity_cache.invalidate_all();
    }

    /// Deduplicate entities (prefer longer spans, drop overlaps).
    fn deduplicate_entities(&self, mut entities: Vec<NerEntity>) -> Vec<NerEntity> {
        if entities.len() <= 1 {
            return entities;
        }

        // Sort by start position, then by length (descending).
        entities.sort_by(|a, b| {
            a.start
                .cmp(&b.start)
                .then_with(|| (b.end - b.start).cmp(&(a.end - a.start)))
        });

        let mut result = Vec::new();
        let mut seen_spans: HashSet<(usize, usize)> = HashSet::new();

        for entity in entities {
            // Check if this span overlaps with any seen span.
            let overlaps = seen_spans
                .iter()
                .any(|&(s, e)| entity.start < e && entity.end > s);

            if !overlaps {
                seen_spans.insert((entity.start, entity.end));
                result.push(entity);
            }
        }

        result
    }

    /// Rule-based fallback extraction using the comprehensive [`EntityExtractor`].
    ///
    /// Used only when GLiNER assets are absent. Provides coarse 4-class types with
    /// no fine label (`fine_label = None`) — the graph then defaults the entity's
    /// primary label from the coarse type.
    fn extract_fallback(&self, text: &str) -> Result<Vec<NerEntity>> {
        use crate::graph_memory::{EntityExtractor, EntityLabel};

        // Lazy-load the EntityExtractor (1000+ lines of dictionaries, only init once).
        let extractor = self.entity_extractor.get_or_init(EntityExtractor::new);

        // Extract entities with salience information.
        let extracted = extractor.extract_with_salience(text);

        // Convert EntityLabel to the coarse NerEntityType view and build NerEntity structs.
        let entities: Vec<NerEntity> = extracted
            .into_iter()
            .map(|e| {
                let entity_type = match e.label {
                    EntityLabel::Person => NerEntityType::Person,
                    EntityLabel::Organization | EntityLabel::Team => NerEntityType::Organization,
                    EntityLabel::Location | EntityLabel::Environment => NerEntityType::Location,
                    _ => NerEntityType::Misc,
                };

                // Use salience as confidence (EntityExtractor returns 0.6-0.9).
                let confidence = (e.base_salience * 0.9).min(0.85);

                // Find position in original text (case-insensitive byte-offset search).
                // Use the original name's byte length for slicing into `text`, since
                // to_lowercase() can change byte lengths for non-ASCII characters.
                let name_len = e.name.len();
                let (start, end) = text
                    .char_indices()
                    .find(|&(i, _)| {
                        text[i..]
                            .get(..name_len)
                            .is_some_and(|slice| slice.eq_ignore_ascii_case(&e.name))
                    })
                    .map(|(pos, _)| (pos, pos + name_len))
                    // Not found in the source text (e.g. the extractor normalised the
                    // surface form): emit a zero-width span at offset 0 to signal
                    // "position unknown" rather than fabricating a (0, name_len) span.
                    .unwrap_or((0, 0));

                NerEntity {
                    text: e.name,
                    entity_type,
                    confidence,
                    start,
                    end,
                    fine_label: None,
                }
            })
            .filter(|e| e.confidence >= self.fallback_confidence_threshold)
            .collect();

        // Dedup — the heuristic extractor can emit the same surface more than once.
        let entities = self.deduplicate_entities(entities);

        Ok(entities)
    }
}

// =============================================================================
// COLD-START ENTITY EXTRACTION
// Aggressive heuristic extraction for bootstrapping sparse knowledge graphs.
// Supplements NER+YAKE when entity_count < ENTITY_COLD_START_THRESHOLD.
// =============================================================================

/// Extract additional entities using aggressive heuristics for cold-start graphs.
///
/// When the graph has fewer than `ENTITY_COLD_START_THRESHOLD` entities, NER+YAKE
/// miss entities that would be obvious to a human reader. This function catches:
///
/// 1. **Mid-sentence proper nouns**: Capitalized words not at sentence start
/// 2. **Email addresses**: user@domain.com patterns
/// 3. **URLs**: http(s)://... patterns
/// 4. **File paths**: /foo/bar.rs, ./src/main.rs patterns
/// 5. **Version numbers**: v1.2.3, 2.0.0-rc1 patterns
/// 6. **Tech names**: CamelCase identifiers (PostgreSQL, FastAPI, GraphQL)
///
/// Returns deduplicated entity strings not already present in `existing_entities`.
pub fn cold_start_extract_entities(text: &str, existing_entities: &[String]) -> Vec<String> {
    use std::collections::HashSet;

    let existing_lower: HashSet<String> =
        existing_entities.iter().map(|e| e.to_lowercase()).collect();

    let mut extracted: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = existing_lower;

    // Common stop words that appear capitalized at sentence starts
    let stop_words: HashSet<&str> = [
        "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
        "do", "does", "did", "will", "would", "could", "should", "may", "might", "shall", "can",
        "need", "must", "it", "its", "this", "that", "these", "those", "i", "we", "you", "he",
        "she", "they", "me", "him", "her", "us", "them", "my", "your", "his", "our", "their",
        "what", "which", "who", "whom", "where", "when", "why", "how", "not", "no", "nor", "but",
        "or", "and", "if", "then", "else", "for", "from", "with", "without", "about", "between",
        "through", "during", "before", "after", "above", "below", "to", "of", "in", "on", "at",
        "by", "up", "out", "off", "over", "under", "again", "further", "once", "here", "there",
        "all", "each", "every", "both", "few", "more", "most", "other", "some", "such", "only",
        "own", "same", "so", "than", "too", "very", "just", "because", "as", "until", "while",
        "also", "however", "although", "since", "already", "still", "yet", "now",
    ]
    .into_iter()
    .collect();

    let words: Vec<&str> = text.split_whitespace().collect();

    // --- 1. Mid-sentence proper nouns ---
    // Words starting with uppercase that are NOT at the start of a sentence
    let mut i = 0;
    while i < words.len() {
        let word = words[i];
        let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '-');

        if clean.is_empty() || clean.len() < 2 {
            i += 1;
            continue;
        }

        let first_char = clean.chars().next().unwrap_or(' ');
        let is_capitalized = first_char.is_uppercase();

        if !is_capitalized {
            i += 1;
            continue;
        }

        // Check if this is at a sentence start (preceded by sentence-ending punctuation)
        let at_sentence_start = if i == 0 {
            true
        } else {
            let prev = words[i - 1];
            prev.ends_with('.') || prev.ends_with('!') || prev.ends_with('?') || prev.ends_with(':')
        };

        let lower = clean.to_lowercase();

        // Skip stop words
        if stop_words.contains(lower.as_str()) {
            i += 1;
            continue;
        }

        // At sentence start, only extract if it looks like a proper noun
        // (CamelCase, all-caps acronym, or known pattern)
        if at_sentence_start && !is_camel_case(clean) && !is_acronym(clean) {
            i += 1;
            continue;
        }

        // Build multi-word entity by consuming consecutive capitalized words
        let mut entity_parts: Vec<&str> = vec![clean];
        let mut j = i + 1;
        while j < words.len() {
            let next = words[j].trim_matches(|c: char| !c.is_alphanumeric() && c != '-');
            if next.is_empty() {
                break;
            }
            let next_first = next.chars().next().unwrap_or(' ');
            if next_first.is_uppercase() || stop_words.contains(next.to_lowercase().as_str()) {
                // Include capitalized words and connecting stop words (e.g., "Bank of America")
                if next_first.is_uppercase() {
                    entity_parts.push(next);
                    j += 1;
                } else {
                    // Lowercase connector — only include if the NEXT word is capitalized
                    if j + 1 < words.len() {
                        let after = words[j + 1].trim_matches(|c: char| !c.is_alphanumeric());
                        if after
                            .chars()
                            .next()
                            .map(|c| c.is_uppercase())
                            .unwrap_or(false)
                        {
                            entity_parts.push(next);
                            j += 1;
                        } else {
                            break;
                        }
                    } else {
                        break;
                    }
                }
            } else {
                break;
            }
        }

        let entity_name = entity_parts.join(" ");
        let entity_lower = entity_name.to_lowercase();

        if !seen.contains(&entity_lower) && entity_lower.len() >= 2 {
            seen.insert(entity_lower);
            extracted.push(entity_name);
        }

        // Skip past consumed words
        i = j;
    }

    // --- 2. Email addresses ---
    for word in &words {
        let clean = word.trim_matches(|c: char| {
            !c.is_alphanumeric() && c != '@' && c != '.' && c != '-' && c != '_' && c != '+'
        });
        if clean.contains('@') && clean.contains('.') {
            // Basic email validation: has @ with text before and after, has . after @
            let parts: Vec<&str> = clean.splitn(2, '@').collect();
            if parts.len() == 2 && !parts[0].is_empty() && parts[1].contains('.') {
                let lower = clean.to_lowercase();
                if !seen.contains(&lower) {
                    seen.insert(lower);
                    extracted.push(clean.to_string());
                }
            }
        }
    }

    // --- 3. URLs ---
    for word in &words {
        let clean = word.trim_matches(|c: char| {
            c == '(' || c == ')' || c == '<' || c == '>' || c == '"' || c == '\''
        });
        if (clean.starts_with("http://") || clean.starts_with("https://")) && clean.len() > 10 {
            let lower = clean.to_lowercase();
            if !seen.contains(&lower) {
                seen.insert(lower);
                extracted.push(clean.to_string());
            }
        }
    }

    // --- 4. File paths ---
    for word in &words {
        let clean = word.trim_matches(|c: char| {
            c == '"' || c == '\'' || c == '`' || c == '(' || c == ')' || c == ','
        });
        // Unix-style paths: /foo/bar or ./foo/bar
        if (clean.starts_with('/') || clean.starts_with("./") || clean.starts_with("../"))
            && clean.contains('/')
            && clean.len() >= 4
            && !clean.starts_with("http")
        {
            let lower = clean.to_lowercase();
            if !seen.contains(&lower) {
                seen.insert(lower);
                extracted.push(clean.to_string());
            }
        }
    }

    // --- 5. Version numbers ---
    for word in &words {
        let clean = word.trim_matches(|c: char| c == '(' || c == ')' || c == ',' || c == ';');
        if is_version_number(clean) {
            let lower = clean.to_lowercase();
            if !seen.contains(&lower) {
                seen.insert(lower);
                extracted.push(clean.to_string());
            }
        }
    }

    // --- 6. CamelCase tech names (not caught by proper noun detection) ---
    for word in &words {
        let clean = word.trim_matches(|c: char| !c.is_alphanumeric());
        if clean.len() >= 3 && is_camel_case(clean) {
            let lower = clean.to_lowercase();
            if !seen.contains(&lower) && !stop_words.contains(lower.as_str()) {
                seen.insert(lower);
                extracted.push(clean.to_string());
            }
        }
    }

    extracted
}

/// Check if a word is CamelCase (e.g., PostgreSQL, FastAPI, GraphQL, RocksDB).
/// Requires at least one uppercase letter after the first character position.
fn is_camel_case(word: &str) -> bool {
    if word.len() < 3 {
        return false;
    }
    let mut chars = word.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    if !first.is_uppercase() {
        return false;
    }
    let mut has_lower = false;
    let mut has_upper_after_first = false;
    for c in chars {
        if c.is_lowercase() {
            has_lower = true;
        } else if c.is_uppercase() {
            has_upper_after_first = true;
        }
    }
    // CamelCase requires both: at least one lowercase and one uppercase after first char
    // This distinguishes "PostgreSQL" from "USA" (acronyms handled separately)
    has_lower && has_upper_after_first
}

/// Check if a word is an acronym (2-5 uppercase letters, optionally with digits).
fn is_acronym(word: &str) -> bool {
    let len = word.len();
    if !(2..=6).contains(&len) {
        return false;
    }
    word.chars().all(|c| c.is_uppercase() || c.is_ascii_digit())
        && word.chars().any(|c| c.is_uppercase())
}

/// Check if a string looks like a version number: v1.2.3, 2.0.0, 1.0.0-rc1, etc.
fn is_version_number(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let digits_part = if s.starts_with('v') || s.starts_with('V') {
        &s[1..]
    } else {
        s
    };
    if digits_part.is_empty() {
        return false;
    }
    // Must start with a digit and contain at least one dot
    let first = digits_part.chars().next().unwrap_or(' ');
    if !first.is_ascii_digit() || !digits_part.contains('.') {
        return false;
    }
    // Allow digits, dots, hyphens (for pre-release tags like -rc1, -beta.2)
    digits_part
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== NerEntityType Tests ====================

    #[test]
    fn test_entity_type_as_str() {
        assert_eq!(NerEntityType::Person.as_str(), "PER");
        assert_eq!(NerEntityType::Organization.as_str(), "ORG");
        assert_eq!(NerEntityType::Location.as_str(), "LOC");
        assert_eq!(NerEntityType::Misc.as_str(), "MISC");
    }

    #[test]
    fn test_from_coarse_rolls_named_classes_to_four_class_view() {
        // Location family
        assert_eq!(
            NerEntityType::from_coarse(&EntityLabel::Gpe),
            NerEntityType::Location
        );
        assert_eq!(
            NerEntityType::from_coarse(&EntityLabel::Facility),
            NerEntityType::Location
        );
        // Organization family
        assert_eq!(
            NerEntityType::from_coarse(&EntityLabel::Norp),
            NerEntityType::Organization
        );
        // Person family
        assert_eq!(
            NerEntityType::from_coarse(&EntityLabel::Title),
            NerEntityType::Person
        );
        // Everything else → MISC (fine label preserves the precise class).
        assert_eq!(
            NerEntityType::from_coarse(&EntityLabel::Money),
            NerEntityType::Misc
        );
        assert_eq!(
            NerEntityType::from_coarse(&EntityLabel::Vehicle),
            NerEntityType::Misc
        );
    }

    // ==================== NerConfig Tests ====================

    #[test]
    fn test_ner_config_default() {
        let config = NerConfig::default();
        assert_eq!(config.max_length, 128);
    }

    // ==================== NeuralNer Fallback Tests ====================

    fn fallback_ner() -> NeuralNer {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };
        NeuralNer::new_fallback(config)
    }

    #[test]
    fn test_fallback_mode_detection() {
        assert!(fallback_ner().is_fallback_mode());
    }

    #[test]
    fn test_fallback_extraction_organizations() {
        let ner = fallback_ner();
        let test_cases = vec![
            ("Microsoft is a company", "Microsoft"),
            ("I work at Google", "Google"),
            ("Apple released a new product", "Apple"),
            ("Infosys reported earnings", "Infosys"),
        ];
        for (text, expected_entity) in test_cases {
            let entities = ner.extract(text).unwrap();
            let found = entities.iter().find(|e| e.text == expected_entity);
            assert!(found.is_some(), "Should find {expected_entity} in '{text}'");
            assert_eq!(
                found.unwrap().entity_type,
                NerEntityType::Organization,
                "Wrong type for {expected_entity} in '{text}'"
            );
            // Fallback path never sets a fine label.
            assert!(found.unwrap().fine_label.is_none());
        }
    }

    #[test]
    fn test_fallback_extraction_locations() {
        let ner = fallback_ner();
        let test_cases = vec![
            ("The office is in Seattle", "Seattle"),
            ("I visited Mumbai last week", "Mumbai"),
            ("Tokyo is beautiful", "Tokyo"),
            ("Moving to Bangalore", "Bangalore"),
        ];
        for (text, expected_entity) in test_cases {
            let entities = ner.extract(text).unwrap();
            let found = entities.iter().find(|e| e.text == expected_entity);
            assert!(found.is_some(), "Should find {expected_entity} in '{text}'");
            assert_eq!(
                found.unwrap().entity_type,
                NerEntityType::Location,
                "Wrong type for {expected_entity} in '{text}'"
            );
        }
    }

    #[test]
    fn test_fallback_extraction_mixed() {
        let ner = fallback_ner();
        let entities = ner
            .extract("Microsoft is headquartered in Seattle")
            .unwrap();
        let microsoft = entities.iter().find(|e| e.text == "Microsoft");
        let seattle = entities.iter().find(|e| e.text == "Seattle");
        assert!(microsoft.is_some());
        assert!(seattle.is_some());
        assert_eq!(microsoft.unwrap().entity_type, NerEntityType::Organization);
        assert_eq!(seattle.unwrap().entity_type, NerEntityType::Location);
    }

    #[test]
    fn test_fallback_extraction_empty_text() {
        let ner = fallback_ner();
        assert!(ner.extract("").unwrap().is_empty());
    }

    #[test]
    fn test_fallback_extraction_whitespace_only() {
        let ner = fallback_ner();
        assert!(ner.extract("   \t\n  ").unwrap().is_empty());
    }

    #[test]
    fn test_fallback_extraction_stop_words_only() {
        let ner = fallback_ner();
        let entities = ner.extract("the a an and or is are was were").unwrap();
        assert!(
            entities.is_empty(),
            "Expected no entities from stop words but got: {entities:?}"
        );
    }

    #[test]
    fn test_fallback_deduplication() {
        let ner = fallback_ner();
        let entities = ner
            .extract("Microsoft partnered with Microsoft Azure")
            .unwrap();
        let microsoft_count = entities.iter().filter(|e| e.text == "Microsoft").count();
        assert_eq!(microsoft_count, 1, "Microsoft should appear only once");
    }

    #[test]
    fn test_fallback_confidence_scores() {
        let ner = fallback_ner();
        let entities = ner.extract("Microsoft Google Apple").unwrap();
        for entity in &entities {
            assert!(
                entity.confidence >= 0.5 && entity.confidence <= 1.0,
                "Confidence {} out of expected range",
                entity.confidence
            );
        }
    }

    // ==================== NerEntity Tests ====================

    #[test]
    fn test_ner_entity_clone() {
        let entity = NerEntity {
            text: "Microsoft".to_string(),
            entity_type: NerEntityType::Organization,
            confidence: 0.95,
            start: 0,
            end: 9,
            fine_label: Some("company".to_string()),
        };
        let cloned = entity.clone();
        assert_eq!(cloned.text, entity.text);
        assert_eq!(cloned.entity_type, entity.entity_type);
        assert_eq!(cloned.fine_label, entity.fine_label);
        assert!((cloned.confidence - entity.confidence).abs() < 1e-5);
    }

    // ==================== Edge Case Tests ====================

    #[test]
    fn test_punctuation_handling() {
        let ner = fallback_ner();
        let entities = ner.extract("Microsoft, Google, and Apple!").unwrap();
        for entity in &entities {
            assert!(!entity.text.contains(','));
            assert!(!entity.text.contains('!'));
        }
    }

    #[test]
    fn test_indian_cities() {
        let ner = fallback_ner();
        let indian_cities = vec!["Mumbai", "Delhi", "Bangalore", "Chennai", "Hyderabad"];
        for city in indian_cities {
            let entities = ner.extract(&format!("Office in {city}")).unwrap();
            let found = entities.iter().find(|e| e.text == city);
            assert!(found.is_some(), "Should find Indian city: {city}");
            assert_eq!(
                found.unwrap().entity_type,
                NerEntityType::Location,
                "{city} should be Location"
            );
        }
    }

    // ==================== Cold-Start Extraction Tests ====================

    #[test]
    fn test_cold_start_mid_sentence_proper_nouns() {
        let existing: Vec<String> = vec![];
        let text = "Yesterday I met with Caroline at the Anthropic office in San Francisco.";
        let entities = cold_start_extract_entities(text, &existing);

        let lower: Vec<String> = entities.iter().map(|e| e.to_lowercase()).collect();
        assert!(
            lower.contains(&"caroline".to_string()),
            "Should extract mid-sentence proper noun 'Caroline': {entities:?}"
        );
        assert!(
            lower.contains(&"anthropic".to_string()),
            "Should extract mid-sentence proper noun 'Anthropic': {entities:?}"
        );
    }

    #[test]
    fn test_cold_start_multi_word_entities() {
        let existing: Vec<String> = vec![];
        let text = "The project uses Bank of America and New York offices.";
        let entities = cold_start_extract_entities(text, &existing);
        let joined = entities.join(", ").to_lowercase();
        assert!(
            joined.contains("bank of america") || joined.contains("new york"),
            "Should extract multi-word entities: {entities:?}"
        );
    }

    #[test]
    fn test_cold_start_emails() {
        let existing: Vec<String> = vec![];
        let text = "Contact john.doe@example.com or support@anthropic.com for help.";
        let entities = cold_start_extract_entities(text, &existing);
        let lower: Vec<String> = entities.iter().map(|e| e.to_lowercase()).collect();
        assert!(
            lower.contains(&"john.doe@example.com".to_string()),
            "Should extract email: {entities:?}"
        );
        assert!(
            lower.contains(&"support@anthropic.com".to_string()),
            "Should extract email: {entities:?}"
        );
    }

    #[test]
    fn test_cold_start_urls() {
        let existing: Vec<String> = vec![];
        let text = "Check https://github.com/anthropic/shodh for details.";
        let entities = cold_start_extract_entities(text, &existing);
        assert!(
            entities.iter().any(|e| e.starts_with("https://")),
            "Should extract URL: {entities:?}"
        );
    }

    #[test]
    fn test_cold_start_file_paths() {
        let existing: Vec<String> = vec![];
        let text = "Edit the file at /src/main.rs and ./config/settings.toml for configuration.";
        let entities = cold_start_extract_entities(text, &existing);
        assert!(
            entities
                .iter()
                .any(|e| e.contains("/src/main.rs") || e.contains("./config/settings.toml")),
            "Should extract file paths: {entities:?}"
        );
    }

    #[test]
    fn test_cold_start_version_numbers() {
        let existing: Vec<String> = vec![];
        let text = "Upgraded from v1.2.3 to 2.0.0-rc1 yesterday.";
        let entities = cold_start_extract_entities(text, &existing);
        assert!(
            entities.iter().any(|e| e == "v1.2.3"),
            "Should extract version v1.2.3: {entities:?}"
        );
        assert!(
            entities.iter().any(|e| e == "2.0.0-rc1"),
            "Should extract version 2.0.0-rc1: {entities:?}"
        );
    }

    #[test]
    fn test_cold_start_camel_case_tech() {
        let existing: Vec<String> = vec![];
        let text = "We use PostgreSQL with GraphQL and FastAPI for the backend.";
        let entities = cold_start_extract_entities(text, &existing);
        let lower: Vec<String> = entities.iter().map(|e| e.to_lowercase()).collect();
        assert!(
            lower.contains(&"postgresql".to_string()),
            "Should extract CamelCase tech: {entities:?}"
        );
        assert!(
            lower.contains(&"graphql".to_string()),
            "Should extract CamelCase tech: {entities:?}"
        );
        assert!(
            lower.contains(&"fastapi".to_string()),
            "Should extract CamelCase tech: {entities:?}"
        );
    }

    #[test]
    fn test_cold_start_dedup_with_existing() {
        let existing = vec!["PostgreSQL".to_string(), "Caroline".to_string()];
        let text = "Caroline uses PostgreSQL and GraphQL at Anthropic.";
        let entities = cold_start_extract_entities(text, &existing);

        // Should NOT re-extract existing entities
        let lower: Vec<String> = entities.iter().map(|e| e.to_lowercase()).collect();
        assert!(
            !lower.contains(&"postgresql".to_string()),
            "Should not duplicate existing entity 'PostgreSQL': {entities:?}"
        );
        assert!(
            !lower.contains(&"caroline".to_string()),
            "Should not duplicate existing entity 'Caroline': {entities:?}"
        );
        // But should still extract new ones
        assert!(
            lower.contains(&"graphql".to_string()) || lower.contains(&"anthropic".to_string()),
            "Should still extract new entities: {entities:?}"
        );
    }

    #[test]
    fn test_cold_start_skips_sentence_start_common_words() {
        let existing: Vec<String> = vec![];
        let text = "The system is running. However, it needs updates. Also check the logs.";
        let entities = cold_start_extract_entities(text, &existing);

        // Common words at sentence starts should NOT be extracted
        let lower: Vec<String> = entities.iter().map(|e| e.to_lowercase()).collect();
        assert!(
            !lower.contains(&"the".to_string()),
            "Should not extract 'The': {entities:?}"
        );
        assert!(
            !lower.contains(&"however".to_string()),
            "Should not extract 'However': {entities:?}"
        );
        assert!(
            !lower.contains(&"also".to_string()),
            "Should not extract 'Also': {entities:?}"
        );
    }

    #[test]
    fn test_is_camel_case() {
        assert!(is_camel_case("PostgreSQL"));
        assert!(is_camel_case("GraphQL"));
        assert!(is_camel_case("FastAPI"));
        assert!(is_camel_case("RocksDB"));
        assert!(!is_camel_case("USA")); // All caps = acronym, not CamelCase
        assert!(!is_camel_case("hello")); // All lowercase
        assert!(!is_camel_case("Hi")); // Too short
        assert!(!is_camel_case("CONSTANT")); // All uppercase
    }

    #[test]
    fn test_is_acronym() {
        assert!(is_acronym("USA"));
        assert!(is_acronym("API"));
        assert!(is_acronym("AWS"));
        assert!(is_acronym("S3")); // Uppercase + digit
        assert!(!is_acronym("A")); // Too short (1 char)
        assert!(!is_acronym("TOOLONGACRONYM")); // Too long (>6)
        assert!(!is_acronym("hello")); // Not uppercase
    }

    #[test]
    fn test_is_version_number() {
        assert!(is_version_number("v1.2.3"));
        assert!(is_version_number("2.0.0"));
        assert!(is_version_number("2.0.0-rc1"));
        assert!(is_version_number("V1.0.0-beta.2"));
        assert!(!is_version_number("hello"));
        assert!(!is_version_number("v"));
        assert!(!is_version_number("123")); // No dot
        assert!(!is_version_number(""));
    }
}
