from v2locations import ParseStats, parse_v2locations, primary_location

# --- Legacy V1Locations shape (7 fields, no ADM2Code): ---
# type#fullname#countrycode#adm1code#lat#lon#featureid
# This is the shape the original task brief's sample used (mislabeled at the
# time as "V2Locations" -- it's actually the pre-2.1 V1Locations layout).
# Kept here as the legacy-fallback case; see V2_SAMPLE_* below for the real
# GKG 2.1 V2Locations shape.
V1_SAMPLE = "1#United States#US#US#39.828175#-98.5795#US;3#Baltimore, Maryland, United States#US#USMD#39.2904#-76.6122#4347778"

def test_parse_two_blocks_v1_legacy_shape():
    locs, stats = parse_v2locations(V1_SAMPLE)
    assert len(locs) == 2
    assert locs[1].loc_type == 3 and abs(locs[1].lat - 39.2904) < 1e-6
    assert stats == ParseStats(total_blocks=2, parsed=2, malformed=0)

def test_primary_prefers_most_specific_v1_legacy_shape():
    # type 3 (US city) and 4 (world city) outrank 1 (country); first wins within a rank
    assert primary_location(V1_SAMPLE) == (39.2904, -76.6122)

def test_malformed_blocks_skipped_not_fatal():
    locs, stats = parse_v2locations("garbage#novalues")
    assert locs == []
    assert stats == ParseStats(total_blocks=1, parsed=0, malformed=1)
    assert primary_location("") is None
    # partial corruption: good block still parses
    locs, stats = parse_v2locations("bad##block;3#Baltimore#US#USMD#39.2904#-76.6122#4347778")
    assert len(locs) == 1
    assert stats == ParseStats(total_blocks=2, parsed=1, malformed=1)

def test_non_numeric_coords_skipped():
    locs, stats = parse_v2locations("3#X#US#USMD#notanumber#-76.6122#id")
    assert locs == []
    assert stats == ParseStats(total_blocks=1, parsed=0, malformed=1)

def test_v1_legacy_block_has_empty_adm2():
    locs, _stats = parse_v2locations("3#Baltimore#US#USMD#39.2904#-76.6122#4347778")
    assert locs[0].adm2 == ""


# --- GKG 2.1 V2Locations shape (8 fields): ADM2Code inserted before lat/lon. ---
# type#fullname#countrycode#adm1code#adm2code#lat#lon#featureid
V2_SAMPLE_8FIELD = "3#Baltimore, Maryland, United States#US#USMD#USMD005#39.2904#-76.6122#4347778"

# --- V2.1 "enhanced" variant (9 fields): adds a trailing CharOffset. ---
V2_SAMPLE_9FIELD = "3#Baltimore, Maryland, United States#US#USMD#USMD005#39.2904#-76.6122#4347778#128"

def test_parse_v2_8field_extracts_correct_lat_not_adm2code():
    locs, stats = parse_v2locations(V2_SAMPLE_8FIELD)
    assert len(locs) == 1
    loc = locs[0]
    assert loc.adm2 == "USMD005"
    assert abs(loc.lat - 39.2904) < 1e-6
    assert abs(loc.lon - (-76.6122)) < 1e-6
    assert loc.feature_id == "4347778"
    assert stats == ParseStats(total_blocks=1, parsed=1, malformed=0)

def test_parse_v2_1_9field_with_charoffset_extracts_correct_lat():
    locs, stats = parse_v2locations(V2_SAMPLE_9FIELD)
    assert len(locs) == 1
    assert abs(locs[0].lat - 39.2904) < 1e-6
    assert abs(locs[0].lon - (-76.6122)) < 1e-6
    assert locs[0].adm2 == "USMD005"
    assert stats == ParseStats(total_blocks=1, parsed=1, malformed=0)

def test_mixed_shape_multi_block_field():
    # One legacy V1 block (country, 7 fields) followed by one V2.1 block
    # (US city, 9 fields) in the same ';'-separated field.
    mixed = "1#United States#US#US#39.828175#-98.5795#US;" + V2_SAMPLE_9FIELD
    locs, stats = parse_v2locations(mixed)
    assert len(locs) == 2
    assert locs[0].adm2 == ""            # V1 block
    assert locs[1].adm2 == "USMD005"     # V2.1 block
    assert abs(locs[1].lat - 39.2904) < 1e-6
    assert abs(locs[1].lon - (-76.6122)) < 1e-6
    assert stats == ParseStats(total_blocks=2, parsed=2, malformed=0)

def test_malformed_v2_block_non_numeric_lat_skipped():
    # 8-field V2 shape with a garbage lat value
    locs, stats = parse_v2locations("3#X#US#USMD#USMD005#notanumber#-76.6122#id")
    assert locs == []
    assert stats == ParseStats(total_blocks=1, parsed=0, malformed=1)

def test_malformed_v2_block_wrong_field_count_skipped():
    # 10 fields -- not 7, 8, or 9 -- skipped entirely, not fatal
    bogus = "3#X#US#USMD#USMD005#39.2904#-76.6122#id#128#extra"
    locs, stats = parse_v2locations(bogus)
    assert locs == []
    assert stats == ParseStats(total_blocks=1, parsed=0, malformed=1)

def test_primary_location_v2_sample():
    combined = "1#United States#US#US#39.828175#-98.5795#US;" + V2_SAMPLE_9FIELD
    assert primary_location(combined) == (39.2904, -76.6122)


# =============================================================================
# ParseStats: NaN/Inf/out-of-range coordinates are malformed, not "valid but weird"
# =============================================================================
def test_nan_coordinate_is_malformed_not_silently_returned():
    # float("nan") does not raise ValueError -- must be explicitly rejected,
    # or it would corrupt primary_location's min()-based comparisons.
    locs, stats = parse_v2locations("3#X#US#USMD#USMD005#nan#-76.6122#id#1")
    assert locs == []
    assert stats == ParseStats(total_blocks=1, parsed=0, malformed=1)

def test_infinite_coordinate_is_malformed():
    locs, stats = parse_v2locations("3#X#US#USMD#USMD005#inf#-76.6122#id#1")
    assert locs == []
    assert stats == ParseStats(total_blocks=1, parsed=0, malformed=1)

def test_out_of_range_latitude_is_malformed():
    locs, stats = parse_v2locations("3#X#US#USMD#USMD005#999.0#-76.6122#id#1")
    assert locs == []
    assert stats == ParseStats(total_blocks=1, parsed=0, malformed=1)

def test_out_of_range_longitude_is_malformed():
    locs, stats = parse_v2locations("3#X#US#USMD#USMD005#39.29#-999.0#id#1")
    assert locs == []
    assert stats == ParseStats(total_blocks=1, parsed=0, malformed=1)

def test_empty_field_has_zero_blocks_not_one_malformed_block():
    # Distinguishing "no data" from "bad data" starts here: an empty field
    # is zero blocks, not one malformed block.
    locs, stats = parse_v2locations("")
    assert locs == []
    assert stats == ParseStats(total_blocks=0, parsed=0, malformed=0)
    locs, stats = parse_v2locations(None)
    assert locs == []
    assert stats == ParseStats(total_blocks=0, parsed=0, malformed=0)

def test_stats_total_always_equals_parsed_plus_malformed():
    for field in (
        V1_SAMPLE, V2_SAMPLE_8FIELD, V2_SAMPLE_9FIELD, "garbage#novalues",
        "bad##block;3#Baltimore#US#USMD#39.2904#-76.6122#4347778", "",
    ):
        _locs, stats = parse_v2locations(field)
        assert stats.total_blocks == stats.parsed + stats.malformed
