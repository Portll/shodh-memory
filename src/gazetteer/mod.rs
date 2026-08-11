//! Offline toponym gazetteer: place name → coordinates.
//!
//! NER already emits `LOC` entities on every remember, but nothing turned them
//! into coordinates, so a memory that *mentions* a place carried no spatial
//! information at all. This module closes that gap deterministically and
//! entirely on-device — no network, no service, no model.
//!
//! # What this is NOT
//!
//! Resolved toponyms are **not** the memory's location. They land in
//! [`Experience::toponyms`](crate::memory::types::Experience::toponyms), never
//! in `geo_location`. `geo_location` means "this memory was *recorded* here"
//! and drives the geohash radius index; a note *mentioning* Baltimore must
//! never surface for "what did I observe within 5km of Baltimore". Toponyms are
//! deliberately not indexed in the `geo:` keyspace.
//!
//! # Resolution rules (v1)
//!
//! - **Case-insensitive exact match** against the GeoNames `name` and
//!   `asciiname` forms. No fuzzy matching, no prefix matching, no edit
//!   distance: a wrong-but-plausible link ("Paris" → Paris, Texas because a
//!   typo scored well) is worse than no link at all, because a wrong
//!   coordinate is indistinguishable from a right one downstream.
//! - **Homonyms resolve by population-weighted argmax.** `London` is the one in
//!   England (8.96M), not the one in Ontario (422k). Population is the only
//!   disambiguation signal used; context-sensitive disambiguation is a
//!   different, learned problem and is out of scope here.
//! - **Deterministic.** The same mention always resolves to the same place, on
//!   every machine and every run. Ties are impossible in practice (population
//!   equality across same-named cities does not occur in the dataset) and are
//!   broken by the source ordering, which is itself sorted deterministically.
//!
//! # Data
//!
//! GeoNames `cities15000` (every city over 15,000 inhabitants, ~34k places),
//! reduced to name/asciiname/lat/lon/country/population by
//! `scripts/build_gazetteer.py` and embedded with `include_str!` so the binary
//! is self-contained. See `src/gazetteer/NOTICE` for the CC BY 4.0 attribution
//! that licence requires.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use crate::memory::types::{NerEntityRecord, Toponym};

/// The coarse NER label for places. `NerEntityType::Location::as_str()`.
const LOCATION_ENTITY_TYPE: &str = "LOC";

/// A place in the gazetteer.
///
/// Borrowed from the embedded asset — no allocation per lookup.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GazetteerEntry {
    /// Canonical GeoNames name, in its original casing and script.
    pub name: &'static str,
    /// Latitude in WGS84 degrees.
    pub lat: f64,
    /// Longitude in WGS84 degrees.
    pub lon: f64,
    /// ISO 3166-1 alpha-2 country code.
    pub country: &'static str,
    /// Population. The disambiguation weight, and a usable confidence proxy:
    /// a mention resolving to an 8M-person city is far likelier to be that
    /// place than one resolving to a 15k-person town of the same name.
    pub population: u32,
}

/// The embedded GeoNames subset. Columns, tab separated:
/// `name`, `asciiname` (empty when identical to `name`), `lat`, `lon`,
/// `country_code`, `population`.
const GAZETTEER_TSV: &str = include_str!("cities15000.tsv");

/// Lowercased name form → highest-population place carrying that name.
static INDEX: OnceLock<HashMap<String, GazetteerEntry>> = OnceLock::new();

/// Build the lookup index. Runs once, on first resolution.
///
/// Both `name` and `asciiname` become keys, so "Zürich" and "Zurich" resolve to
/// the same city. The population argmax is applied while inserting rather than
/// baked into the asset, so the asset stays a faithful subset of GeoNames and
/// the disambiguation rule stays visible, testable code.
fn index() -> &'static HashMap<String, GazetteerEntry> {
    INDEX.get_or_init(|| {
        let mut map: HashMap<String, GazetteerEntry> = HashMap::with_capacity(40_000);

        for line in GAZETTEER_TSV.lines() {
            if line.is_empty() {
                continue;
            }
            let mut cols = line.split('\t');
            let (Some(name), Some(asciiname), Some(lat), Some(lon), Some(country), Some(pop)) = (
                cols.next(),
                cols.next(),
                cols.next(),
                cols.next(),
                cols.next(),
                cols.next(),
            ) else {
                continue;
            };

            let (Ok(lat), Ok(lon), Ok(population)) =
                (lat.parse::<f64>(), lon.parse::<f64>(), pop.parse::<u32>())
            else {
                continue;
            };

            let entry = GazetteerEntry {
                name,
                lat,
                lon,
                country,
                population,
            };

            for form in [name, asciiname] {
                if form.is_empty() {
                    continue;
                }
                let key = normalize(form);
                if key.is_empty() {
                    continue;
                }
                // Population-weighted argmax: keep the most populous place for
                // any name form two cities share.
                map.entry(key)
                    .and_modify(|existing| {
                        if entry.population > existing.population {
                            *existing = entry;
                        }
                    })
                    .or_insert(entry);
            }
        }

        map
    })
}

