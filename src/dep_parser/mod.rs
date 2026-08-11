//! In-engine syntactic dependency parser (vendored `spacy-rusty`, en_core_web_sm).
//!
//! Provides POS + dependency-head + lemma for short entity mentions so entity
//! resolution can span-clean and pick the syntactic head of a mention
//! (`Port of Baltimore` → `Port`; `ship crashed` → verb-headed fragment). This
//! is the FROZEN base of the entity-resolution roadmap (Phase 1): the parser
//! never updates at runtime; only the resolver/matcher layers above it learn.
//!
//! The model bundle (`model.json` + `model.safetensors`, ~14.4 MiB) is EMBEDDED
//! in the binary, so the parser — and everything downstream of it — works with
//! no environment, no download and no network.
//!
//! That matters more than it sounds. The parser is not one feature: five
//! subsystems degrade to silent no-ops without it — OpenIE triple extraction,
//! CATENA causal/temporal links, appositive alias minting, entity
//! canonicalization, and entity resolution. Before this bundle was embedded, a
//! deployment with no causal backbone and no canonicalization was
//! indistinguishable from a healthy one: the guards return early and log
//! nothing at the call site. "Additive, never load-bearing" was true of any
//! single request and quietly false of the knowledge graph as a whole.
//!
//! On-disk bundles still win when present, so a newer or larger pipeline
//! (`en_core_web_md`/`lg`) can be dropped in without a rebuild. See
//! [`load_bundle`] for the resolution order.
//!
//! Concurrency: the vendored crate holds its static-vector table behind `Arc`
//! (see the crate NOTICE), so a single loaded `Pipeline` is `Send + Sync` and is
//! shared read-only across all async workers via a process-wide `OnceLock`.
//! `Pipeline::process` takes `&self`, so concurrent parses are safe.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use spacy_rusty::pipeline::Pipeline;

/// One parsed token: the fields entity resolution consumes.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedToken {
    /// Token index within the parsed text.
    pub i: usize,
    /// Surface text of the token.
    pub text: String,
    /// Index of this token's syntactic head; equals `i` for a sentence root.
    pub head: usize,
    /// Dependency label (`"ROOT"` for roots).
    pub dep: String,
    /// Coarse-grained part of speech (`PROPN`, `NOUN`, `VERB`, ...).
    pub pos: String,
    /// Fine-grained POS tag.
    pub tag: String,
    /// Rule-lemmatized form.
    pub lemma: String,
}

impl ParsedToken {
    /// True when this token is a syntactic root (`head == i`).
    #[inline]
    pub fn is_root(&self) -> bool {
        self.head == self.i
    }
}

/// Process-wide, lazily-initialized pipeline. `None` means "no model available";
/// once resolved it never changes, so the 15 MB bundle is loaded at most once.
static PIPELINE: OnceLock<Option<Arc<Pipeline>>> = OnceLock::new();

/// Build a pipeline from an explicit bundle directory. Pure (no env, no global)
/// so it is unit-testable by path — the env/`OnceLock` layer lives in
/// [`pipeline`]. Returns `None` if the manifest/weights are missing or the
/// bundle fails to construct (corrupt data), so a misconfigured model can never
/// panic a request thread.
fn load_from_dir(dir: &Path) -> Option<Arc<Pipeline>> {
    let manifest = std::fs::read_to_string(dir.join("model.json")).ok()?;
    let safetensors = std::fs::read(dir.join("model.safetensors")).ok()?;
    // Optional: enables readable vector neighbors; parsing/POS/lemma do not need
    // it, so `en_core_web_sm` (no static vectors) loads fine without it.
    let key2row = std::fs::read_to_string(dir.join("vectors_key2row.json")).ok();

    // `Pipeline::from_bytes` unwraps internally on malformed input. Contain any
    // such panic here so a bad bundle degrades to `None` instead of aborting.
    let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        Pipeline::from_bytes(&manifest, &safetensors, key2row.as_deref())
    }));
    match built {
        Ok(pipeline) => Some(Arc::new(pipeline)),
        Err(_) => {
            tracing::warn!(
                dir = %dir.display(),
                "spacy-rusty bundle failed to load; dependency parser disabled"
            );
            None
        }
    }
}

/// The embedded `en_core_web_sm` manifest. ~2.3 MiB of JSON: vocab, tokenizer
/// exceptions, lemmatizer rules and layer shapes.
const EMBEDDED_MANIFEST: &str = include_str!("en_core_web_sm/model.json");

