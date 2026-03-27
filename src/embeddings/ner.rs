//! Neural Named Entity Recognition using ONNX Runtime
//!
//! Implements lightweight NER optimized for edge devices:
//! - Model: bert-tiny-NER (ONNX exported, ~17MB)
//! - Labels: PER, ORG, LOC, MISC with BIO tagging
//! - Accuracy: ~85% F1 on CoNLL-2003
//! - Latency: ~10-15ms per inference
//!
//! This provides neural NER quality while staying lightweight enough
//! for edge deployment alongside MiniLM embeddings.
//!
//! # Architecture
//! - Input: Raw text
//! - Tokenization: WordPiece (BERT tokenizer)
//! - Model: TinyBERT for token classification (4.4M params)
//! - Output: BIO-tagged entities with confidence scores
//!
//! # Supported Entity Types
//! - PER: Person names (maps to EntityLabel::Person)
//! - ORG: Organizations (maps to EntityLabel::Organization)
//! - LOC: Locations (maps to EntityLabel::Location)
//! - MISC: Miscellaneous entities (maps to EntityLabel::Other)
//!
//! # Edge Device Optimizations
//! - Quantized INT8 model (~17MB vs 400MB for bert-base)
//! - Max sequence length: 128 (vs 512 for base)
//! - Shared ONNX runtime with embeddings model
//! - Lazy loading - only loads when first used

use anyhow::{Context, Result};
use ort::session::Session;
use ort::value::Value;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tokenizers::Tokenizer;

/// BIO tag labels from TinyBERT-finetuned-NER-ONNX
/// Index mapping: O=0, B-MISC=1, I-MISC=2, B-ORG=3, I-ORG=4, B-LOC=5, I-LOC=6, B-PER=7, I-PER=8
/// Note: This ordering differs from bert-base-NER (dslim) which uses MISC, PER, ORG, LOC
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NerTag {
    Outside,
    BeginMisc,
    InsideMisc,
    BeginOrg,
    InsideOrg,
    BeginLoc,
    InsideLoc,
    BeginPerson,
    InsidePerson,
}

impl NerTag {
    fn from_index(idx: usize) -> Self {
        match idx {
            0 => NerTag::Outside,
            1 => NerTag::BeginMisc,
            2 => NerTag::InsideMisc,
            3 => NerTag::BeginOrg,
            4 => NerTag::InsideOrg,
            5 => NerTag::BeginLoc,
            6 => NerTag::InsideLoc,
            7 => NerTag::BeginPerson,
            8 => NerTag::InsidePerson,
            _ => NerTag::Outside,
        }
    }

    fn is_begin(&self) -> bool {
        matches!(
            self,
            NerTag::BeginMisc | NerTag::BeginPerson | NerTag::BeginOrg | NerTag::BeginLoc
        )
    }

    fn is_inside(&self) -> bool {
        matches!(
            self,
            NerTag::InsideMisc | NerTag::InsidePerson | NerTag::InsideOrg | NerTag::InsideLoc
        )
    }

    fn entity_type(&self) -> Option<NerEntityType> {
        match self {
            NerTag::BeginPerson | NerTag::InsidePerson => Some(NerEntityType::Person),
            NerTag::BeginOrg | NerTag::InsideOrg => Some(NerEntityType::Organization),
            NerTag::BeginLoc | NerTag::InsideLoc => Some(NerEntityType::Location),
            NerTag::BeginMisc | NerTag::InsideMisc => Some(NerEntityType::Misc),
            NerTag::Outside => None,
        }
    }

    fn matches_type(&self, other: &NerTag) -> bool {
        self.entity_type() == other.entity_type()
    }
}

/// Entity types from NER model
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
}

/// A recognized entity from neural NER
#[derive(Debug, Clone)]
pub struct NerEntity {
    /// The entity text (e.g., "Microsoft", "New York")
    pub text: String,
    /// Entity type
    pub entity_type: NerEntityType,
    /// Confidence score (0.0 - 1.0)
    pub confidence: f32,
    /// Start character offset in original text
    pub start: usize,
    /// End character offset in original text
    pub end: usize,
}

/// Configuration for NER model
#[derive(Debug, Clone)]
pub struct NerConfig {
    /// Path to ONNX model file
    pub model_path: PathBuf,
    /// Path to tokenizer file
    pub tokenizer_path: PathBuf,
    /// Maximum sequence length (BERT default: 512)
    pub max_length: usize,
    /// Minimum confidence threshold for entity extraction
    pub confidence_threshold: f32,
}

impl Default for NerConfig {
    fn default() -> Self {
        Self::from_env()
    }
}

impl NerConfig {
    /// Create configuration from environment variables
    pub fn from_env() -> Self {
        let base_path = std::env::var("SHODH_NER_MODEL_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                // Try common locations - bundled package dir has highest priority
                let candidates: Vec<Option<PathBuf>> = vec![
                    // Bundled in Python package (highest priority for pip install)
                    std::env::var("SHODH_PACKAGE_DIR")
                        .ok()
                        .map(|p| PathBuf::from(p).join("models/bert-tiny-ner")),
                    // Local development paths
                    Some(PathBuf::from("./models/bert-tiny-ner")),
                    Some(PathBuf::from("../models/bert-tiny-ner")),
                    // Downloaded models cache
                    Some(super::downloader::get_ner_models_dir()),
                    // System data directory
                    dirs::data_dir().map(|p| p.join("shodh-memory/models/bert-tiny-ner")),
                ];

                candidates
                    .into_iter()
                    .flatten()
                    .find(|p| p.join("model.onnx").exists())
                    .unwrap_or_else(super::downloader::get_ner_models_dir)
            });

