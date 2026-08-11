//! Offline entity knowledge base: surface form → stable real-world identity.
//!
//! The canonicalizer merges surface forms it has *seen together*; GLiNER types
//! them. Neither can tell that `IBM` and `International Business Machines` are
//! one company, because that fact is not in the corpus — it is world knowledge.
//! This module supplies it, deterministically and entirely on-device, in the
//! same spirit as [`crate::gazetteer`]: a vendored asset, no network, no model,
//! and an explicit refusal to guess.
//!
//! # What "linked" means
//!
//! A linked entity carries a Wikidata QID in
//! [`EntityNode::kb_id`](crate::graph_memory::EntityNode::kb_id). Two nodes with
//! the same `kb_id` are the same real-world thing — that is the whole claim.
//! Stamping the id does **not** by itself merge the nodes; merging is a separate,
//! riskier decision gated behind `SHODH_KB_LINKING` (see
//! `GraphMemory::kb_link_entities`).
//!
//! # Resolution rules (v1)
//!
//! Candidate generation is **case-insensitive exact match** on a canonical label
//! or a known alias — no fuzzy matching, no edit distance, no prefix search. The
//! one tolerated variation is a trailing legal designator (`Inc.`, `Corp.`,
//! `GmbH`, …), stripped from both sides, so `International Business Machines`
//! reaches `International Business Machines Corporation`. That is a deterministic
//! token rule, not a similarity score.
//!
//! Disambiguation, in order:
//!
//! 1. **Type blocking.** The mention's coarse type must map to a KB type
//!    ([`kb_type_for_label`]) and the candidate must carry it. A mention typed
//!    `Person` never links to an organisation. Mentions whose type is generic
//!    (`Concept`, `Keyword`, …) are refused outright — an untyped surface carries
//!    too little evidence to link safely.
//! 2. **Sole survivor links.** Exactly one type-compatible candidate → link.
//! 3. **Dominance or abstain.** With several candidates, the most prominent must
//!    beat the runner-up by [`DOMINANCE_RATIO`]× in Wikipedia sitelink count.
//!    Otherwise the result is [`Resolution::Abstained`] and **nothing is linked**.
//!
//! Rule 3 is the load-bearing one. `ACM` is the Association for Computing
//! Machinery to a software engineer and AC Milan to everyone else; `WTO` is the
//! World Trade Organization (153 sitelinks) or the Warsaw Pact (116). A wrong
//! link is strictly worse than no link: it asserts that two distinct real-world
//! things are one, and every downstream traversal inherits the error. So the
//! default under uncertainty is to refuse.
//!
//! Note this deliberately departs from the gazetteer's population argmax. The
//! gazetteer collapses homonyms when it *builds* its index, which makes
//! abstention impossible by construction; here every candidate for a surface
//! survives into the index so the ambiguity is visible at lookup time.

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::graph_memory::EntityLabel;

/// How far the leading candidate must outrank the runner-up (in sitelinks) before
/// an ambiguous surface is linked rather than abstained on.
///
/// 5× is deliberately strict. At the floor the asset uses (12 sitelinks) the
/// leader needs ≥60 sitelinks to beat even the least prominent rival, which in
/// practice means "one candidate is famous and the rest are obscure". Measured
/// on the shipped slice, 2.0% of resolvable organisation surfaces are ambiguous
/// enough to abstain on.
pub const DOMINANCE_RATIO: u32 = 5;

/// The vendored Wikidata slice. Columns, tab separated:
/// `qid`, `type`, `sitelinks`, `label`, `aliases` (`|`-separated, may be empty).
/// See `src/kb/NOTICE` and `scripts/build_wikidata_kb.py`.
const KB_TSV: &str = include_str!("wikidata-slice.tsv");

/// Trailing legal-form designators stripped when matching company names.
/// Lowercased, matched as whole trailing tokens only.
const LEGAL_SUFFIXES: &[&str] = &[
    "inc",
    "inc.",
    "incorporated",
    "corp",
    "corp.",
    "corporation",
    "co",
    "co.",
    "company",
    "ltd",
    "ltd.",
    "limited",
    "llc",
    "l.l.c.",
    "plc",
    "p.l.c.",
    "gmbh",
    "ag",
    "sa",
    "s.a.",
    "nv",
    "n.v.",
    "bv",
    "b.v.",
    "ab",
    "oyj",
    "pty",
    "spa",
    "s.p.a.",
    "sas",
    "kgaa",
    "as",
    "a/s",
];

