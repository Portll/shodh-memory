//! Modular Query Parsing System
//!
//! Provides a trait-based abstraction for query parsing, allowing easy swapping
//! between rule-based and LLM-based implementations.
//!
//! # Architecture
//! ```text
//! Query → QueryParser (trait) → ParsedQuery
//!              ↓
//!     ┌────────┴────────┐
//!     │                 │
//! RuleBasedParser   LlmParser
//! (YAKE/regex)      (Qwen 1.5B)
//! ```
//!
//! # Usage
//! ```rust,ignore
//! let parser = create_parser(ParserConfig::default());
//! let parsed = parser.parse("When did Melanie paint a sunrise?", Some(conv_date))?;
//! ```

mod llm_parser;
mod parser_trait;
mod rule_based;

pub use llm_parser::{ApiType, LlmParser};
pub use parser_trait::*;
pub use rule_based::RuleBasedParser;

use std::sync::Arc;

/// Parser implementation type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ParserType {
    /// Rule-based parsing using YAKE, regex, and heuristics (default)
    #[default]
    RuleBased,
    /// LLM-based parsing using Qwen 1.5B or similar
    Llm,
}

/// Configuration for the query parser
///
/// `LlmParser` loads no weights of its own — it calls an OpenAI-compatible or
/// Ollama HTTP endpoint. The fields below describe that endpoint. They replaced
/// `llm_model_path`, `llm_threads` and `llm_context_size`, which described an
/// in-process model loader this parser has not used since it became an HTTP
/// client; thread and context-size knobs belong to the server now, not to us.
#[derive(Debug, Clone)]
pub struct ParserConfig {
    /// Which parser implementation to use
    pub parser_type: ParserType,
    /// Base URL of the inference server (only used if parser_type is Llm)
    pub llm_endpoint: String,
    /// Model name as the server knows it (only used if parser_type is Llm)
    pub llm_model: String,
}

impl Default for ParserConfig {
    fn default() -> Self {
        Self {
            parser_type: ParserType::RuleBased,
            // Ollama's default bind address, and a small instruct model — this
            // parser classifies queries rather than generating prose, so the
            // smallest capable model is the right default.
            llm_endpoint: "http://localhost:11434".to_string(),
            llm_model: "qwen2.5:1.5b".to_string(),
        }
    }
}

impl ParserConfig {
    /// Create config for rule-based parser
    pub fn rule_based() -> Self {
        Self::default()
    }

    /// Create config for LLM parser against a given endpoint and model.
    pub fn llm(endpoint: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            parser_type: ParserType::Llm,
            llm_endpoint: endpoint.into(),
            llm_model: model.into(),
        }
    }
}

/// Create a parser based on configuration
pub fn create_parser(config: ParserConfig) -> Arc<dyn QueryParser> {
    match config.parser_type {
        ParserType::RuleBased => Arc::new(RuleBasedParser::new()),
        #[cfg(feature = "llm-parser")]
        ParserType::Llm => {
            // `LlmParser::new` is infallible and connects lazily — there is no
            // model to load and therefore nothing here that can fail. The
            // previous `.expect("Failed to load LLM model")` panicked the
            // process on a construction that no longer returns a Result.
            Arc::new(LlmParser::new(&config.llm_endpoint, &config.llm_model))
        }
        #[cfg(not(feature = "llm-parser"))]
        ParserType::Llm => {
            tracing::warn!("LLM parser requested but 'llm-parser' feature not enabled, falling back to rule-based");
            Arc::new(RuleBasedParser::new())
        }
    }
}