        let confidence_threshold = std::env::var("SHODH_NER_CONFIDENCE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.7);

        Self {
            model_path: base_path.join("model.onnx"),
            tokenizer_path: base_path.join("tokenizer.json"),
            // bert-tiny uses shorter sequences for speed (128 vs 512)
            max_length: 128,
            confidence_threshold,
        }
    }
}

/// Lazily initialized NER model
struct LazyNerModel {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
}

impl LazyNerModel {
    fn new(config: &NerConfig) -> Result<Self> {
        // macOS ARM64: default to 1 thread to avoid Eigen thread pool
        // spin-to-block deadlock on heterogeneous P/E cores.
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        let default_threads = 1;
        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        let default_threads = 2;

        let num_threads = std::env::var("SHODH_ONNX_THREADS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(default_threads);

        tracing::info!(
            "Loading BERT-NER model from {:?} with {} threads",
            config.model_path,
            num_threads
        );

        let builder = Session::builder()
            .context("Failed to create NER session builder")?
            .with_intra_threads(num_threads)
            .context("Failed to set NER intra thread count")?
            .with_inter_threads(1)
            .context("Failed to set NER inter thread count")?;

        // Disable thread pool spinning to prevent Eigen spin-to-block deadlock
        // on macOS ARM64 heterogeneous cores (P-core/E-core architecture).
        // See: microsoft/onnxruntime#10270, pykeio/ort#516
        let builder = builder
            .with_intra_op_spinning(false)
            .context("Failed to disable NER intra-op spinning")?
            .with_inter_op_spinning(false)
            .context("Failed to disable NER inter-op spinning")?;

        let session = builder
            .commit_from_file(&config.model_path)
            .context("Failed to load NER ONNX model")?;

        let tokenizer = Tokenizer::from_file(&config.tokenizer_path)
            .map_err(|e| anyhow::anyhow!("Failed to load NER tokenizer: {e}"))?;

        tracing::info!("BERT-NER model loaded successfully");

        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
        })
    }
}

/// Cache size for NER results (number of unique texts)
const NER_CACHE_SIZE: u64 = 1000;

/// Neural NER model using BERT + ONNX Runtime
pub struct NeuralNer {
    config: NerConfig,
    lazy_model: OnceLock<Result<Arc<LazyNerModel>, String>>,
    /// Fallback: rule-based extraction when model unavailable
    use_fallback: bool,
    /// Lazy-loaded EntityExtractor for comprehensive rule-based fallback
    entity_extractor: OnceLock<crate::graph_memory::EntityExtractor>,
    /// LRU cache for extracted entities (keyed by text hash)
    /// Avoids re-processing identical texts
    entity_cache: moka::sync::Cache<u64, Vec<NerEntity>>,
}

impl NeuralNer {
    /// Create new NER model with lazy loading
    pub fn new(config: NerConfig) -> Result<Self> {
        let model_available = config.model_path.exists() && config.tokenizer_path.exists();

        let cache = moka::sync::Cache::builder()
            .max_capacity(NER_CACHE_SIZE)
            .time_to_live(std::time::Duration::from_secs(3600)) // 1 hour TTL
            .build();

        if !model_available {
            tracing::warn!(
                "NER model not found at {:?}. Using rule-based fallback.",
                config.model_path
            );
            return Ok(Self {
                config,
                lazy_model: OnceLock::new(),
                use_fallback: true,
                entity_extractor: OnceLock::new(),
                entity_cache: cache,
            });
        }

        Ok(Self {
            config,
            lazy_model: OnceLock::new(),
            use_fallback: false,
            entity_extractor: OnceLock::new(),
            entity_cache: cache,
        })
    }

    /// Create NER model with explicit fallback mode
    pub fn new_fallback(config: NerConfig) -> Self {
        Self {
            config,
            lazy_model: OnceLock::new(),
            use_fallback: true,
            entity_extractor: OnceLock::new(),
            entity_cache: moka::sync::Cache::builder()
                .max_capacity(NER_CACHE_SIZE)
                .time_to_live(std::time::Duration::from_secs(3600))
                .build(),
        }
    }

    /// Ensure model is loaded
    fn ensure_model_loaded(&self) -> Result<&Arc<LazyNerModel>> {
        if self.use_fallback {
            anyhow::bail!("NER model in fallback mode");
        }

        let result = self.lazy_model.get_or_init(|| {
            LazyNerModel::new(&self.config)
                .map(Arc::new)
                .map_err(|e| e.to_string())
        });

        match result {
            Ok(model) => Ok(model),
            Err(e) => Err(anyhow::anyhow!("Failed to load NER model: {e}")),
        }
    }

    /// Check if using fallback mode
    pub fn is_fallback_mode(&self) -> bool {
        self.use_fallback
    }