/// One canonical KB entity, borrowed from the embedded asset (no per-lookup alloc).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KbEntity {
    /// Wikidata QID — the stable identity, e.g. `"Q37156"`.
    pub qid: &'static str,
    /// Coarse KB type: `"organization"` or `"product"`.
    pub entity_type: &'static str,
    /// Wikipedia sitelink count: the prominence prior, and the disambiguation
    /// weight. Also a usable confidence proxy.
    pub sitelinks: u32,
    /// Canonical label, e.g. `"IBM"`.
    pub label: &'static str,
}

/// Why a surface was not linked. Kept distinct from "never heard of it" because
/// the two say very different things about coverage versus caution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbstainReason {
    /// The mention's label is generic or unsupported, so no KB type applies.
    UnsupportedMentionType,
    /// The surface is known, but not as anything of the mention's type.
    TypeMismatch,
    /// Several plausible candidates and no dominant one.
    Ambiguous,
}

/// Outcome of a link attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// Linked, with the number of type-compatible candidates that were beaten.
    Linked {
        entity: &'static KbEntity,
        competitors: usize,
    },
    /// Candidates existed but the evidence was too weak — deliberately no link.
    Abstained(AbstainReason),
    /// The surface is not in the KB at all.
    Unknown,
}

impl Resolution {
    /// The QID when linked, else `None`.
    pub fn qid(&self) -> Option<&'static str> {
        match self {
            Resolution::Linked { entity, .. } => Some(entity.qid),
            _ => None,
        }
    }
}

/// A candidate occurrence of one entity under one surface key.
#[derive(Debug, Clone, Copy)]
struct Candidate {
    entity: u32,
}

/// The loaded KB: entities plus two surface indexes.
#[derive(Debug, Default)]
pub struct EntityKb {
    entities: Vec<KbEntity>,
    /// normalized surface → candidates.
    exact: HashMap<String, Vec<Candidate>>,
    /// legal-suffix-stripped surface → candidates.
    stripped: HashMap<String, Vec<Candidate>>,
}

static GLOBAL_KB: OnceLock<EntityKb> = OnceLock::new();

/// The process-wide KB. Built once, on first use, from the vendored asset — or
/// from a replacement TSV at `SHODH_KB_PATH` for sovereign deployments that ship
/// their own curated knowledge base. The override replaces the vendored slice
/// entirely; a missing or unreadable file falls back to the vendored one.
pub fn global() -> &'static EntityKb {
    GLOBAL_KB.get_or_init(|| {
        if let Some(path) = std::env::var_os("SHODH_KB_PATH") {
            match std::fs::read_to_string(std::path::Path::new(&path)) {
                Ok(text) if !text.trim().is_empty() => {
                    let kb = EntityKb::from_tsv(Box::leak(text.into_boxed_str()));
                    tracing::info!(entities = kb.len(), "entity KB loaded (SHODH_KB_PATH)");
                    return kb;
                }
                Ok(_) => tracing::warn!("SHODH_KB_PATH is empty; using the vendored KB"),
                Err(e) => tracing::warn!("SHODH_KB_PATH unreadable ({e}); using the vendored KB"),
            }
        }
        EntityKb::from_tsv(KB_TSV)
    })
}