/// The embedded `en_core_web_sm` weights. ~12.2 MiB of safetensors.
const EMBEDDED_WEIGHTS: &[u8] = include_bytes!("en_core_web_sm/model.safetensors");

/// Total embedded bundle size in bytes. Asserted by test so the figure quoted in
/// the module docs and the NOTICE cannot drift from the actual assets.
pub const EMBEDDED_BUNDLE_BYTES: usize = EMBEDDED_MANIFEST.len() + EMBEDDED_WEIGHTS.len();

/// Build the pipeline from the embedded bundle.
///
/// Same panic containment as [`load_from_dir`]: the assets are compiled in and
/// therefore cannot be corrupt in the field, but `Pipeline::from_bytes` unwraps
/// internally and a panic here would abort a request thread rather than degrade.
fn load_embedded() -> Option<Arc<Pipeline>> {
    let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // `en_core_web_sm` ships no static vectors, so there is no key2row.
        Pipeline::from_bytes(EMBEDDED_MANIFEST, EMBEDDED_WEIGHTS, None)
    }));
    match built {
        Ok(pipeline) => Some(Arc::new(pipeline)),
        Err(_) => {
            tracing::error!(
                "embedded en_core_web_sm bundle failed to load; dependency parser disabled \
                 (this should be unreachable — the bundle is compiled in)"
            );
            None
        }
    }
}

/// Resolve the `en_core_web_sm` bundle and load it.
///
/// Resolution order — on-disk overrides first, embedded last:
///   1. `SHODH_SPACY_MODEL_PATH` — explicit override.
///   2. the conventional cache dir (`~/.cache/shodh-memory/models/en_core_web_sm`),
///      mirroring how GLiNER/MiniLM auto-resolve.
///   3. a repo-relative `models/en_core_web_sm` — developer/eval convenience.
///   4. the EMBEDDED bundle — always present, so this never returns `None` in
///      practice.
///
/// The on-disk candidates are kept ahead of the embedded copy deliberately: they
/// are how a bigger pipeline (`en_core_web_md`/`lg`) or a newer export gets
/// swapped in without rebuilding, and how the parity tests pin against a
/// reference bundle. Embedding is a floor, not a ceiling.
fn load_bundle() -> Option<Arc<Pipeline>> {
    if let Some(dir) = std::env::var_os("SHODH_SPACY_MODEL_PATH") {
        if let Some(p) = load_from_dir(Path::new(&dir)) {
            return Some(p);
        }
    }
    if let Some(p) = load_from_dir(&crate::embeddings::downloader::get_spacy_models_dir()) {
        return Some(p);
    }
    if let Some(p) = load_from_dir(Path::new("models/en_core_web_sm")) {
        return Some(p);
    }
    load_embedded()
}

/// The shared pipeline, or `None` when no model is available.
pub fn pipeline() -> Option<&'static Arc<Pipeline>> {
    PIPELINE.get_or_init(load_bundle).as_ref()
}

/// Whether the dependency parser is available in this process.
pub fn is_available() -> bool {
    pipeline().is_some()
}

/// Parse `text` with an explicitly-provided pipeline (no global state). This is
/// the core used by both [`parse`] and the parity tests.
pub fn parse_with(pipeline: &Pipeline, text: &str) -> Vec<ParsedToken> {
    pipeline
        .process(text)
        .tokens
        .into_iter()
        .map(|t| ParsedToken {
            i: t.i,
            text: t.text,
            head: t.head,
            dep: t.dep,
            pos: t.pos,
            tag: t.tag,
            lemma: t.lemma,
        })
        .collect()
}

/// Parse `text` with the shared pipeline. `None` if no model is available.
pub fn parse(text: &str) -> Option<Vec<ParsedToken>> {
    let pipeline = pipeline()?;
    Some(parse_with(pipeline, text))
}

/// The syntactic head of `text`: the first sentence root (`head == i`). For a
/// short entity mention this is its head word, and the returned `pos` tells the
/// resolver whether the mention is nominal (`PROPN`/`NOUN` → keep) or a
/// verb-headed fragment (`VERB` → strip/reject). Falls back to the first token
/// for degenerate inputs. `None` if no model is available.
pub fn head_token(text: &str) -> Option<ParsedToken> {
    let tokens = parse(text)?;
    Some(head_of(&tokens))
}

