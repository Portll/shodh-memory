//! Tests for offline KB entity linking.
//!
//! Two layers. The synthetic-KB tests pin the *rules* (type blocking, the
//! dominance boundary, abstention) with hand-built fixtures where every number
//! is visible. The vendored-asset tests pin the *behaviour a user actually
//! gets* against the shipped Wikidata slice — including the two cases that
//! matter most: one real entity spelled two ways must land on one QID, and two
//! distinct real entities sharing a name must never merge.

use super::*;

/// Leak a fixture KB so it satisfies the `&'static self` receiver `resolve` needs.
fn fixture(tsv: &'static str) -> &'static EntityKb {
    Box::leak(Box::new(EntityKb::from_tsv(tsv)))
}

/// The real shipped asset.
fn vendored() -> &'static EntityKb {
    static V: OnceLock<EntityKb> = OnceLock::new();
    V.get_or_init(|| EntityKb::from_tsv(KB_TSV))
}

// ===================== normalization / suffix rules =====================

#[test]
fn normalize_folds_case_and_whitespace() {
    assert_eq!(normalize("  Alphabet   Inc.  "), "alphabet inc.");
    assert_eq!(normalize("IBM"), "ibm");
    assert_eq!(normalize("Zürich Insurance"), "zürich insurance");
    assert_eq!(normalize("   "), "");
}

#[test]
fn legal_suffix_stripping_is_conservative() {
    assert_eq!(
        strip_legal_suffix("general electric company").as_deref(),
        Some("general electric")
    );
    assert_eq!(
        strip_legal_suffix("international business machines corporation").as_deref(),
        Some("international business machines")
    );
    // Nothing to strip.
    assert_eq!(strip_legal_suffix("ibm"), None);
    assert_eq!(strip_legal_suffix("apple records"), None);
    // Must never reduce a name to nothing, or to a fragment that would match
    // half the KB.
    assert_eq!(strip_legal_suffix("inc"), None);
    assert_eq!(strip_legal_suffix("co ltd"), None);
}

// ============================ the rules =================================

const SYNTH: &str = "\
Q1\torganization\t100\tApollo Global Management\t
Q2\torganization\t80\tApollo Theatre\tApollo
Q3\torganization\t10\tHelios Systems\tHelios|Helios Corporation
Q4\tproduct\t60\tHelios\t
Q5\torganization\t500\tDominant Corp\tDom
Q6\torganization\t20\tDominated Ltd\tDom
";

#[test]
fn sole_type_compatible_candidate_links() {
    let kb = fixture(SYNTH);
    let r = kb.resolve("Apollo Global Management", "organization");
    assert_eq!(r.qid(), Some("Q1"));
}

#[test]
fn type_blocking_keeps_a_product_and_an_organisation_apart() {
    let kb = fixture(SYNTH);
    // "Helios" is an organisation (Q3) AND a product (Q4). Each type resolves to
    // its own entity; neither leaks into the other.
    assert_eq!(kb.resolve("Helios", "organization").qid(), Some("Q3"));
    assert_eq!(kb.resolve("Helios", "product").qid(), Some("Q4"));
}

#[test]
fn a_known_surface_of_the_wrong_type_abstains_rather_than_linking() {
    let kb = fixture(SYNTH);
    // "Apollo Theatre" exists, but only as an organisation.
    assert_eq!(
        kb.resolve("Apollo Theatre", "product"),
        Resolution::Abstained(AbstainReason::TypeMismatch)
    );
}

#[test]
fn dominance_boundary_is_exact_and_abstains_below_it() {
    // Q5 (500) vs Q6 (20) share the alias "Dom": 500 >= 5*20 → link.
    let kb = fixture(SYNTH);
    match kb.resolve("Dom", "organization") {
        Resolution::Linked {
            entity,
            competitors,
        } => {
            assert_eq!(entity.qid, "Q5");
            assert_eq!(competitors, 1);
        }
        other => panic!("expected a dominant link, got {other:?}"),
    }

    // Same shape, one sitelink short of the 5x bar (499 < 5*100) → abstain.
    let tight = fixture(
        "Q7\torganization\t499\tBig Thing\tShared\nQ8\torganization\t100\tSmall Thing\tShared\n",
    );
    assert_eq!(
        tight.resolve("Shared", "organization"),
        Resolution::Abstained(AbstainReason::Ambiguous),
        "just under the dominance bar must abstain, not round up"
    );

    // Exactly at the bar (500 == 5*100) → link.
    let at_bar = fixture(
        "Q9\torganization\t500\tBig Thing\tShared\nQ10\torganization\t100\tSmall Thing\tShared\n",
    );
    assert_eq!(at_bar.resolve("Shared", "organization").qid(), Some("Q9"));
}