/// Fold a surface to its lookup key: trimmed, lowercased, whitespace collapsed.
/// Lowercasing is Unicode-aware so non-ASCII names match whatever casing was used.
fn normalize(surface: &str) -> String {
    let mut out = String::with_capacity(surface.len());
    let mut prev_space = true;
    for ch in surface.trim().chars().flat_map(char::to_lowercase) {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Strip trailing legal-form designators from an already-normalized key.
///
/// `"general electric company"` → `"general electric"`. Returns `None` when
/// nothing was stripped, or when stripping would leave too little to match on —
/// a bare `"inc"` must not become the empty string and match everything.
fn strip_legal_suffix(key: &str) -> Option<String> {
    let mut tokens: Vec<&str> = key.split(' ').filter(|t| !t.is_empty()).collect();
    let mut changed = false;
    while tokens.len() > 1 {
        let last = tokens[tokens.len() - 1];
        if LEGAL_SUFFIXES.contains(&last) {
            tokens.pop();
            changed = true;
        } else {
            break;
        }
    }
    if !changed {
        return None;
    }
    let out = tokens.join(" ");
    let out = out.trim_end_matches([',', '.', ' ']).to_string();
    if out.len() < 2 || !out.chars().any(char::is_alphabetic) {
        return None;
    }
    // What survived must be a name, not another legal designator. "co ltd"
    // reduces to "co", which is a company suffix rather than a company, and
    // letting it become a lookup key invites exactly the kind of meaningless
    // match this function exists to avoid.
    if LEGAL_SUFFIXES.contains(&out.as_str()) {
        return None;
    }
    Some(out)
}

impl EntityKb {
    /// Parse the TSV asset and build both surface indexes.
    ///
    /// Every candidate for a surface is retained — homonyms are *not* collapsed
    /// here, because the abstain rule needs to see them at lookup time.
    pub fn from_tsv(tsv: &'static str) -> Self {
        let mut kb = EntityKb {
            entities: Vec::with_capacity(15_000),
            exact: HashMap::with_capacity(40_000),
            stripped: HashMap::with_capacity(4_000),
        };

        for line in tsv.lines() {
            if line.is_empty() {
                continue;
            }
            let mut cols = line.split('\t');
            let (Some(qid), Some(entity_type), Some(sitelinks), Some(label)) =
                (cols.next(), cols.next(), cols.next(), cols.next())
            else {
                continue;
            };
            let aliases = cols.next().unwrap_or("");
            let Ok(sitelinks) = sitelinks.parse::<u32>() else {
                continue;
            };
            if qid.is_empty() || label.is_empty() {
                continue;
            }

            let idx = kb.entities.len() as u32;
            kb.entities.push(KbEntity {
                qid,
                entity_type,
                sitelinks,
                label,
            });

            for form in std::iter::once(label).chain(aliases.split('|')) {
                if form.is_empty() {
                    continue;
                }
                let key = normalize(form);
                if key.len() < 2 {
                    continue;
                }
                if let Some(bare) = strip_legal_suffix(&key) {
                    push_candidate(&mut kb.stripped, bare, idx);
                }
                push_candidate(&mut kb.exact, key, idx);
            }
        }

        kb
    }

    /// Number of entities in the KB.
    pub fn len(&self) -> usize {
        self.entities.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entities.is_empty()
    }

    /// Number of distinct surface keys indexed (both indexes). Diagnostics/tests.
    pub fn surface_count(&self) -> usize {
        self.exact.len() + self.stripped.len()
    }

    /// Live heap held by the index, in bytes: the actual capacities of the
    /// entity vector, every surface key and every candidate list, plus each
    /// hash table's own storage.
    ///
    /// This is a measurement, not an estimate — the only thing it excludes is
    /// allocator bookkeeping. The embedded asset itself is not counted: it is
    /// `include_str!`d, so it lives in the binary's read-only data rather than
    /// on the heap. Used by the footprint test, and worth keeping honest because
    /// this cost is paid by every process that touches the KB.
    pub fn heap_bytes(&self) -> usize {
        let entry = |k: &String, v: &Vec<Candidate>| {
            std::mem::size_of::<String>()
                + k.capacity()
                + std::mem::size_of::<Vec<Candidate>>()
                + v.capacity() * std::mem::size_of::<Candidate>()
        };
        let table = |m: &HashMap<String, Vec<Candidate>>| {
            m.iter().map(|(k, v)| entry(k, v)).sum::<usize>()
                // The table's own buckets: capacity slots of (key, value) plus a
                // control byte each, which is how hashbrown lays itself out.
                + m.capacity()
                    * (std::mem::size_of::<(String, Vec<Candidate>)>() + 1)
        };
        self.entities.capacity() * std::mem::size_of::<KbEntity>()
            + table(&self.exact)
            + table(&self.stripped)
    }

    /// Resolve a surface of a given KB type to a canonical entity, or refuse.
    ///
    /// `kb_type` must be a KB coarse type (see [`kb_type_for_label`]); an unknown
    /// type can never match and yields [`AbstainReason::TypeMismatch`].
    pub fn resolve(&'static self, surface: &str, kb_type: &str) -> Resolution {
        let key = normalize(surface);
        if key.len() < 2 {
            return Resolution::Unknown;
        }

        // Exact surface first; only fall back to the legal-suffix-stripped form
        // when the exact key is unknown, so "Apple Inc." never has to compete
        // with everything that reduces to "apple".
        // The stripped index is keyed on bare forms, so a query that is *already*
        // bare ("International Business Machines") must be looked up there as-is —
        // stripping it again is a no-op and would miss the entry that
        // "…Machines Corporation" contributed.
        let bare = strip_legal_suffix(&key).unwrap_or_else(|| key.clone());
        let mut saw_any = false;
        for (index, lookup) in [(&self.exact, &key), (&self.stripped, &bare)] {
            let Some(cands) = index.get(lookup) else {
                continue;
            };
            saw_any = true;
            match self.decide(cands, kb_type) {
                Resolution::Unknown => continue,
                other => return other,
            }
        }

        if saw_any {
            Resolution::Abstained(AbstainReason::TypeMismatch)
        } else {
            Resolution::Unknown
        }
    }

    /// Apply type blocking, then the sole-survivor / dominance / abstain ladder.
    /// Returns [`Resolution::Unknown`] when type blocking left nothing, so the
    /// caller can try the next index.
    fn decide(&'static self, cands: &[Candidate], kb_type: &str) -> Resolution {
        let mut typed: Vec<&'static KbEntity> = Vec::new();
        for c in cands {
            let e = &self.entities[c.entity as usize];
            if e.entity_type != kb_type {
                continue;
            }
            // One entity can reach the same key through its label and an alias.
            if typed.iter().any(|t| t.qid == e.qid) {
                continue;
            }
            typed.push(e);
        }

        match typed.len() {
            0 => Resolution::Unknown,
            1 => Resolution::Linked {
                entity: typed[0],
                competitors: 0,
            },
            _ => {
                typed.sort_by(|a, b| b.sitelinks.cmp(&a.sitelinks).then(a.qid.cmp(b.qid)));
                let (top, runner_up) = (typed[0], typed[1]);
                if top.sitelinks >= runner_up.sitelinks.saturating_mul(DOMINANCE_RATIO) {
                    Resolution::Linked {
                        entity: top,
                        competitors: typed.len() - 1,
                    }
                } else {
                    Resolution::Abstained(AbstainReason::Ambiguous)
                }
            }
        }
    }
}

fn push_candidate(index: &mut HashMap<String, Vec<Candidate>>, key: String, entity: u32) {
    let slot = index.entry(key).or_default();
    if !slot.iter().any(|c| c.entity == entity) {
        slot.push(Candidate { entity });
    }
}

/// Map a graph [`EntityLabel`] to the KB coarse type it may link against, or
/// `None` when the label is too generic or too internal to link safely.
///
/// Deliberately narrow. `Team`, `Service`, `Module`, `Repository` and `Database`
/// name *internal* things in this product's corpora far more often than
/// world-known ones — an internal service called `Atlas` matching a KB product
/// called `Atlas` is a collision, not a link. `Person` is excluded for the same
/// reason at greater scale: the people in a memory store are overwhelmingly
/// colleagues and friends, not the notable humans a public KB contains, so a
/// person slice would turn every `Sarah` into a celebrity.
pub fn kb_type_for_label(label: &EntityLabel) -> Option<&'static str> {
    match label {
        EntityLabel::Organization => Some("organization"),
        EntityLabel::Product | EntityLabel::Technology => Some("product"),
        _ => None,
    }
}

/// Resolve an entity's identity from its name and labels, trying each label that
/// maps to a KB type. Returns the QID only on an unambiguous link.
///
/// This is the single entry point the graph uses when stamping
/// [`EntityNode::kb_id`](crate::graph_memory::EntityNode::kb_id). It is a pure
/// function of `(name, labels)`, so re-ingesting or re-enriching the same
/// content always produces the same answer and never accumulates state.
pub fn stamp(name: &str, labels: &[EntityLabel]) -> Option<String> {
    let kb = global();
    for label in labels {
        let Some(kb_type) = kb_type_for_label(label) else {
            continue;
        };
        if let Resolution::Linked { entity, .. } = kb.resolve(name, kb_type) {
            return Some(entity.qid.to_string());
        }
    }
    None
}

/// Resolve for diagnostics: the full [`Resolution`], including why a link was
/// refused. Mirrors [`stamp`]'s label handling.
pub fn resolve_entity(name: &str, labels: &[EntityLabel]) -> Resolution {
    let kb = global();
    let mut worst = Resolution::Abstained(AbstainReason::UnsupportedMentionType);
    for label in labels {
        let Some(kb_type) = kb_type_for_label(label) else {
            continue;
        };
        match kb.resolve(name, kb_type) {
            linked @ Resolution::Linked { .. } => return linked,
            other => worst = other,
        }
    }
    worst
}

#[cfg(test)]
mod tests;