/// Select the head token from an already-parsed token list: the first root, else
/// the first token. Split out (pure) so head selection is testable without a model.
fn head_of(tokens: &[ParsedToken]) -> ParsedToken {
    tokens
        .iter()
        .find(|t| t.is_root())
        .or_else(|| tokens.first())
        .cloned()
        .unwrap_or_else(|| ParsedToken {
            i: 0,
            text: String::new(),
            head: 0,
            dep: String::new(),
            pos: String::new(),
            tag: String::new(),
            lemma: String::new(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(i: usize, text: &str, head: usize, pos: &str) -> ParsedToken {
        ParsedToken {
            i,
            text: text.to_string(),
            head,
            dep: if head == i {
                "ROOT".into()
            } else {
                "dep".into()
            },
            pos: pos.to_string(),
            tag: pos.to_string(),
            lemma: text.to_lowercase(),
        }
    }

    #[test]
    fn missing_bundle_dir_yields_none() {
        // Pure loader, no env, no global: a nonexistent bundle degrades to None.
        assert!(load_from_dir(Path::new("does/not/exist/en_core_web_sm")).is_none());
    }

    #[test]
    fn head_of_picks_the_root_not_the_first_token() {
        // "Port of Baltimore" shape: root is "Port" (i=0 here) — but prove we key
        // on head==i, not position, by making the root the middle token.
        let toks = vec![
            tok(0, "the", 1, "DET"),
            tok(1, "ship", 1, "NOUN"), // root
            tok(2, "Dali", 1, "PROPN"),
        ];
        let head = head_of(&toks);
        assert_eq!(head.text, "ship");
        assert!(head.is_root());
    }

    #[test]
    fn head_of_falls_back_to_first_token_when_no_root() {
        let toks = vec![tok(0, "alpha", 1, "NOUN"), tok(1, "beta", 2, "NOUN")];
        let head = head_of(&toks);
        assert_eq!(head.text, "alpha");
    }

    #[test]
    fn head_of_empty_is_safe() {
        assert_eq!(head_of(&[]).text, "");
    }

    // ========================================================================
    // EMBEDDED BUNDLE — the parser must work with no environment at all
    // ========================================================================

    #[test]
    fn embedded_bundle_is_present_and_the_right_size() {
        // Pins the figure quoted in the module docs and the NOTICE so they
        // cannot drift from the assets actually compiled in.
        assert_eq!(EMBEDDED_MANIFEST.len(), 2_383_787, "model.json size");
        assert_eq!(EMBEDDED_WEIGHTS.len(), 12_754_752, "model.safetensors size");
        assert_eq!(EMBEDDED_BUNDLE_BYTES, 15_138_539);
    }

    #[test]
    fn embedded_bundle_loads() {
        // The load path that runs when no bundle is on disk anywhere.
        assert!(
            load_embedded().is_some(),
            "the compiled-in bundle must construct a Pipeline"
        );
    }

    #[test]
    fn parser_is_available_without_any_configuration() {
        // THE point of embedding. Five subsystems — OpenIE, CATENA, appositives,
        // canonicalization, entity resolution — are silent no-ops when this is
        // false, and nothing logs at their call sites. This test is what stops
        // that state from shipping again.
        //
        // Deliberately calls the process-wide accessor rather than
        // `load_embedded` directly: it proves the full resolution chain ends
        // somewhere real even when every on-disk candidate misses.
        assert!(
            is_available(),
            "dependency parser must be available with no env var and no download"
        );
    }

    #[test]
    fn embedded_pipeline_produces_a_real_parse() {
        // Loading is not working. Assert actual linguistic structure: a
        // dependency tree with exactly one root, and a verb identified as such —
        // this is the signal OpenIE and CATENA consume.
        let pipeline = pipeline().expect("pipeline available");
        let tokens = parse_with(
            pipeline,
            "The bridge collapsed because the ship lost power.",
        );

        assert!(tokens.len() >= 8, "got {} tokens", tokens.len());
        assert_eq!(
            tokens.iter().filter(|t| t.is_root()).count(),
            1,
            "a parsed sentence has exactly one root"
        );
        assert!(
            tokens.iter().any(|t| t.pos == "VERB"),
            "the parser must tag verbs; POS tags: {:?}",
            tokens.iter().map(|t| &t.pos).collect::<Vec<_>>()
        );
        assert!(
            tokens.iter().any(|t| t.lemma == "collapse"),
            "lemmatizer must reduce 'collapsed'; lemmas: {:?}",
            tokens.iter().map(|t| &t.lemma).collect::<Vec<_>>()
        );
    }
}