#[test]
fn one_entity_reached_by_label_and_alias_is_not_treated_as_ambiguous() {
    // Q3 carries both "Helios" (alias) and "Helios Corporation" (alias), and the
    // latter strips to "helios" too. That is one entity, not a crowd.
    let kb = fixture(SYNTH);
    match kb.resolve("Helios", "organization") {
        Resolution::Linked {
            entity,
            competitors,
        } => {
            assert_eq!(entity.qid, "Q3");
            assert_eq!(
                competitors, 0,
                "same QID via several surfaces is one candidate"
            );
        }
        other => panic!("expected a link, got {other:?}"),
    }
}

#[test]
fn unknown_surface_is_unknown_not_abstained() {
    let kb = fixture(SYNTH);
    assert_eq!(
        kb.resolve("Zzyzx Nonexistent Holdings", "organization"),
        Resolution::Unknown
    );
    assert_eq!(kb.resolve("", "organization"), Resolution::Unknown);
    assert_eq!(kb.resolve("x", "organization"), Resolution::Unknown);
}

#[test]
fn no_fuzzy_matching_a_near_miss_must_not_link() {
    let kb = fixture(SYNTH);
    for near in [
        "Apollo Globl Management",
        "Helio",
        "Heliosss",
        "Dominant Corpp",
    ] {
        assert!(
            kb.resolve(near, "organization").qid().is_none(),
            "{near:?} must not link — a wrong link is worse than none"
        );
    }
}

// ==================== label gate (what may link at all) ==================

#[test]
fn only_organisation_product_and_technology_labels_map_to_a_kb_type() {
    assert_eq!(
        kb_type_for_label(&EntityLabel::Organization),
        Some("organization")
    );
    assert_eq!(kb_type_for_label(&EntityLabel::Product), Some("product"));
    assert_eq!(kb_type_for_label(&EntityLabel::Technology), Some("product"));

    // Everything else refuses. Person is the important one: a memory store's
    // people are colleagues, not notable humans.
    for label in [
        EntityLabel::Person,
        EntityLabel::Concept,
        EntityLabel::Keyword,
        EntityLabel::Location,
        EntityLabel::Team,
        EntityLabel::Service,
        EntityLabel::Module,
        EntityLabel::Repository,
        EntityLabel::Database,
        EntityLabel::Project,
        EntityLabel::Other("whatever".into()),
    ] {
        assert_eq!(
            kb_type_for_label(&label),
            None,
            "{label:?} must not be linkable in v1"
        );
    }
}

#[test]
fn generic_and_person_mentions_never_stamp_a_kb_id() {
    // Even a surface that IS in the KB must not link under a non-linkable label.
    for label in [
        EntityLabel::Person,
        EntityLabel::Concept,
        EntityLabel::Keyword,
    ] {
        assert_eq!(
            resolve_entity("IBM", std::slice::from_ref(&label)),
            Resolution::Abstained(AbstainReason::UnsupportedMentionType),
            "{label:?} must refuse before any lookup happens"
        );
    }
}

// ======================= the shipped asset ==============================

#[test]
fn vendored_asset_loaded_fully() {
    let kb = vendored();
    assert!(
        kb.len() > 12_000,
        "vendored KB looks truncated: {} entities",
        kb.len()
    );
    assert!(
        kb.surface_count() > kb.len(),
        "every entity indexes at least one surface"
    );
}

#[test]
fn vendored_asset_stays_within_its_size_budget() {
    // The asset is compiled into the binary, so its size is a permanent cost paid
    // by every deployment. The sitelink floor in the build script is the knob;
    // this is the guard that stops it being lowered casually. 2 MB leaves room to
    // grow from the current ~1.06 MB without a silent blow-out.
    assert!(
        KB_TSV.len() < 2_000_000,
        "vendored KB asset is {} bytes — raise the sitelink floor rather than \
         shipping a larger binary",
        KB_TSV.len()
    );
}

#[test]
fn index_footprint_stays_within_the_ram_budget() {
    // The index is process-wide and permanent once touched, so its cost is paid
    // by every deployment including the edge ones. Measured rather than assumed;
    // run with --nocapture to see the number.
    let kb = vendored();
    let heap = kb.heap_bytes();
    println!(
        "KB footprint: {} entities, {} surface keys, {:.2} MB heap, {:.2} MB static asset",
        kb.len(),
        kb.surface_count(),
        heap as f64 / 1e6,
        KB_TSV.len() as f64 / 1e6,
    );
    assert!(
        heap < 16_000_000,
        "KB index heap is {heap} bytes — that is a regression worth explaining"
    );
}

