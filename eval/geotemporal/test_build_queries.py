"""Unit tests for build_queries.py -- pure logic first (TDD red-before-green),
then file I/O and stubbed HTTP.

Server HTTP is always stubbed via monkeypatch on urllib.request.urlopen,
mirroring scripts/gdelt/test_ingest_gkg.py's pattern -- these tests never
touch a live server.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest

import build_queries
from build_queries import (
    CorpusRow,
    CorrelationStats,
    LoadStats,
    build_clusters,
    build_negative_controls,
    build_precedence_queries,
    build_radius_window_queries,
    cluster_centroid_and_radius,
    compute_in_radius_window_ids,
    correlate_with_server,
    fetch_all_server_memories,
    grid_cell,
    haversine_distance_m,
    load_local_gkg_rows,
    main,
    match_key,
    parse_iso8601,
    run,
    sorted_cluster_items,
    write_queries_jsonl,
)


def _row(id_, lat, lon, when, content="x"):
    return CorpusRow(id=id_, lat=lat, lon=lon, created_at=when, content=content)


def _dt(s):
    return parse_iso8601(s)


# =============================================================================
# haversine_distance_m -- must match src/memory/types.rs GeoFilter::haversine_distance
# =============================================================================
def test_haversine_same_point_is_zero():
    assert haversine_distance_m(37.7749, -122.4194, 37.7749, -122.4194) == 0.0


def test_haversine_known_distance_sf_to_la_within_tolerance():
    # SF (37.7749,-122.4194) to LA (34.0522,-118.2437) is ~559 km great-circle.
    d = haversine_distance_m(37.7749, -122.4194, 34.0522, -118.2437)
    assert 550_000 < d < 570_000


def test_haversine_equator_one_degree_lon_is_about_111km():
    d = haversine_distance_m(0.0, 0.0, 0.0, 1.0)
    assert 110_000 < d < 112_000


def test_haversine_symmetric():
    a = haversine_distance_m(10.0, 20.0, 30.0, 40.0)
    b = haversine_distance_m(30.0, 40.0, 10.0, 20.0)
    assert a == pytest.approx(b)


# =============================================================================
# parse_iso8601 -- must handle both this repo's own "...Z" strings and
# chrono's to_rfc3339() output (numeric offset, variable fractional precision)
# =============================================================================
def test_parse_iso8601_z_suffix_second_precision():
    dt = parse_iso8601("2015-03-26T12:00:00Z")
    assert dt == datetime(2015, 3, 26, 12, 0, 0, tzinfo=timezone.utc)


def test_parse_iso8601_numeric_offset_no_fraction():
    dt = parse_iso8601("2015-03-26T12:00:00+00:00")
    assert dt == datetime(2015, 3, 26, 12, 0, 0, tzinfo=timezone.utc)


def test_parse_iso8601_nanosecond_fraction_from_chrono():
    # chrono's to_rfc3339() emits up to 9 fractional digits; Python's
    # fromisoformat pre-3.11 only accepts exactly 3 or 6. Must not raise.
    dt = parse_iso8601("2015-03-26T12:00:00.123456789+00:00")
    assert dt.year == 2015 and dt.microsecond == 123456


def test_parse_iso8601_nanosecond_fraction_with_z():
    dt = parse_iso8601("2015-03-26T12:00:00.5Z")
    assert dt.microsecond == 500000
    assert dt.tzinfo is not None


def test_parse_iso8601_orderable_and_comparable():
    a = parse_iso8601("2015-03-26T12:00:00Z")
    b = parse_iso8601("2015-03-27T00:00:00.000000001+00:00")
    assert a < b


# =============================================================================
# grid_cell
# =============================================================================
def test_grid_cell_floors_by_cell_size():
    assert grid_cell(39.9, -76.1, cell_deg=1.0) == (39, -77)
    assert grid_cell(0.0, 0.0, cell_deg=1.0) == (0, 0)
    assert grid_cell(-0.5, -0.5, cell_deg=1.0) == (-1, -1)


# =============================================================================
# cluster_centroid_and_radius
# =============================================================================
def test_cluster_centroid_and_radius_single_member_zero_dist_plus_buffer():
    members = [_row("a", 10.0, 20.0, _dt("2020-01-01T00:00:00Z"))]
    lat, lon, radius = cluster_centroid_and_radius(members)
    assert lat == 10.0 and lon == 20.0
    assert radius == build_queries.CLUSTER_RADIUS_BUFFER_M


def test_cluster_centroid_and_radius_covers_all_members():
    members = [
        _row("a", 10.0, 20.0, _dt("2020-01-01T00:00:00Z")),
        _row("b", 10.5, 20.5, _dt("2020-01-02T00:00:00Z")),
        _row("c", 9.7, 19.6, _dt("2020-01-03T00:00:00Z")),
    ]
    lat, lon, radius = cluster_centroid_and_radius(members)
    for m in members:
        assert haversine_distance_m(lat, lon, m.lat, m.lon) <= radius


# =============================================================================
# compute_in_radius_window_ids
# =============================================================================
def test_compute_in_radius_window_ids_filters_by_distance_and_date():
    rows = [
        _row("near-in", 10.0, 20.0, _dt("2020-06-01T00:00:00Z")),
        _row("near-out-of-window", 10.0, 20.0, _dt("2019-01-01T00:00:00Z")),
        _row("far", 50.0, 50.0, _dt("2020-06-01T00:00:00Z")),
    ]
    ids = compute_in_radius_window_ids(
        rows, 10.0, 20.0, radius_m=1000.0,
        start=_dt("2020-05-01T00:00:00Z"), end=_dt("2020-07-01T00:00:00Z"),
    )
    assert ids == ["near-in"]


def test_compute_in_radius_window_ids_inclusive_boundaries():
    start = _dt("2020-01-01T00:00:00Z")
    end = _dt("2020-01-10T00:00:00Z")
    rows = [_row("edge-start", 0.0, 0.0, start), _row("edge-end", 0.0, 0.0, end)]
    ids = compute_in_radius_window_ids(rows, 0.0, 0.0, radius_m=10.0, start=start, end=end)
    assert set(ids) == {"edge-start", "edge-end"}


def test_compute_in_radius_window_ids_exclusive_end_excludes_anchor_instant():
    end = _dt("2020-01-10T00:00:00Z")
    rows = [_row("same-instant", 0.0, 0.0, end), _row("before", 0.0, 0.0, end - timedelta(days=1))]
    ids = compute_in_radius_window_ids(
        rows, 0.0, 0.0, radius_m=10.0, start=end - timedelta(days=7), end=end, end_inclusive=False,
    )
    assert ids == ["before"]


def test_compute_in_radius_window_ids_no_window_is_distance_only():
    rows = [_row("a", 0.0, 0.0, _dt("2000-01-01T00:00:00Z")), _row("b", 45.0, 45.0, _dt("2030-01-01T00:00:00Z"))]
    ids = compute_in_radius_window_ids(rows, 0.0, 0.0, radius_m=10.0)
    assert ids == ["a"]


def test_compute_in_radius_window_ids_sorted():
    rows = [_row("z", 0.0, 0.0, _dt("2020-01-01T00:00:00Z")), _row("a", 0.0, 0.0, _dt("2020-01-01T00:00:00Z"))]
    ids = compute_in_radius_window_ids(rows, 0.0, 0.0, radius_m=10.0)
    assert ids == ["a", "z"]


# =============================================================================
# match_key / correlate_with_server -- the GKG-row <-> server-id linkage
# =============================================================================
def test_match_key_short_content_is_content_and_length():
    assert match_key("hello") == ("hello", 5)


def test_match_key_long_content_truncates_to_preview_chars():
    content = "a" * 600
    key = match_key(content)
    assert key == ("a" * 500, 600)


def test_correlate_with_server_matches_by_content_prefix_and_length():
    local_rows = [
        {"content": "short content", "lat": 1.0, "lon": 2.0, "created_at": _dt("2020-01-01T00:00:00Z")},
    ]
    server_items = [
        {"id": "srv-1", "content": "short content", "content_truncated": False, "content_length": 13},
    ]
    matched, stats = correlate_with_server(local_rows, server_items)
    assert len(matched) == 1
    assert matched[0].id == "srv-1"
    assert stats == CorrelationStats(server_total=1, matched=1, unmatched=0, ambiguous_keys=0)


def test_correlate_with_server_truncated_server_content_still_matches():
    long_content = "x" * 700
    local_rows = [{"content": long_content, "lat": 1.0, "lon": 2.0, "created_at": _dt("2020-01-01T00:00:00Z")}]
    server_items = [
        {"id": "srv-1", "content": "x" * 500, "content_truncated": True, "content_length": 700},
    ]
    matched, stats = correlate_with_server(local_rows, server_items)
    assert len(matched) == 1
    assert matched[0].id == "srv-1"


def test_correlate_with_server_unmatched_row_counted_not_dropped_silently():
    local_rows = [{"content": "never ingested", "lat": 1.0, "lon": 2.0, "created_at": _dt("2020-01-01T00:00:00Z")}]
    server_items = [{"id": "srv-1", "content": "something else", "content_truncated": False, "content_length": 15}]
    matched, stats = correlate_with_server(local_rows, server_items)
    assert matched == []
    assert stats.unmatched == 1
    assert stats.matched == 0


def test_correlate_with_server_ambiguous_key_excluded_and_counted():
    # Two distinct server ids sharing the same (prefix, length) key -- can't
    # tell which is which, so neither is used (silent-mis-mapping is worse
    # than an honest unmatched count).
    local_rows = [{"content": "dup", "lat": 1.0, "lon": 2.0, "created_at": _dt("2020-01-01T00:00:00Z")}]
    server_items = [
        {"id": "srv-1", "content": "dup", "content_truncated": False, "content_length": 3},
        {"id": "srv-2", "content": "dup", "content_truncated": False, "content_length": 3},
    ]
    matched, stats = correlate_with_server(local_rows, server_items)
    assert matched == []
    assert stats.ambiguous_keys == 1
    assert stats.unmatched == 1


def test_correlate_with_server_dedupes_repeated_local_rows_mapping_to_same_id():
    local_rows = [
        {"content": "same", "lat": 1.0, "lon": 2.0, "created_at": _dt("2020-01-01T00:00:00Z")},
        {"content": "same", "lat": 1.0, "lon": 2.0, "created_at": _dt("2020-01-01T00:00:00Z")},
    ]
    server_items = [{"id": "srv-1", "content": "same", "content_truncated": False, "content_length": 4}]
    matched, stats = correlate_with_server(local_rows, server_items)
    assert len(matched) == 1
    assert stats.matched == 1


# =============================================================================
# build_clusters / sorted_cluster_items
# =============================================================================
def test_build_clusters_groups_by_grid_cell():
    rows = [
        _row("a", 10.1, 20.1, _dt("2020-01-01T00:00:00Z")),
        _row("b", 10.9, 20.9, _dt("2020-01-01T00:00:00Z")),
        _row("c", 50.0, 50.0, _dt("2020-01-01T00:00:00Z")),
    ]
    clusters = build_clusters(rows, cell_deg=1.0)
    assert clusters[(10, 20)] == [rows[0], rows[1]]
    assert clusters[(50, 50)] == [rows[2]]


def test_sorted_cluster_items_orders_by_min_member_id_deterministically():
    clusters = {
        (1, 1): [_row("z", 1.5, 1.5, _dt("2020-01-01T00:00:00Z"))],
        (2, 2): [_row("a", 2.5, 2.5, _dt("2020-01-01T00:00:00Z"))],
    }
    items = sorted_cluster_items(clusters, min_size=1)
    assert [key for key, _members in items] == [(2, 2), (1, 1)]


def test_sorted_cluster_items_filters_by_min_size():
    clusters = {
        (1, 1): [_row("a", 1.0, 1.0, _dt("2020-01-01T00:00:00Z"))],
        (2, 2): [
            _row("b", 2.0, 2.0, _dt("2020-01-01T00:00:00Z")),
            _row("c", 2.1, 2.1, _dt("2020-01-01T00:00:00Z")),
        ],
    }
    items = sorted_cluster_items(clusters, min_size=2)
    assert [key for key, _members in items] == [(2, 2)]


# =============================================================================
# build_radius_window_queries
# =============================================================================
def _dense_two_cluster_corpus():
    rows = []
    base = _dt("2020-01-01T00:00:00Z")
    for i in range(3):
        rows.append(_row(f"cluster1-{i}", 10.0 + i * 0.01, 20.0 + i * 0.01, base + timedelta(days=i)))
    for i in range(3):
        rows.append(_row(f"cluster2-{i}", 50.0 + i * 0.01, 60.0 + i * 0.01, base + timedelta(days=i)))
    return rows


def test_build_radius_window_queries_gold_covers_own_cluster_members():
    rows = _dense_two_cluster_corpus()
    clusters = build_clusters(rows, cell_deg=1.0)
    queries, clusters_used_size_1 = build_radius_window_queries(rows, clusters, n=25)
    assert len(queries) == 2
    assert clusters_used_size_1 == 0
    for q in queries:
        assert q["family"] == "radius_window"
        assert q["expect_empty"] is False
        assert len(q["gold_ids"]) >= 3  # at least its own cluster's members


def test_build_radius_window_queries_respects_n_cap():
    rows = _dense_two_cluster_corpus()
    clusters = build_clusters(rows, cell_deg=1.0)
    queries, _ = build_radius_window_queries(rows, clusters, n=1)
    assert len(queries) == 1


def test_build_radius_window_queries_qids_sequential_and_zero_padded():
    rows = _dense_two_cluster_corpus()
    clusters = build_clusters(rows, cell_deg=1.0)
    queries, _ = build_radius_window_queries(rows, clusters, n=25)
    assert [q["qid"] for q in queries] == ["rw_0001", "rw_0002"]


def test_build_radius_window_queries_falls_back_to_size_one_clusters():
    rows = [
        _row("only-a", 10.0, 20.0, _dt("2020-01-01T00:00:00Z")),
        _row("only-b", 50.0, 60.0, _dt("2020-01-01T00:00:00Z")),
    ]
    clusters = build_clusters(rows, cell_deg=1.0)
    queries, clusters_used_size_1 = build_radius_window_queries(rows, clusters, n=25)
    assert len(queries) == 2
    assert clusters_used_size_1 == 2


def test_build_radius_window_queries_window_never_zero_width():
    rows = [_row(f"same-day-{i}", 10.0, 20.0, _dt("2020-01-01T00:00:00Z")) for i in range(3)]
    clusters = build_clusters(rows, cell_deg=1.0)
    queries, _ = build_radius_window_queries(rows, clusters, n=25)
    q = queries[0]
    start = parse_iso8601(q["window"]["start"])
    end = parse_iso8601(q["window"]["end"])
    assert end > start


# =============================================================================
# build_precedence_queries
# =============================================================================
def test_build_precedence_queries_gold_is_strictly_before_anchor():
    base = _dt("2020-01-10T00:00:00Z")
    rows = [
        _row("record-x", 10.0, 20.0, base),
        _row("before-3d", 10.0, 20.0, base - timedelta(days=3)),
        _row("same-instant", 10.0, 20.0, base),
        _row("after", 10.0, 20.0, base + timedelta(days=1)),
        _row("too-early", 10.0, 20.0, base - timedelta(days=30)),
    ]
    clusters = build_clusters(rows, cell_deg=1.0)
    # All 5 rows share one grid cell -- cluster-level dedup (see
    # build_precedence_queries) means only the FIRST anchor (sorted by id)
    # with non-empty gold produces a query. Anchors sorted alphabetically:
    # "after" < "before-3d" < "record-x" < "same-instant" < "too-early", so
    # "after" (date = base + 1 day) is that first anchor.
    queries = build_precedence_queries(rows, clusters, n=15)
    assert len(queries) == 1
    q = queries[0]
    assert set(q["gold_ids"]) == {"record-x", "before-3d", "same-instant"}
    assert "after" not in q["gold_ids"]  # end exclusive: anchor's own instant excluded
    assert "too-early" not in q["gold_ids"]  # outside the 7-day lookback


def test_build_precedence_queries_skips_anchors_with_empty_gold():
    rows = [_row("lonely", 10.0, 20.0, _dt("2020-01-01T00:00:00Z"))]
    clusters = build_clusters(rows, cell_deg=1.0)
    queries = build_precedence_queries(rows, clusters, n=15)
    assert queries == []


def test_build_precedence_queries_dedupes_by_cluster_collapses_to_one():
    # A single-event-dominated corpus (many records, one location) must not
    # collapse most of `n` requested queries onto near-identical copies of
    # the same centroid/radius -- see build_precedence_queries' docstring.
    base = _dt("2020-06-01T00:00:00Z")
    rows = [_row(f"id{i:03d}", 10.0, 20.0, base + timedelta(days=i)) for i in range(20)]
    clusters = build_clusters(rows, cell_deg=1.0)
    queries = build_precedence_queries(rows, clusters, n=15)
    assert len(queries) == 1


def test_build_precedence_queries_respects_n_cap():
    # 6 distinct clusters (10 degrees apart -- well outside a 1-degree
    # cell), 2 members each: the earlier member has no "before" gold and is
    # skipped without consuming the cluster's slot; the later member
    # succeeds and marks the cluster used. Cap n=5 to verify the 6th
    # cluster is never reached.
    base = _dt("2020-06-01T00:00:00Z")
    rows = []
    for cluster_idx in range(6):
        lat = 10.0 + cluster_idx * 10.0
        rows.append(_row(f"c{cluster_idx}-early", lat, 20.0, base))
        rows.append(_row(f"c{cluster_idx}-late", lat, 20.0, base + timedelta(days=1)))
    clusters = build_clusters(rows, cell_deg=1.0)
    queries = build_precedence_queries(rows, clusters, n=5)
    assert len(queries) == 5
    assert [q["qid"] for q in queries] == ["pr_0001", "pr_0002", "pr_0003", "pr_0004", "pr_0005"]
    # Each built query's gold is exactly its own cluster's "early" member.
    for i, q in enumerate(queries):
        assert q["gold_ids"] == [f"c{i}-early"]


def test_build_precedence_queries_text_uses_cluster_centroid_not_raw_anchor():
    # The centroid can differ from the anchor's own raw coordinates once a
    # cluster has >1 member; the query text must describe the location
    # actually used as the geo filter center, not the anchor's raw point.
    base = _dt("2020-01-10T00:00:00Z")
    rows = [
        _row("anchor", 10.0, 20.0, base),
        _row("neighbor", 10.02, 20.02, base - timedelta(days=1)),
    ]
    clusters = build_clusters(rows, cell_deg=1.0)
    queries = build_precedence_queries(rows, clusters, n=15)
    assert len(queries) == 1
    q = queries[0]
    center_lat, center_lon = q["geo"]["lat"], q["geo"]["lon"]
    assert f"{center_lat:.4f}" in q["text"]
    assert f"{center_lon:.4f}" in q["text"]
    assert center_lat != 10.0 or center_lon != 20.0  # centroid, not the raw anchor point


def test_build_precedence_queries_window_carries_end_exclusive_flag():
    base = _dt("2020-06-01T00:00:00Z")
    rows = [
        _row("early", 10.0, 20.0, base - timedelta(days=1)),
        _row("late", 10.0, 20.0, base),
    ]
    clusters = build_clusters(rows, cell_deg=1.0)
    queries = build_precedence_queries(rows, clusters, n=15)
    assert len(queries) == 1
    assert queries[0]["window"]["end_inclusive"] is False


# =============================================================================
# build_negative_controls
# =============================================================================
def test_build_negative_controls_shifts_center_over_2000km_and_verifies_empty():
    rows = [_row("a", 10.0, 20.0, _dt("2020-01-01T00:00:00Z"))]
    base_queries = [{
        "qid": "rw_0001", "family": "radius_window", "text": "sample query",
        "geo": {"lat": 10.0, "lon": 20.0, "radius_m": 1000.0},
        "window": {"start": "2020-01-01T00:00:00Z", "end": "2020-01-02T00:00:00Z"},
        "gold_ids": ["a"], "expect_empty": False,
    }]
    negatives = build_negative_controls(base_queries, rows, n=1)
    assert len(negatives) == 1
    neg = negatives[0]
    assert neg["family"] == "negative"
    assert neg["expect_empty"] is True
    assert neg["gold_ids"] == []
    assert neg["text"] == "sample query"  # same text as source, per spec
    dist = haversine_distance_m(10.0, 20.0, neg["geo"]["lat"], neg["geo"]["lon"])
    assert dist > 2_000_000
    # Verify claim: no corpus row actually falls inside the shifted radius.
    overlap = compute_in_radius_window_ids(rows, neg["geo"]["lat"], neg["geo"]["lon"], neg["geo"]["radius_m"])
    assert overlap == []


def test_build_negative_controls_qids_sequential():
    rows = [_row("a", 10.0, 20.0, _dt("2020-01-01T00:00:00Z")), _row("b", -30.0, 100.0, _dt("2020-01-01T00:00:00Z"))]
    base_queries = [
        {"qid": "rw_0001", "family": "radius_window", "text": "q1",
         "geo": {"lat": 10.0, "lon": 20.0, "radius_m": 1000.0}, "window": None,
         "gold_ids": ["a"], "expect_empty": False},
        {"qid": "rw_0002", "family": "radius_window", "text": "q2",
         "geo": {"lat": -30.0, "lon": 100.0, "radius_m": 1000.0}, "window": None,
         "gold_ids": ["b"], "expect_empty": False},
    ]
    negatives = build_negative_controls(base_queries, rows, n=2)
    assert [n["qid"] for n in negatives] == ["neg_0001", "neg_0002"]


def test_build_negative_controls_clamps_near_pole_shift_within_valid_latitude():
    rows = [_row("a", 85.0, 20.0, _dt("2020-01-01T00:00:00Z"))]
    base_queries = [{
        "qid": "rw_0001", "family": "radius_window", "text": "polar query",
        "geo": {"lat": 85.0, "lon": 20.0, "radius_m": 1000.0}, "window": None,
        "gold_ids": ["a"], "expect_empty": False,
    }]
    negatives = build_negative_controls(base_queries, rows, n=1)
    assert len(negatives) == 1
    assert -90.0 <= negatives[0]["geo"]["lat"] <= 90.0


# =============================================================================
# write_queries_jsonl / load_local_gkg_rows -- file I/O
# =============================================================================
def test_write_queries_jsonl_round_trips(tmp_path):
    path = tmp_path / "queries.jsonl"
    queries = [
        {"qid": "rw_0001", "family": "radius_window", "text": "t", "geo": {"lat": 1.0, "lon": 2.0, "radius_m": 3.0},
         "window": {"start": "2020-01-01T00:00:00Z", "end": "2020-01-02T00:00:00Z"},
         "gold_ids": ["a", "b"], "expect_empty": False},
    ]
    write_queries_jsonl(str(path), queries)
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0]) == queries[0]


def test_load_local_gkg_rows_reuses_task4_parser(tmp_path):
    # type#name#cc#adm1#adm2#lat#lon#featureid (V2Locations, 8 fields)
    v2locations = "3#Baltimore, Maryland, United States#US#USMD#USMD005#39.2904#-76.6122#4347778"
    row = ["20150326000000-0", "20150326120000"] + [""] * 8 + [v2locations] + [""] * 16
    # Pad/trim to the canonical 27-column layout expected by _DEFAULT_COLUMNS.
    from ingest_gkg import _DEFAULT_COLUMNS
    full_row = [""] * len(_DEFAULT_COLUMNS)
    full_row[_DEFAULT_COLUMNS["gkgrecordid"]] = "20150326000000-0"
    full_row[_DEFAULT_COLUMNS["date"]] = "20150326120000"
    full_row[_DEFAULT_COLUMNS["v2locations"]] = v2locations
    full_row[_DEFAULT_COLUMNS["allnames"]] = "Baltimore,1"

    path = tmp_path / "sample.tsv"
    path.write_text("\t".join(full_row), encoding="utf-8")

    rows, stats = load_local_gkg_rows(str(path), "gdelt-user")
    assert stats == LoadStats(total_rows=1, skipped_blank=0, missing_geo=0, missing_date=0, usable=1)
    assert len(rows) == 1
    assert rows[0]["lat"] == 39.2904
    assert rows[0]["lon"] == -76.6122
    assert rows[0]["created_at"] == parse_iso8601("2015-03-26T12:00:00Z")
    assert "Baltimore" in rows[0]["content"]


def test_load_local_gkg_rows_counts_missing_geo_and_date_without_dropping_row(tmp_path):
    from ingest_gkg import _DEFAULT_COLUMNS
    full_row = [""] * len(_DEFAULT_COLUMNS)
    full_row[_DEFAULT_COLUMNS["gkgrecordid"]] = "20150326000000-1"
    full_row[_DEFAULT_COLUMNS["date"]] = "garbage-date"
    full_row[_DEFAULT_COLUMNS["allnames"]] = "SomeName,1"

    path = tmp_path / "sample.tsv"
    path.write_text("\t".join(full_row), encoding="utf-8")

    rows, stats = load_local_gkg_rows(str(path), "u")
    assert stats.total_rows == 1
    assert stats.missing_geo == 1
    assert stats.missing_date == 1
    assert stats.usable == 0
    assert rows == []  # not usable for gold derivation (no geo+date), but was counted, not silently lost


def test_load_local_gkg_rows_missing_file_raises_oserror():
    with pytest.raises(OSError):
        load_local_gkg_rows("does-not-exist.tsv", "u")


# =============================================================================
# fetch_all_server_memories -- stubbed HTTP pagination
# =============================================================================
class _FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_fetch_all_server_memories_paginates_until_total_reached(monkeypatch):
    pages = {
        0: {"memories": [{"id": "1", "content": "a", "content_truncated": False, "content_length": 1}], "total": 3},
        1: {"memories": [{"id": "2", "content": "b", "content_truncated": False, "content_length": 1}], "total": 3},
        2: {"memories": [{"id": "3", "content": "c", "content_truncated": False, "content_length": 1}], "total": 3},
    }
    calls = []

    def fake_urlopen(request, timeout=None):
        calls.append(request.full_url)
        offset = int(request.full_url.split("offset=")[1].split("&")[0])
        return _FakeResponse(json.dumps(pages[offset]).encode("utf-8"))

    monkeypatch.setattr(build_queries.urllib.request, "urlopen", fake_urlopen)

    items = fetch_all_server_memories("http://localhost:9944", "u", page_size=1)
    assert [i["id"] for i in items] == ["1", "2", "3"]
    assert len(calls) == 3


def test_fetch_all_server_memories_stops_on_empty_page(monkeypatch):
    def fake_urlopen(request, timeout=None):
        return _FakeResponse(json.dumps({"memories": [], "total": 0}).encode("utf-8"))

    monkeypatch.setattr(build_queries.urllib.request, "urlopen", fake_urlopen)
    items = fetch_all_server_memories("http://localhost:9944", "u", page_size=100)
    assert items == []


def test_fetch_all_server_memories_sends_user_id_and_bearer_header(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        captured["auth"] = request.get_header("Authorization")
        return _FakeResponse(json.dumps({"memories": [], "total": 0}).encode("utf-8"))

    monkeypatch.setattr(build_queries.urllib.request, "urlopen", fake_urlopen)
    fetch_all_server_memories("http://localhost:9944", "gdelt-user", api_key="secret")
    assert "user_id=gdelt-user" in captured["url"]
    assert captured["auth"] == "Bearer secret"


# =============================================================================
# run() / main() -- end-to-end orchestration, stubbed HTTP
# =============================================================================
def test_run_end_to_end_with_stubbed_server(monkeypatch, tmp_path):
    from ingest_gkg import _DEFAULT_COLUMNS

    def make_row(gkgrecordid, lat_lon_block, date):
        row = [""] * len(_DEFAULT_COLUMNS)
        row[_DEFAULT_COLUMNS["gkgrecordid"]] = gkgrecordid
        row[_DEFAULT_COLUMNS["date"]] = date
        row[_DEFAULT_COLUMNS["v2locations"]] = lat_lon_block
        row[_DEFAULT_COLUMNS["allnames"]] = f"Name{gkgrecordid},1"
        return row

    v2 = "3#Place#US#USMD#USMD005#{lat}#{lon}#fid"
    rows = [
        make_row("0", v2.format(lat="10.0", lon="20.0"), "20200101000000"),
        make_row("1", v2.format(lat="10.01", lon="20.01"), "20200102000000"),
        make_row("2", v2.format(lat="10.02", lon="20.02"), "20200103000000"),
    ]
    gkg_path = tmp_path / "sample.tsv"
    gkg_path.write_text("\n".join("\t".join(r) for r in rows), encoding="utf-8")
    out_path = tmp_path / "queries.jsonl"

    # Simulate: the server already has these three records under their
    # content-derived ids (matching what build_payload would have produced).
    from ingest_gkg import build_payload, iter_gkg_rows
    columns, parsed_rows = iter_gkg_rows(str(gkg_path))
    server_items = []
    for i, r in enumerate(parsed_rows):
        payload, _ = build_payload(r, "gdelt-user", columns)
        server_items.append({
            "id": f"srv-{i}",
            "content": payload["content"][:500],
            "content_truncated": len(payload["content"]) > 500,
            "content_length": len(payload["content"]),
        })

    def fake_urlopen(request, timeout=None):
        return _FakeResponse(json.dumps({"memories": server_items, "total": len(server_items)}).encode("utf-8"))

    monkeypatch.setattr(build_queries.urllib.request, "urlopen", fake_urlopen)

    summary = run([
        "--server", "http://localhost:9944", "--user-id", "gdelt-user",
        "--gkg-input", str(gkg_path), "--output", str(out_path),
        "--num-radius-window", "1", "--num-precedence", "1", "--num-negative", "1",
    ])

    assert summary["gkg_rows_usable"] == 3
    assert summary["rows_matched"] == 3
    assert summary["rows_unmatched"] == 0
    assert out_path.exists()
    lines = out_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 3  # 1 radius_window + 1 precedence + 1 negative
    families = {json.loads(line)["family"] for line in lines}
    assert families == {"radius_window", "precedence", "negative"}


def test_run_gates_on_correlation_loss_above_threshold(monkeypatch, tmp_path):
    from ingest_gkg import _DEFAULT_COLUMNS

    def make_row(gkgrecordid, lat_lon_block, date):
        row = [""] * len(_DEFAULT_COLUMNS)
        row[_DEFAULT_COLUMNS["gkgrecordid"]] = gkgrecordid
        row[_DEFAULT_COLUMNS["date"]] = date
        row[_DEFAULT_COLUMNS["v2locations"]] = lat_lon_block
        row[_DEFAULT_COLUMNS["allnames"]] = f"Name{gkgrecordid},1"
        return row

    v2 = "3#Place#US#USMD#USMD005#{lat}#{lon}#fid"
    rows = [
        make_row("0", v2.format(lat="10.0", lon="20.0"), "20200101000000"),
        make_row("1", v2.format(lat="10.01", lon="20.01"), "20200102000000"),
    ]
    gkg_path = tmp_path / "sample.tsv"
    gkg_path.write_text("\n".join("\t".join(r) for r in rows), encoding="utf-8")
    out_path = tmp_path / "queries.jsonl"

    # Server has NOTHING matching this content -- 100% unmatched, well over
    # the 5% MAX_UNMATCHED_FRACTION gate.
    def fake_urlopen(request, timeout=None):
        return _FakeResponse(json.dumps({"memories": [], "total": 0}).encode("utf-8"))

    monkeypatch.setattr(build_queries.urllib.request, "urlopen", fake_urlopen)

    summary = run([
        "--server", "http://localhost:9944", "--user-id", "gdelt-user",
        "--gkg-input", str(gkg_path), "--output", str(out_path),
    ])

    assert "error" in summary
    assert "correlation loss" in summary["error"]
    assert summary["correlation_unmatched_fraction"] == pytest.approx(1.0)
    assert not out_path.exists()  # must not emit a query set from a partially-correlated corpus


def test_run_below_threshold_correlation_loss_still_succeeds(monkeypatch, tmp_path):
    # Regression guard for the gate above: a corpus that correlates
    # completely (0% unmatched) must not be caught by the >5% threshold.
    from ingest_gkg import _DEFAULT_COLUMNS, build_payload, iter_gkg_rows

    def make_row(gkgrecordid, lat_lon_block, date):
        row = [""] * len(_DEFAULT_COLUMNS)
        row[_DEFAULT_COLUMNS["gkgrecordid"]] = gkgrecordid
        row[_DEFAULT_COLUMNS["date"]] = date
        row[_DEFAULT_COLUMNS["v2locations"]] = lat_lon_block
        row[_DEFAULT_COLUMNS["allnames"]] = f"Name{gkgrecordid},1"
        return row

    v2 = "3#Place#US#USMD#USMD005#{lat}#{lon}#fid"
    rows = [
        make_row("0", v2.format(lat="10.0", lon="20.0"), "20200101000000"),
        make_row("1", v2.format(lat="10.01", lon="20.01"), "20200102000000"),
        make_row("2", v2.format(lat="10.02", lon="20.02"), "20200103000000"),
    ]
    gkg_path = tmp_path / "sample.tsv"
    gkg_path.write_text("\n".join("\t".join(r) for r in rows), encoding="utf-8")
    out_path = tmp_path / "queries.jsonl"

    columns, parsed_rows = iter_gkg_rows(str(gkg_path))
    server_items = []
    for i, r in enumerate(parsed_rows):
        payload, _ = build_payload(r, "gdelt-user", columns)
        server_items.append({
            "id": f"srv-{i}",
            "content": payload["content"][:500],
            "content_truncated": len(payload["content"]) > 500,
            "content_length": len(payload["content"]),
        })

    def fake_urlopen(request, timeout=None):
        return _FakeResponse(json.dumps({"memories": server_items, "total": len(server_items)}).encode("utf-8"))

    monkeypatch.setattr(build_queries.urllib.request, "urlopen", fake_urlopen)

    summary = run([
        "--server", "http://localhost:9944", "--user-id", "gdelt-user",
        "--gkg-input", str(gkg_path), "--output", str(out_path),
    ])
    assert "error" not in summary
    assert summary["correlation_unmatched_fraction"] == pytest.approx(0.0)
    assert out_path.exists()


def test_run_success_summary_reports_requested_counts_alongside_built(monkeypatch, tmp_path):
    from ingest_gkg import _DEFAULT_COLUMNS, build_payload, iter_gkg_rows

    def make_row(gkgrecordid, lat_lon_block, date):
        row = [""] * len(_DEFAULT_COLUMNS)
        row[_DEFAULT_COLUMNS["gkgrecordid"]] = gkgrecordid
        row[_DEFAULT_COLUMNS["date"]] = date
        row[_DEFAULT_COLUMNS["v2locations"]] = lat_lon_block
        row[_DEFAULT_COLUMNS["allnames"]] = f"Name{gkgrecordid},1"
        return row

    v2 = "3#Place#US#USMD#USMD005#{lat}#{lon}#fid"
    rows = [
        make_row("0", v2.format(lat="10.0", lon="20.0"), "20200101000000"),
        make_row("1", v2.format(lat="10.01", lon="20.01"), "20200102000000"),
        make_row("2", v2.format(lat="10.02", lon="20.02"), "20200103000000"),
    ]
    gkg_path = tmp_path / "sample.tsv"
    gkg_path.write_text("\n".join("\t".join(r) for r in rows), encoding="utf-8")
    out_path = tmp_path / "queries.jsonl"

    columns, parsed_rows = iter_gkg_rows(str(gkg_path))
    server_items = []
    for i, r in enumerate(parsed_rows):
        payload, _ = build_payload(r, "gdelt-user", columns)
        server_items.append({
            "id": f"srv-{i}",
            "content": payload["content"][:500],
            "content_truncated": len(payload["content"]) > 500,
            "content_length": len(payload["content"]),
        })

    def fake_urlopen(request, timeout=None):
        return _FakeResponse(json.dumps({"memories": server_items, "total": len(server_items)}).encode("utf-8"))

    monkeypatch.setattr(build_queries.urllib.request, "urlopen", fake_urlopen)

    summary = run([
        "--server", "http://localhost:9944", "--user-id", "gdelt-user",
        "--gkg-input", str(gkg_path), "--output", str(out_path),
        "--num-radius-window", "25", "--num-precedence", "15", "--num-negative", "10",
    ])

    assert "error" not in summary
    assert summary["radius_window_requested"] == 25
    assert summary["precedence_requested"] == 15
    assert summary["negative_requested"] == 10
    # This tiny 3-record single-cluster corpus can't possibly yield 25/15/10
    # distinct results -- the shortfall must be visible, not padded.
    assert summary["radius_window_built"] < summary["radius_window_requested"]
    assert summary["precedence_built"] < summary["precedence_requested"]


def test_main_exits_nonzero_on_missing_gkg_input(tmp_path, capsys):
    with pytest.raises(SystemExit) as exc_info:
        main([
            "--server", "http://x", "--user-id", "u",
            "--gkg-input", str(tmp_path / "nope.tsv"), "--output", str(tmp_path / "out.jsonl"),
        ])
    assert exc_info.value.code != 0
    printed = json.loads(capsys.readouterr().out.strip())
    assert "error" in printed