/// Fold a mention to its lookup key: trimmed and lowercased.
///
/// Lowercasing is Unicode-aware so non-ASCII place names match regardless of
/// the casing a writer used.
fn normalize(mention: &str) -> String {
    mention.trim().to_lowercase()
}

/// Resolve a place name to coordinates, or `None` if it is not a known place.
///
/// Case-insensitive exact match only. Returns the most populous place sharing
/// the name — see the module docs for why that is the whole disambiguation
/// policy in v1.
pub fn resolve(mention: &str) -> Option<&'static GazetteerEntry> {
    let key = normalize(mention);
    if key.is_empty() {
        return None;
    }
    index().get(&key)
}

/// Number of distinct name forms indexed. Diagnostics and tests.
pub fn len() -> usize {
    index().len()
}

/// Resolve the `LOC` entities NER produced for a memory into [`Toponym`]s.
///
/// This is the single place the remember path turns place mentions into
/// coordinates. Only `LOC` entities are considered: `PER`/`ORG`/`MISC` names
/// collide with place names constantly (Jordan the person, Amazon the company,
/// Phoenix the project), and resolving those would generate exactly the
/// confident-but-wrong links v1 is built to avoid.
///
/// Mentions that resolve to nothing are simply dropped — an unresolved place is
/// not an error, and the memory keeps its `LOC` entity either way.
///
/// Repeated mentions of the same place collapse to one toponym: a note that
/// says "Baltimore" three times is about one place, and emitting it three times
/// would make any downstream count meaningless.
pub fn resolve_ner_locations(ner_entities: &[NerEntityRecord]) -> Vec<Toponym> {
    let mut resolved = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for record in ner_entities {
        if record.entity_type != LOCATION_ENTITY_TYPE {
            continue;
        }
        let key = normalize(&record.text);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        let Some(entry) = resolve(&record.text) else {
            continue;
        };
        resolved.push(Toponym {
            mention: record.text.clone(),
            name: entry.name.to_string(),
            lat: entry.lat,
            lon: entry.lon,
            country: entry.country.to_string(),
            population: entry.population,
        });
    }

    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_a_plain_city() {
        let baltimore = resolve("Baltimore").expect("Baltimore is in cities15000");
        assert_eq!(baltimore.country, "US");
        // 39.29038 / -76.61219 in the source row.
        assert!((baltimore.lat - 39.29038).abs() < 1e-5);
        assert!((baltimore.lon - -76.61219).abs() < 1e-5);
    }

    #[test]
    fn matching_is_case_insensitive_and_trimmed() {
        let canonical = resolve("Baltimore").expect("resolves");
        for variant in ["baltimore", "BALTIMORE", "  Baltimore  ", "bAlTiMoRe"] {
            assert_eq!(
                resolve(variant),
                Some(canonical),
                "{variant:?} must resolve identically"
            );
        }
    }

    #[test]
    fn homonyms_resolve_by_population_argmax() {
        // Two Londons in cities15000:
        //   London  51.50853   -0.12574  GB  8961989
        //   London  42.98339  -81.23304  CA   422324
        // Population picks England, deterministically.
        let london = resolve("London").expect("London is in cities15000");
        assert_eq!(london.country, "GB");
        assert_eq!(london.population, 8_961_989);
        assert!((london.lat - 51.50853).abs() < 1e-5);
    }

    #[test]
    fn homonym_argmax_holds_across_many_candidates() {
        // Eight Springfields in the US; the Missouri one (170,188) is the most
        // populous, ahead of Massachusetts (154,341) and Illinois (114,394).
        let springfield = resolve("Springfield").expect("Springfield is in cities15000");
        assert_eq!(springfield.country, "US");
        assert_eq!(springfield.population, 170_188);
    }

    #[test]
    fn unknown_and_empty_mentions_resolve_to_nothing() {
        for mention in [
            "",
            "   ",
            "Zzyzx Nonexistentville",
            // No fuzzy matching in v1: a near-miss must NOT silently link.
            // Verified absent from the asset under both name columns.
            "Baltimoore",
            "Baltimor",
        ] {
            assert!(
                resolve(mention).is_none(),
                "{mention:?} must not resolve — a wrong link is worse than none"
            );
        }
    }

    #[test]
    fn resolution_is_deterministic_across_calls() {
        let first = resolve("Springfield").copied();
        for _ in 0..100 {
            assert_eq!(resolve("Springfield").copied(), first);
        }
    }

    #[test]
    fn index_loaded_the_whole_asset() {
        // 34,075 places, each contributing one or two name forms.
        assert!(
            len() > 30_000,
            "gazetteer index looks truncated: {} entries",
            len()
        );
    }
}