    /// Compute cache key from text (FNV-1a hash for speed)
    fn cache_key(text: &str) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut hasher);
        hasher.finish()
    }

    /// Extract entities using neural NER (with caching)
    pub fn extract(&self, text: &str) -> Result<Vec<NerEntity>> {
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }

        // Check cache first
        let cache_key = Self::cache_key(text);
        if let Some(cached) = self.entity_cache.get(&cache_key) {
            return Ok(cached);
        }

        // Extract entities
        let entities = if self.use_fallback {
            self.extract_fallback(text)?
        } else {
            match self.extract_neural(text) {
                Ok(entities) => entities,
                Err(e) => {
                    tracing::warn!("Neural NER failed: {}. Using fallback.", e);
                    self.extract_fallback(text)?
                }
            }
        };

        // Cache the result
        self.entity_cache.insert(cache_key, entities.clone());

        Ok(entities)
    }

    /// Extract entities from multiple texts in batch
    ///
    /// More efficient than calling extract() repeatedly because:
    /// 1. Checks cache for all texts first
    /// 2. Batches uncached texts for ONNX inference
    /// 3. Reduces lock contention on the ONNX session
    ///
    /// # Arguments
    /// * `texts` - Slice of texts to process
    ///
    /// # Returns
    /// Vector of entity vectors, one per input text
    pub fn extract_batch(&self, texts: &[&str]) -> Result<Vec<Vec<NerEntity>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        let mut results = vec![Vec::new(); texts.len()];
        let mut uncached_indices = Vec::new();
        let mut uncached_texts = Vec::new();

        // First pass: check cache
        for (i, &text) in texts.iter().enumerate() {
            if text.trim().is_empty() {
                continue;
            }

            let cache_key = Self::cache_key(text);
            if let Some(cached) = self.entity_cache.get(&cache_key) {
                results[i] = cached;
            } else {
                uncached_indices.push(i);
                uncached_texts.push(text);
            }
        }

        // Process uncached texts
        if !uncached_texts.is_empty() {
            if self.use_fallback {
                // Fallback mode: process one by one (rule-based is fast anyway)
                for (idx, text) in uncached_indices.iter().zip(uncached_texts.iter()) {
                    let entities = self.extract_fallback(text)?;
                    self.entity_cache
                        .insert(Self::cache_key(text), entities.clone());
                    results[*idx] = entities;
                }
            } else {
                // Neural mode: batch inference
                match self.extract_neural_batch(&uncached_texts) {
                    Ok(batch_results) => {
                        for ((idx, text), entities) in uncached_indices
                            .iter()
                            .zip(uncached_texts.iter())
                            .zip(batch_results.into_iter())
                        {
                            self.entity_cache
                                .insert(Self::cache_key(text), entities.clone());
                            results[*idx] = entities;
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Batch NER failed: {}. Using fallback.", e);
                        for (idx, text) in uncached_indices.iter().zip(uncached_texts.iter()) {
                            let entities = self.extract_fallback(text)?;
                            self.entity_cache
                                .insert(Self::cache_key(text), entities.clone());
                            results[*idx] = entities;
                        }
                    }
                }
            }
        }

        Ok(results)
    }

    /// Batch neural extraction using ONNX model
    ///
    /// Processes multiple texts in a single ONNX inference call.
    /// More efficient than sequential calls due to GPU/CPU parallelism.
    fn extract_neural_batch(&self, texts: &[&str]) -> Result<Vec<Vec<NerEntity>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        // For small batches, sequential is actually faster (avoids tensor reshaping overhead)
        if texts.len() <= 2 {
            let mut results = Vec::with_capacity(texts.len());
            for text in texts {
                results.push(self.extract_neural(text)?);
            }
            return Ok(results);
        }

        let model = self.ensure_model_loaded()?;
        let max_length = self.config.max_length;
        let batch_size = texts.len();

        // Tokenize all texts
        let mut all_encodings = Vec::with_capacity(batch_size);
        for text in texts {
            let encoding = model
                .tokenizer
                .encode(*text, true)
                .map_err(|e| anyhow::anyhow!("NER batch tokenization failed: {e}"))?;
            all_encodings.push(encoding);
        }

        // Prepare batched input tensors
        let mut input_ids = vec![0i64; batch_size * max_length];
        let mut attention_mask = vec![0i64; batch_size * max_length];
        let token_type_ids = vec![0i64; batch_size * max_length];

        for (batch_idx, encoding) in all_encodings.iter().enumerate() {
            let tokens = encoding.get_ids();
            let attention = encoding.get_attention_mask();
            let base = batch_idx * max_length;

            for (i, &token) in tokens.iter().take(max_length).enumerate() {
                input_ids[base + i] = token as i64;
            }
            for (i, &mask) in attention.iter().take(max_length).enumerate() {
                attention_mask[base + i] = mask as i64;
            }
        }

        // Create ONNX input tensors
        let input_ids_value = Value::from_array((vec![batch_size, max_length], input_ids))
            .context("Failed to create batched input_ids tensor")?;
        let attention_mask_value =
            Value::from_array((vec![batch_size, max_length], attention_mask.clone()))
                .context("Failed to create batched attention_mask tensor")?;
        let token_type_ids_value =
            Value::from_array((vec![batch_size, max_length], token_type_ids))
                .context("Failed to create batched token_type_ids tensor")?;

        // Run batch inference
        let mut session = match model
            .session
            .try_lock_for(std::time::Duration::from_secs(30))
        {
            Some(guard) => guard,
            None => {
                tracing::warn!("NER batch session lock timeout after 30s, returning empty results");
                crate::metrics::NER_LOCK_TIMEOUT_TOTAL.inc();
                return Ok(vec![Vec::new(); texts.len()]);
            }
        };
        let outputs = session
            .run(ort::inputs![
                "input_ids" => &input_ids_value,
                "attention_mask" => &attention_mask_value,
                "token_type_ids" => &token_type_ids_value,
            ])
            .context("NER batch inference failed")?;

        // Extract logits - shape: [batch_size, seq_len, num_labels]
        let output_tensor = outputs[0]
            .try_extract_tensor::<f32>()
            .context("Failed to extract NER batch output tensor")?;
        let (_shape, logits) = output_tensor;

        // Decode entities for each text in batch
        let num_labels = 9;
        let mut all_entities = Vec::with_capacity(batch_size);

        for (batch_idx, encoding) in all_encodings.iter().enumerate() {
            let text = texts[batch_idx];
            let offsets = encoding.get_offsets();
            let tokens = encoding.get_ids();
            let seq_len = tokens.len().min(max_length);

            let batch_offset = batch_idx * max_length * num_labels;
            let batch_attention = &attention_mask[batch_idx * max_length..];

            let mut entities = Vec::new();
            let mut current_entity: Option<(NerTag, Vec<usize>, f32)> = None;

            #[allow(clippy::needless_range_loop)] // Index used for both array access and arithmetic
            for i in 0..seq_len {
                if i == 0 || batch_attention[i] == 0 {
                    continue;
                }

                let start_idx = batch_offset + i * num_labels;
                let token_logits = &logits[start_idx..start_idx + num_labels];

                // Find highest probability label without allocating a Vec
                let Some((best_idx, best_prob)) = argmax_softmax(token_logits) else {
                    continue; // Empty probs (shouldn't happen, but defensive)
                };

                let tag = NerTag::from_index(best_idx);

                match (&current_entity, tag.is_begin(), tag.is_inside()) {
                    (None, true, _) => {
                        current_entity = Some((tag, vec![i], best_prob));
                    }
                    (Some((prev_tag, _indices, _acc_prob)), _, true)
                        if tag.matches_type(prev_tag) =>
                    {
                        // Take ownership to extend indices in-place (avoids clone)
                        if let Some((prev_tag, mut indices, acc_prob)) = current_entity.take() {
                            indices.push(i);
                            current_entity = Some((prev_tag, indices, acc_prob + best_prob));
                        }
                    }
                    (Some((_prev_tag, _indices, _acc_prob)), _, _) => {
                        if let Some((prev_tag, indices, acc_prob)) = current_entity.take() {
                            if let Some(entity) =
                                self.build_entity(text, &prev_tag, &indices, acc_prob, offsets)
                            {
                                if entity.confidence >= self.config.confidence_threshold {
                                    entities.push(entity);
                                }
                            }
                        }
                        if tag.is_begin() {
                            current_entity = Some((tag, vec![i], best_prob));
                        } else {
                            current_entity = None;
                        }
                    }
                    _ => {}
                }
            }

            if let Some((tag, indices, acc_prob)) = current_entity {
                if let Some(entity) = self.build_entity(text, &tag, &indices, acc_prob, offsets) {
                    if entity.confidence >= self.config.confidence_threshold {
                        entities.push(entity);
                    }
                }
            }

            let entities = self.deduplicate_entities(entities);
            all_entities.push(entities);
        }

        Ok(all_entities)
    }

    /// Get cache statistics
    pub fn cache_stats(&self) -> (u64, u64) {
        (self.entity_cache.entry_count(), NER_CACHE_SIZE)
    }

    /// Clear the entity cache
    pub fn clear_cache(&self) {
        self.entity_cache.invalidate_all();
    }

    /// Neural extraction using ONNX model
    fn extract_neural(&self, text: &str) -> Result<Vec<NerEntity>> {
        let model = self.ensure_model_loaded()?;
        let mut session = match model
            .session
            .try_lock_for(std::time::Duration::from_secs(30))
        {
            Some(guard) => guard,
            None => {
                tracing::warn!("NER session lock timeout after 30s, returning empty");
                crate::metrics::NER_LOCK_TIMEOUT_TOTAL.inc();
                return Ok(Vec::new());
            }
        };

        // Tokenize input
        let encoding = model
            .tokenizer
            .encode(text, true)
            .map_err(|e| anyhow::anyhow!("NER tokenization failed: {e}"))?;

        let tokens = encoding.get_ids();
        let attention_mask = encoding.get_attention_mask();
        let offsets = encoding.get_offsets();
        let max_length = self.config.max_length;

        // Prepare input tensors
        let mut input_ids = vec![0i64; max_length];
        let mut attention = vec![0i64; max_length];

        for (i, &token) in tokens.iter().take(max_length).enumerate() {
            input_ids[i] = token as i64;
        }
        for (i, &mask) in attention_mask.iter().take(max_length).enumerate() {
            attention[i] = mask as i64;
        }

        // Create ONNX input tensors
        // token_type_ids: all zeros for single sentence (BERT segment embedding)
        let token_type_ids = vec![0i64; max_length];

        let input_ids_value = Value::from_array((vec![1, max_length], input_ids))
            .context("Failed to create input_ids tensor")?;
        let attention_mask_value = Value::from_array((vec![1, max_length], attention.clone()))
            .context("Failed to create attention_mask tensor")?;
        let token_type_ids_value = Value::from_array((vec![1, max_length], token_type_ids))
            .context("Failed to create token_type_ids tensor")?;

        // Run inference
        let outputs = session
            .run(ort::inputs![
                "input_ids" => &input_ids_value,
                "attention_mask" => &attention_mask_value,
                "token_type_ids" => &token_type_ids_value,
            ])
            .context("NER inference failed")?;

        // Extract logits - shape: [1, seq_len, num_labels]
        let output_tensor = outputs[0]
            .try_extract_tensor::<f32>()
            .context("Failed to extract NER output tensor")?;
        let (_shape, logits) = output_tensor;

        // Decode BIO tags to entities
        let num_labels = 9; // O, B-MISC, I-MISC, B-PER, I-PER, B-ORG, I-ORG, B-LOC, I-LOC
        let seq_len = tokens.len().min(max_length);

        let mut entities = Vec::new();
        let mut current_entity: Option<(NerTag, Vec<usize>, f32)> = None;

        #[allow(clippy::needless_range_loop)] // Index used for both array access and arithmetic
        for i in 0..seq_len {
            // Skip [CLS] and [SEP] tokens
            if i == 0 || attention[i] == 0 {
                continue;
            }

            // Get logits for this position
            let start_idx = i * num_labels;
            let token_logits = &logits[start_idx..start_idx + num_labels];

            // Find best label without allocating a Vec
            let Some((best_idx, best_prob)) = argmax_softmax(token_logits) else {
                continue; // Empty probs (shouldn't happen, but defensive)
            };

            let tag = NerTag::from_index(best_idx);

            // Handle BIO tagging
            match (&current_entity, tag.is_begin(), tag.is_inside()) {
                // Begin new entity
                (None, true, _) => {
                    current_entity = Some((tag, vec![i], best_prob));
                }
                // Continue current entity
                (Some((prev_tag, _indices, _acc_prob)), _, true) if tag.matches_type(prev_tag) => {
                    // Take ownership to extend indices in-place (avoids clone)
                    if let Some((prev_tag, mut indices, acc_prob)) = current_entity.take() {
                        indices.push(i);
                        current_entity = Some((prev_tag, indices, acc_prob + best_prob));
                    }
                }
                // End current entity, possibly start new
                (Some((_prev_tag, _indices, _acc_prob)), _, _) => {
                    // Save previous entity
                    if let Some((prev_tag, indices, acc_prob)) = current_entity.take() {
                        if let Some(entity) =
                            self.build_entity(text, &prev_tag, &indices, acc_prob, offsets)
                        {
                            if entity.confidence >= self.config.confidence_threshold {
                                entities.push(entity);
                            }
                        }
                    }

                    // Start new entity if this is a B- tag
                    if tag.is_begin() {
                        current_entity = Some((tag, vec![i], best_prob));
                    } else {
                        current_entity = None;
                    }
                }
                _ => {}
            }
        }

        // Don't forget the last entity
        if let Some((tag, indices, acc_prob)) = current_entity {
            if let Some(entity) = self.build_entity(text, &tag, &indices, acc_prob, offsets) {
                if entity.confidence >= self.config.confidence_threshold {
                    entities.push(entity);
                }
            }
        }

        // Deduplicate and merge overlapping entities
        let entities = self.deduplicate_entities(entities);

        Ok(entities)
    }

    /// Build entity from token indices
    fn build_entity(
        &self,
        text: &str,
        tag: &NerTag,
        token_indices: &[usize],
        accumulated_prob: f32,
        offsets: &[(usize, usize)],
    ) -> Option<NerEntity> {
        if token_indices.is_empty() {
            return None;
        }

        let entity_type = tag.entity_type()?;

        // Get character offsets
        let first_idx = token_indices[0];
        let last_idx = token_indices[token_indices.len() - 1];

        if first_idx >= offsets.len() || last_idx >= offsets.len() {
            return None;
        }

        let start = offsets[first_idx].0;
        let end = offsets[last_idx].1;

        if start >= end || end > text.len() {
            return None;
        }

        let entity_text = text[start..end].trim().to_string();
        if entity_text.is_empty() {
            return None;
        }

        // Average confidence over all tokens
        let confidence = accumulated_prob / token_indices.len() as f32;

        Some(NerEntity {
            text: entity_text,
            entity_type,
            confidence,
            start,
            end,
        })
    }

    /// Deduplicate entities (prefer longer spans with higher confidence)
    fn deduplicate_entities(&self, mut entities: Vec<NerEntity>) -> Vec<NerEntity> {
        if entities.len() <= 1 {
            return entities;
        }

        // Sort by start position, then by length (descending)
        entities.sort_by(|a, b| {
            a.start
                .cmp(&b.start)
                .then_with(|| (b.end - b.start).cmp(&(a.end - a.start)))
        });

        let mut result = Vec::new();
        let mut seen_spans: HashSet<(usize, usize)> = HashSet::new();

        for entity in entities {
            // Check if this span overlaps with any seen span
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

    /// Fallback rule-based extraction using comprehensive EntityExtractor
    ///
    /// Uses the sophisticated EntityExtractor from graph_memory which provides:
    /// - 100+ organization keywords (Indian companies, global tech, startups)
    /// - 50+ location keywords (cities, countries, regions)
    /// - Person name detection with indicators (Mr, Dr, etc.)
    /// - Technology keyword matching (Rust, Python, AWS, etc.)
    /// - Proper noun detection based on capitalization patterns
    /// - Salience scoring based on entity type and context
    fn extract_fallback(&self, text: &str) -> Result<Vec<NerEntity>> {
        use crate::graph_memory::{EntityExtractor, EntityLabel};

        // Lazy-load the EntityExtractor (1000+ lines of dictionaries, only init once)
        let extractor = self.entity_extractor.get_or_init(EntityExtractor::new);

        // Extract entities with salience information
        let extracted = extractor.extract_with_salience(text);

        // Convert EntityLabel to NerEntityType and build NerEntity structs
        let entities: Vec<NerEntity> = extracted
            .into_iter()
            .map(|e| {
                let entity_type = match e.label {
                    EntityLabel::Person => NerEntityType::Person,
                    EntityLabel::Organization => NerEntityType::Organization,
                    EntityLabel::Location => NerEntityType::Location,
                    EntityLabel::Technology
                    | EntityLabel::Concept
                    | EntityLabel::Event
                    | EntityLabel::Date
                    | EntityLabel::Product
                    | EntityLabel::Skill
                    | EntityLabel::Keyword
                    | EntityLabel::Other(_) => NerEntityType::Misc,
                };

                // Use salience as confidence (scaled appropriately)
                // EntityExtractor returns salience 0.6-0.9, map to confidence 0.5-0.85
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
                    .unwrap_or((0, name_len.min(text.len())));

                NerEntity {
                    text: e.name,
                    entity_type,
                    confidence,
                    start,
                    end,
                }
            })
            .collect();

        Ok(entities)
    }
}

/// Return (argmax_index, softmax_probability) without allocating a Vec.
pub fn argmax_softmax(logits: &[f32]) -> Option<(usize, f32)> {
    if logits.is_empty() {
        return None;
    }
    let max_logit = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let exp_sum: f32 = logits.iter().map(|x| (x - max_logit).exp()).sum();
    logits
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(idx, &val)| (idx, (val - max_logit).exp() / exp_sum))
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

    let existing_lower: HashSet<String> = existing_entities
        .iter()
        .map(|e| e.to_lowercase())
        .collect();

    let mut extracted: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = existing_lower;

    // Common stop words that appear capitalized at sentence starts
    let stop_words: HashSet<&str> = [
        "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "could",
        "should", "may", "might", "shall", "can", "need", "must", "it", "its",
        "this", "that", "these", "those", "i", "we", "you", "he", "she", "they",
        "me", "him", "her", "us", "them", "my", "your", "his", "our", "their",
        "what", "which", "who", "whom", "where", "when", "why", "how",
        "not", "no", "nor", "but", "or", "and", "if", "then", "else",
        "for", "from", "with", "without", "about", "between", "through",
        "during", "before", "after", "above", "below", "to", "of", "in", "on",
        "at", "by", "up", "out", "off", "over", "under", "again", "further",
        "once", "here", "there", "all", "each", "every", "both", "few", "more",
        "most", "other", "some", "such", "only", "own", "same", "so", "than",
        "too", "very", "just", "because", "as", "until", "while", "also",
        "however", "although", "since", "already", "still", "yet", "now",
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
            prev.ends_with('.') || prev.ends_with('!') || prev.ends_with('?')
                || prev.ends_with(':')
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
                        if after.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) {
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
        let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '@' && c != '.' && c != '-' && c != '_' && c != '+');
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
        let clean = word.trim_matches(|c: char| c == '(' || c == ')' || c == '<' || c == '>' || c == '"' || c == '\'');
        if (clean.starts_with("http://") || clean.starts_with("https://"))
            && clean.len() > 10
        {
            let lower = clean.to_lowercase();
            if !seen.contains(&lower) {
                seen.insert(lower);
                extracted.push(clean.to_string());
            }
        }
    }

    // --- 4. File paths ---
    for word in &words {
        let clean = word.trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == '(' || c == ')' || c == ',');
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

    // ==================== NerTag Tests ====================

    #[test]
    fn test_ner_tag_from_index() {
        // TinyBERT-finetuned-NER-ONNX label order: O, MISC, ORG, LOC, PER
        assert_eq!(NerTag::from_index(0), NerTag::Outside);
        assert_eq!(NerTag::from_index(1), NerTag::BeginMisc);
        assert_eq!(NerTag::from_index(2), NerTag::InsideMisc);
        assert_eq!(NerTag::from_index(3), NerTag::BeginOrg);
        assert_eq!(NerTag::from_index(4), NerTag::InsideOrg);
        assert_eq!(NerTag::from_index(5), NerTag::BeginLoc);
        assert_eq!(NerTag::from_index(6), NerTag::InsideLoc);
        assert_eq!(NerTag::from_index(7), NerTag::BeginPerson);
        assert_eq!(NerTag::from_index(8), NerTag::InsidePerson);
        // Out of bounds should default to Outside
        assert_eq!(NerTag::from_index(99), NerTag::Outside);
    }

    #[test]
    fn test_tag_is_begin() {
        assert!(NerTag::BeginPerson.is_begin());
        assert!(NerTag::BeginOrg.is_begin());
        assert!(NerTag::BeginLoc.is_begin());
        assert!(NerTag::BeginMisc.is_begin());
        assert!(!NerTag::InsidePerson.is_begin());
        assert!(!NerTag::Outside.is_begin());
    }

    #[test]
    fn test_tag_is_inside() {
        assert!(NerTag::InsidePerson.is_inside());
        assert!(NerTag::InsideOrg.is_inside());
        assert!(NerTag::InsideLoc.is_inside());
        assert!(NerTag::InsideMisc.is_inside());
        assert!(!NerTag::BeginPerson.is_inside());
        assert!(!NerTag::Outside.is_inside());
    }

    #[test]
    fn test_tag_entity_type() {
        assert_eq!(
            NerTag::BeginPerson.entity_type(),
            Some(NerEntityType::Person)
        );
        assert_eq!(
            NerTag::InsidePerson.entity_type(),
            Some(NerEntityType::Person)
        );
        assert_eq!(
            NerTag::BeginOrg.entity_type(),
            Some(NerEntityType::Organization)
        );
        assert_eq!(
            NerTag::BeginLoc.entity_type(),
            Some(NerEntityType::Location)
        );
        assert_eq!(NerTag::BeginMisc.entity_type(), Some(NerEntityType::Misc));
        assert_eq!(NerTag::Outside.entity_type(), None);
    }

    #[test]
    fn test_tag_matching() {
        let b_per = NerTag::BeginPerson;
        let i_per = NerTag::InsidePerson;
        let b_org = NerTag::BeginOrg;
        let i_org = NerTag::InsideOrg;

        // Same entity type should match
        assert!(b_per.matches_type(&i_per));
        assert!(b_org.matches_type(&i_org));

        // Different entity types should not match
        assert!(!b_per.matches_type(&b_org));
        assert!(!i_per.matches_type(&i_org));
    }

    // ==================== NerEntityType Tests ====================

    #[test]
    fn test_entity_type_as_str() {
        assert_eq!(NerEntityType::Person.as_str(), "PER");
        assert_eq!(NerEntityType::Organization.as_str(), "ORG");
        assert_eq!(NerEntityType::Location.as_str(), "LOC");
        assert_eq!(NerEntityType::Misc.as_str(), "MISC");
    }

    // ==================== Softmax Tests ====================

    /// Test-only softmax (the production code uses argmax_softmax to avoid allocation).
    fn softmax(logits: &[f32]) -> Vec<f32> {
        let max_logit = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let exp_sum: f32 = logits.iter().map(|x| (x - max_logit).exp()).sum();
        logits
            .iter()
            .map(|x| (x - max_logit).exp() / exp_sum)
            .collect()
    }

    #[test]
    fn test_softmax_basic() {
        let logits = vec![1.0, 2.0, 3.0];
        let probs = softmax(&logits);

        // Sum should be 1.0
        let sum: f32 = probs.iter().sum();
        assert!((sum - 1.0).abs() < 1e-5);

        // Highest logit should have highest prob
        assert!(probs[2] > probs[1]);
        assert!(probs[1] > probs[0]);
    }

    #[test]
    fn test_softmax_uniform() {
        let logits = vec![1.0, 1.0, 1.0];
        let probs = softmax(&logits);

        // Uniform logits should give uniform probabilities
        for prob in &probs {
            assert!((*prob - 1.0 / 3.0).abs() < 1e-5);
        }
    }

    #[test]
    fn test_softmax_large_values() {
        // Test numerical stability with large values
        let logits = vec![100.0, 101.0, 102.0];
        let probs = softmax(&logits);

        let sum: f32 = probs.iter().sum();
        assert!((sum - 1.0).abs() < 1e-5);
        assert!(probs[2] > probs[1]);
    }

    #[test]
    fn test_softmax_negative_values() {
        let logits = vec![-1.0, 0.0, 1.0];
        let probs = softmax(&logits);

        let sum: f32 = probs.iter().sum();
        assert!((sum - 1.0).abs() < 1e-5);
        assert!(probs[2] > probs[1]);
        assert!(probs[1] > probs[0]);
    }

    // ==================== NerConfig Tests ====================

    #[test]
    fn test_ner_config_default() {
        let config = NerConfig::default();
        assert_eq!(config.max_length, 128); // bert-tiny uses 128
        assert!((config.confidence_threshold - 0.7).abs() < 1e-5);
    }

    // ==================== NeuralNer Fallback Tests ====================

    #[test]
    fn test_fallback_mode_detection() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);
        assert!(ner.is_fallback_mode());
    }

    #[test]
    fn test_fallback_extraction_organizations() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);

        // Test various organizations
        let test_cases = vec![
            (
                "Microsoft is a company",
                "Microsoft",
                NerEntityType::Organization,
            ),
            ("I work at Google", "Google", NerEntityType::Organization),
            (
                "Apple released a new product",
                "Apple",
                NerEntityType::Organization,
            ),
            (
                "Tata group is expanding",
                "Tata",
                NerEntityType::Organization,
            ),
            (
                "Infosys reported earnings",
                "Infosys",
                NerEntityType::Organization,
            ),
        ];

        for (text, expected_entity, expected_type) in test_cases {
            let entities = ner.extract(text).unwrap();
            let found = entities.iter().find(|e| e.text == expected_entity);
            assert!(found.is_some(), "Should find {expected_entity} in '{text}'");
            assert_eq!(
                found.unwrap().entity_type,
                expected_type,
                "Wrong type for {expected_entity} in '{text}'"
            );
        }
    }

    #[test]
    fn test_fallback_extraction_locations() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);

        // Test various locations
        let test_cases = vec![
            (
                "The office is in Seattle",
                "Seattle",
                NerEntityType::Location,
            ),
            (
                "I visited Mumbai last week",
                "Mumbai",
                NerEntityType::Location,
            ),
            ("Tokyo is beautiful", "Tokyo", NerEntityType::Location),
            ("Moving to Bangalore", "Bangalore", NerEntityType::Location),
            ("India is growing", "India", NerEntityType::Location),
        ];

        for (text, expected_entity, expected_type) in test_cases {
            let entities = ner.extract(text).unwrap();
            let found = entities.iter().find(|e| e.text == expected_entity);
            assert!(found.is_some(), "Should find {expected_entity} in '{text}'");
            assert_eq!(
                found.unwrap().entity_type,
                expected_type,
                "Wrong type for {expected_entity} in '{text}'"
            );
        }
    }

    #[test]
    fn test_fallback_extraction_mixed() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);
        let entities = ner
            .extract("Microsoft is headquartered in Seattle")
            .unwrap();

        // Should find both Microsoft (Org) and Seattle (Loc)
        let microsoft = entities.iter().find(|e| e.text == "Microsoft");
        let seattle = entities.iter().find(|e| e.text == "Seattle");

        assert!(microsoft.is_some());
        assert!(seattle.is_some());
        assert_eq!(microsoft.unwrap().entity_type, NerEntityType::Organization);
        assert_eq!(seattle.unwrap().entity_type, NerEntityType::Location);
    }

    #[test]
    fn test_fallback_extraction_empty_text() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);
        let entities = ner.extract("").unwrap();
        assert!(entities.is_empty());
    }

    #[test]
    fn test_fallback_extraction_whitespace_only() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);
        let entities = ner.extract("   \t\n  ").unwrap();
        assert!(entities.is_empty());
    }

    #[test]
    fn test_fallback_extraction_stop_words_only() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);
        // Use only stop words which should be filtered out
        let entities = ner.extract("the a an and or is are was were").unwrap();

        // Only stop words, no entities expected
        assert!(
            entities.is_empty(),
            "Expected no entities from stop words but got: {entities:?}"
        );
    }

    #[test]
    fn test_fallback_deduplication() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);
        // Microsoft mentioned twice
        let entities = ner
            .extract("Microsoft partnered with Microsoft Azure")
            .unwrap();

        // Should only have one Microsoft entry (deduplicated)
        let microsoft_count = entities.iter().filter(|e| e.text == "Microsoft").count();
        assert_eq!(microsoft_count, 1, "Microsoft should appear only once");
    }

    #[test]
    fn test_fallback_confidence_scores() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);
        let entities = ner.extract("Microsoft Google Apple").unwrap();

        for entity in &entities {
            // Fallback confidence should be reasonable (0.5-0.8 range)
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
        };

        let cloned = entity.clone();
        assert_eq!(cloned.text, entity.text);
        assert_eq!(cloned.entity_type, entity.entity_type);
        assert!((cloned.confidence - entity.confidence).abs() < 1e-5);
    }

    // ==================== Edge Case Tests ====================

    #[test]
    fn test_single_character_words() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);
        // Single character words should be skipped
        let entities = ner.extract("I A B C").unwrap();
        // Single chars are too short to be meaningful entities
        assert!(entities.is_empty() || entities.iter().all(|e| e.text.len() >= 2));
    }

    #[test]
    fn test_punctuation_handling() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);
        let entities = ner.extract("Microsoft, Google, and Apple!").unwrap();

        // Should extract entities without punctuation
        for entity in &entities {
            assert!(!entity.text.contains(','));
            assert!(!entity.text.contains('!'));
        }
    }

    #[test]
    fn test_indian_companies() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);

        // Test Indian companies specifically
        let indian_companies = vec!["Flipkart", "Zomato", "Swiggy", "Paytm"];

        for company in indian_companies {
            let entities = ner.extract(&format!("{company} is growing")).unwrap();
            let found = entities.iter().find(|e| e.text == company);
            assert!(found.is_some(), "Should find Indian company: {company}");
        }
    }

    #[test]
    fn test_indian_cities() {
        let config = NerConfig {
            model_path: PathBuf::from("nonexistent.onnx"),
            tokenizer_path: PathBuf::from("nonexistent.json"),
            max_length: 128,
            confidence_threshold: 0.5,
        };

        let ner = NeuralNer::new_fallback(config);

        // Test Indian cities specifically
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
            entities.iter().any(|e| e.contains("/src/main.rs") || e.contains("./config/settings.toml")),
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
        assert!(!is_version_number("123"));  // No dot
        assert!(!is_version_number(""));
    }
}