#[test]
fn lookup_cost_is_negligible_per_mention() {
    // Linking runs on every entity of every remembered memory, so a slow lookup
    // is a tax on ingest. It is a hash probe over borrowed data: it should not be
    // measurable next to the embedding and NER work on the same path.
    let kb = vendored();
    let surfaces = [
        "IBM",
        "International Business Machines",
        "ACM",
        "Zzyzx Holdings Incorporated",
        "Microsoft",
    ];
    // Warm the index so this measures lookup, not the one-off load.
    assert!(!kb.is_empty());

    let start = std::time::Instant::now();
    let iterations = 20_000;
    let mut linked = 0usize;
    for i in 0..iterations {
        if kb
            .resolve(surfaces[i % surfaces.len()], "organization")
            .qid()
            .is_some()
        {
            linked += 1;
        }
    }
    let per_lookup = start.elapsed() / iterations as u32;
    println!("KB lookup: {per_lookup:?} per surface over {iterations} resolutions");
    assert!(linked > 0, "sanity: some of the fixtures must link");
    assert!(
        per_lookup < std::time::Duration::from_micros(50),
        "KB lookup took {per_lookup:?} per surface, expected well under 50µs"
    );
}

#[test]
fn one_company_spelled_two_ways_links_to_one_kb_id() {
    // The headline claim: string similarity cannot unify these, an external
    // identity can. Both spellings must land on the SAME Wikidata QID.
    let kb = vendored();
    let short = kb.resolve("IBM", "organization");
    let long = kb.resolve("International Business Machines", "organization");

    assert_eq!(short.qid(), Some("Q37156"), "IBM must link");
    assert_eq!(
        long.qid(),
        Some("Q37156"),
        "the expanded name must link to the same entity"
    );
    assert_eq!(short.qid(), long.qid());

    // And the legal-form variant reaches it too.
    assert_eq!(
        kb.resolve(
            "International Business Machines Corporation",
            "organization"
        )
        .qid(),
        Some("Q37156")
    );
}

#[test]
fn distinct_real_organisations_sharing_a_name_must_not_merge() {
    // The adversarial case. "ACM" is the Association for Computing Machinery to a
    // software engineer and the Academy of Country Music to a musician; both are
    // real, both are in the KB, neither dominates. Linking either way would fuse
    // two unrelated real-world organisations into one graph node forever.
    let kb = vendored();
    assert_eq!(
        kb.resolve("ACM", "organization"),
        Resolution::Abstained(AbstainReason::Ambiguous),
        "ACM must abstain — a wrong link here corrupts the graph permanently"
    );

    // Same story for WTO (World Trade Organization vs Warsaw Pact).
    assert_eq!(
        kb.resolve("WTO", "organization"),
        Resolution::Abstained(AbstainReason::Ambiguous)
    );
}

#[test]
fn well_known_unambiguous_companies_link() {
    let kb = vendored();
    for (surface, qid) in [
        ("Microsoft", "Q2283"),
        ("Alphabet Inc.", "Q20800404"),
        ("PostgreSQL", "Q192490"),
    ] {
        let ty = if qid == "Q192490" {
            "product"
        } else {
            "organization"
        };
        assert_eq!(
            kb.resolve(surface, ty).qid(),
            Some(qid),
            "{surface} should link to {qid}"
        );
    }
}

#[test]
fn cross_type_lookup_of_a_real_company_finds_nothing() {
    // IBM is an organisation; asked for as a product it must not link.
    let kb = vendored();
    assert!(kb.resolve("IBM", "product").qid().is_none());
}

#[test]
fn resolution_is_deterministic_across_repeated_calls() {
    let kb = vendored();
    for surface in ["IBM", "ACM", "Microsoft", "Zzyzx Holdings"] {
        let first = kb.resolve(surface, "organization");
        for _ in 0..50 {
            assert_eq!(
                kb.resolve(surface, "organization"),
                first,
                "{surface} must resolve identically every time"
            );
        }
    }
}

#[test]
fn asset_rows_are_well_formed() {
    // Guards the vendored file itself: every row must carry the five columns and
    // a parseable sitelink count, or the index silently loses entities.
    let mut rows = 0usize;
    for (n, line) in KB_TSV.lines().enumerate() {
        if line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        assert_eq!(cols.len(), 5, "row {} has {} columns", n + 1, cols.len());
        assert!(
            cols[0].starts_with('Q'),
            "row {}: bad QID {:?}",
            n + 1,
            cols[0]
        );
        assert!(
            cols[1] == "organization" || cols[1] == "product",
            "row {}: unexpected type {:?}",
            n + 1,
            cols[1]
        );
        assert!(
            cols[2].parse::<u32>().is_ok(),
            "row {}: bad sitelinks {:?}",
            n + 1,
            cols[2]
        );
        assert!(!cols[3].is_empty(), "row {}: empty label", n + 1);
        rows += 1;
    }
    assert_eq!(rows, vendored().len(), "every asset row must load");
}
