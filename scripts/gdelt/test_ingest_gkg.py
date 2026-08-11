import csv
import json
import urllib.error

import pytest

import ingest_gkg
from ingest_gkg import (
    RowStats,
    build_content,
    build_payload,
    detect_columns,
    iter_gkg_rows,
    looks_like_header,
    main,
    parse_gkg_date,
    post_remember,
    run,
    _DEFAULT_COLUMNS,
)

# type#fullname#countrycode#adm1code#lat#lon#featureid (legacy V1Locations shape)
V1_LOCATIONS = "3#Baltimore, Maryland, United States#US#USMD#39.2904#-76.6122#4347778"

# True GKG 2.1 V2Locations block: adds ADM2Code before lat, CharOffset after featureid.
# v2locations.parse_v2locations() handles this shape natively (no adapter needed
# in this module -- see v2locations.py's module docstring for the shape table).
V2_LOCATIONS = "3#Baltimore, Maryland, United States#US#USMD#USMD005#39.2904#-76.6122#4347778#128"


def make_row(**overrides):
    row = [""] * len(_DEFAULT_COLUMNS)
    row[_DEFAULT_COLUMNS["gkgrecordid"]] = overrides.get("gkgrecordid", "20150326000000-0")
    row[_DEFAULT_COLUMNS["date"]] = overrides.get("date", "20150326120000")
    row[_DEFAULT_COLUMNS["sourcecommonname"]] = overrides.get("sourcecommonname", "nytimes.com")
    row[_DEFAULT_COLUMNS["documentidentifier"]] = overrides.get(
        "documentidentifier", "http://nytimes.com/article1"
    )
    row[_DEFAULT_COLUMNS["v2locations"]] = overrides.get("v2locations", V2_LOCATIONS)
    row[_DEFAULT_COLUMNS["allnames"]] = overrides.get(
        "allnames", "Francis Scott Key Bridge,10;Baltimore,40"
    )
    return row


def _write_csv(path, rows, delimiter=","):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh, delimiter=delimiter)
        for row in rows:
            writer.writerow(row)


# =============================================================================
# parse_gkg_date
# =============================================================================
def test_parse_gkg_date_full_precision():
    assert parse_gkg_date("20150326120000") == "2015-03-26T12:00:00Z"


def test_parse_gkg_date_day_only():
    assert parse_gkg_date("20150326") == "2015-03-26T00:00:00Z"


def test_parse_gkg_date_malformed_returns_none_not_fatal():
    assert parse_gkg_date("notadate") is None
    assert parse_gkg_date("") is None
    assert parse_gkg_date("20151399120000") is None  # bad month/day


# =============================================================================
# build_payload: the row -> (payload, RowStats) transform (the core contract)
# =============================================================================
def test_build_payload_full_row_has_geo_and_timestamp():
    row = make_row()
    payload, stats = build_payload(row, "gdelt-user")
    assert payload["user_id"] == "gdelt-user"
    assert payload["geo_location"] == [39.2904, -76.6122, 0.0]
    assert payload["created_at"] == "2015-03-26T12:00:00Z"
    assert "gdelt" in payload["tags"]
    assert "nytimes.com" in payload["tags"]
    assert payload["content"]  # non-empty, embeddable text
    assert "Baltimore" in payload["content"] or "Francis Scott Key Bridge" in payload["content"]
    assert stats == RowStats(missing_location=False, location_parse_failed=False, date_parse_failed=False)


def test_build_payload_resolves_true_v2_locations_not_v1_shaped():
    # This is the field-shape regression: parsing the *true* V2Locations
    # block (with ADM2Code) must still yield the correct coordinates, not
    # silently misread ADM2Code as latitude and not silently drop the block.
    # (v2locations.parse_v2locations handles this shape natively.)
    row = make_row(v2locations=V2_LOCATIONS)
    payload, _stats = build_payload(row, "u")
    assert payload["geo_location"] == [39.2904, -76.6122, 0.0]


def test_build_payload_missing_locations_still_ingests_text():
    row = make_row(v2locations="")
    payload, stats = build_payload(row, "u")
    assert payload is not None
    assert "geo_location" not in payload
    assert payload["content"]
    assert stats.missing_location is True
    assert stats.location_parse_failed is False  # no data present, not a parse failure


def test_build_payload_location_present_but_unusable_counts_as_parse_failed():
    # The row *had* location text, but none of it resolved to usable
    # coordinates -- this is data loss, distinct from "no location supplied".
    row = make_row(v2locations="garbage#novalues")
    payload, stats = build_payload(row, "u")
    assert payload is not None
    assert "geo_location" not in payload
    assert stats.missing_location is False
    assert stats.location_parse_failed is True


def test_build_payload_malformed_date_omits_created_at_not_fatal():
    row = make_row(date="garbage-date")
    payload, stats = build_payload(row, "u")
    assert payload is not None
    assert "created_at" not in payload
    assert payload["content"]
    assert stats.date_parse_failed is True


def test_build_payload_blank_date_is_not_counted_as_parse_failure():
    row = make_row(date="")
    payload, stats = build_payload(row, "u")
    assert payload is not None
    assert "created_at" not in payload
    assert stats.date_parse_failed is False


def test_build_payload_out_of_range_coords_dropped_not_fatal():
    bad_block = "3#Nowhere#US#US#US#999.0#-76.6122#id#1"
    row = make_row(v2locations=bad_block)
    payload, stats = build_payload(row, "u")
    assert payload is not None
    assert "geo_location" not in payload
    assert stats.location_parse_failed is True  # data was present, but unusable


def test_build_payload_blank_row_skipped():
    assert build_payload([], "u") == (None, RowStats(False, False, False))
    assert build_payload(["", "", ""], "u") == (None, RowStats(False, False, False))
    assert build_payload([""] * len(_DEFAULT_COLUMNS), "u") == (None, RowStats(False, False, False))


def test_build_payload_truncated_row_no_crash_and_no_geo():
    row = ["20150326000000-0", "20150326120000", "1", "src.com", "http://src.com/z"]
    payload, stats = build_payload(row, "u")
    assert payload is not None
    assert "geo_location" not in payload
    assert payload["content"]
    assert stats.missing_location is True  # v2locations column doesn't exist in this truncated row


def test_build_content_falls_back_when_nothing_but_record_id():
    row = [""] * len(_DEFAULT_COLUMNS)
    row[_DEFAULT_COLUMNS["gkgrecordid"]] = "20150326000000-9"
    content = build_content(row, _DEFAULT_COLUMNS, [])
    assert content == "GDELT GKG record 20150326000000-9"


# =============================================================================
# header / column detection
# =============================================================================
def test_looks_like_header_true_for_column_name_false_for_record_id():
    assert looks_like_header(["GKGRECORDID", "DATE"]) is True
    assert looks_like_header(["20150326000000-0", "20150326120000"]) is False
    assert looks_like_header([]) is False


def test_detect_columns_bigquery_header_reorders_correctly():
    header = ["GKGRECORDID", "DATE", "V2Locations", "AllNames"]  # deliberately partial/reordered-looking
    columns = detect_columns(header)
    assert columns["gkgrecordid"] == 0
    assert columns["date"] == 1
    assert columns["v2locations"] == 2
    assert columns["allnames"] == 3
    # untouched canonical columns still resolve to their default position
    assert columns["sourcecommonname"] == _DEFAULT_COLUMNS["sourcecommonname"]


def test_detect_columns_no_header_falls_back_to_canonical():
    assert detect_columns(None) == _DEFAULT_COLUMNS
    assert detect_columns(["20150326000000-0", "20150326120000"]) == _DEFAULT_COLUMNS


# =============================================================================
# iter_gkg_rows: deterministic file reading, header handling
# =============================================================================
def test_iter_gkg_rows_headerless_tsv_preserves_file_order(tmp_path):
    lines = ["\t".join(make_row(gkgrecordid=str(i))) for i in range(3)]
    path = tmp_path / "sample.tsv"
    path.write_text("\n".join(lines), encoding="utf-8")
    columns, rows = iter_gkg_rows(str(path))
    ids = [r[columns["gkgrecordid"]] for r in rows]
    assert ids == ["0", "1", "2"]


def test_iter_gkg_rows_with_canonical_header_is_consumed_not_yielded_as_data(tmp_path):
    header = _CANONICAL_HEADER_LINE()
    data_row = make_row(gkgrecordid="1")
    path = tmp_path / "sample.csv"
    _write_csv(path, [header, data_row])
    columns, rows = iter_gkg_rows(str(path))
    rows = list(rows)
    assert len(rows) == 1
    assert rows[0][columns["gkgrecordid"]] == "1"


def test_iter_gkg_rows_narrowed_reordered_header_resolves_v2locations_column(tmp_path):
    # Regression for the header-branch bug: a header whose first cell is
    # GKGRECORDID must ALWAYS be resolved by name via detect_columns(),
    # never assumed to already be in canonical (27-column) order. A
    # narrowed/reordered BigQuery export -- exactly what detect_columns()
    # exists for -- has V2Locations at index 2, not the canonical index 10.
    # If the header branch regresses to the canonical-order assumption,
    # columns["v2locations"] would come back as 10, which doesn't exist in
    # this 4-column row, and _col() would silently return "" -- geo-tagging
    # would vanish with zero signal.
    header = ["GKGRECORDID", "DATE", "V2Locations", "AllNames"]
    data_row = ["20150326000000-0", "20150326120000", V2_LOCATIONS, "Baltimore,1"]
    path = tmp_path / "narrow.csv"
    _write_csv(path, [header, data_row])

    columns, rows = iter_gkg_rows(str(path))
    rows = list(rows)
    assert len(rows) == 1
    assert columns["v2locations"] == 2
    assert rows[0][columns["v2locations"]] == V2_LOCATIONS

    # End-to-end: build_payload must resolve real coordinates from the
    # narrowed layout, not silently drop them.
    payload, stats = build_payload(rows[0], "u", columns)
    assert payload["geo_location"] == [39.2904, -76.6122, 0.0]
    assert stats.location_parse_failed is False


def _CANONICAL_HEADER_LINE():
    return [
        "GKGRECORDID", "DATE", "SourceCollectionIdentifier", "SourceCommonName",
        "DocumentIdentifier", "V1Counts", "V2Counts", "V1Themes", "V2Themes",
        "V1Locations", "V2Locations", "V1Persons", "V2Persons", "V1Organizations",
        "V2Organizations", "V15Tone", "Dates", "GCAM", "SharingImage",
        "RelatedImages", "SocialImageEmbeds", "SocialVideoEmbeds", "Quotations",
        "AllNames", "Amounts", "TranslationInfo", "Extras",
    ]


def test_iter_gkg_rows_empty_file(tmp_path):
    path = tmp_path / "empty.tsv"
    path.write_text("", encoding="utf-8")
    columns, rows = iter_gkg_rows(str(path))
    assert list(rows) == []


# =============================================================================
# post_remember: HTTP layer, stubbed (never calls a live server)
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


def test_post_remember_sends_json_body_to_correct_url(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data.decode("utf-8"))
        captured["headers"] = dict(request.header_items())
        return _FakeResponse(b'{"success": true, "id": "abc-123"}')

    monkeypatch.setattr(ingest_gkg.urllib.request, "urlopen", fake_urlopen)

    result = post_remember("http://localhost:9944", {"user_id": "u", "content": "c"})

    assert captured["url"] == "http://localhost:9944/api/remember"
    assert captured["body"] == {"user_id": "u", "content": "c"}
    assert result == {"success": True, "id": "abc-123"}


def test_post_remember_sets_bearer_header_when_api_key_given(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["auth"] = request.get_header("Authorization")
        return _FakeResponse(b"{}")

    monkeypatch.setattr(ingest_gkg.urllib.request, "urlopen", fake_urlopen)
    post_remember("http://localhost:9944", {"content": "c"}, api_key="secret-key")
    assert captured["auth"] == "Bearer secret-key"


def test_post_remember_guards_malformed_json_body(monkeypatch):
    # The response body is otherwise unused by run() -- a malformed body
    # must not raise and kill an otherwise-successful ingest run.
    def fake_urlopen(request, timeout=None):
        return _FakeResponse(b"not json{{{")

    monkeypatch.setattr(ingest_gkg.urllib.request, "urlopen", fake_urlopen)
    result = post_remember("http://localhost:9944", {"content": "c"})
    assert result == {}


# =============================================================================
# run(): end-to-end orchestration with stubbed HTTP
# =============================================================================
def test_run_dry_run_never_calls_http(monkeypatch, tmp_path):
    def fail_urlopen(*a, **k):
        raise AssertionError("dry-run must not perform HTTP calls")

    monkeypatch.setattr(ingest_gkg.urllib.request, "urlopen", fail_urlopen)

    lines = ["\t".join(make_row(gkgrecordid=str(i))) for i in range(3)]
    path = tmp_path / "sample.tsv"
    path.write_text("\n".join(lines), encoding="utf-8")

    summary = run(["--server", "http://x", "--user-id", "u", "--input", str(path), "--dry-run"])
    assert summary == {
        "parsed": 3,
        "skipped": 0,
        "posted": 0,
        "errors": 0,
        "rows_missing_location": 0,
        "rows_location_parse_failed": 0,
        "date_parse_failed": 0,
        "dry_run": True,
    }


def test_run_respects_limit(monkeypatch, tmp_path):
    lines = ["\t".join(make_row(gkgrecordid=str(i))) for i in range(5)]
    path = tmp_path / "sample.tsv"
    path.write_text("\n".join(lines), encoding="utf-8")

    summary = run(["--server", "http://x", "--user-id", "u", "--input", str(path), "--dry-run", "--limit", "2"])
    assert summary["parsed"] == 2


def test_run_posts_and_counts_success(monkeypatch, tmp_path):
    def fake_urlopen(request, timeout=None):
        return _FakeResponse(b'{"success": true, "id": "x"}')

    monkeypatch.setattr(ingest_gkg.urllib.request, "urlopen", fake_urlopen)

    lines = ["\t".join(make_row(gkgrecordid=str(i))) for i in range(2)]
    path = tmp_path / "sample.tsv"
    path.write_text("\n".join(lines), encoding="utf-8")

    summary = run(["--server", "http://x", "--user-id", "u", "--input", str(path)])
    assert summary["posted"] == 2
    assert summary["errors"] == 0
    assert "duplicates" not in summary  # no 409 path -- the server dedups silently on Ok()


def test_run_counts_all_http_failures_as_errors_no_409_special_case(monkeypatch, tmp_path):
    # The server never constructs AppError::MemoryAlreadyExists (dead code)
    # and its content-hash dedup returns Ok(existing_id), not a 409 -- so a
    # 409, if the server ever sent one, is just another failure to report,
    # not a distinct "duplicate" outcome.
    def fake_urlopen(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, 409, "Conflict", None, None)

    monkeypatch.setattr(ingest_gkg.urllib.request, "urlopen", fake_urlopen)

    lines = ["\t".join(make_row(gkgrecordid=str(i))) for i in range(2)]
    path = tmp_path / "sample.tsv"
    path.write_text("\n".join(lines), encoding="utf-8")

    summary = run(["--server", "http://x", "--user-id", "u", "--input", str(path)])
    assert summary["posted"] == 0
    assert summary["errors"] == 2
    assert summary["error_samples"][0]["status"] == 409


def test_run_never_drops_a_malformed_row(monkeypatch, tmp_path):
    # A row with a blank V2Locations and a garbage date is still ingested --
    # only the coordinate and timestamp fields are dropped.
    good = make_row(gkgrecordid="0")
    malformed = make_row(gkgrecordid="1", v2locations="", date="not-a-date")
    blank = [""] * len(_DEFAULT_COLUMNS)

    path = tmp_path / "sample.tsv"
    path.write_text(
        "\n".join("\t".join(r) for r in (good, malformed, blank)), encoding="utf-8"
    )

    summary = run(["--server", "http://x", "--user-id", "u", "--input", str(path), "--dry-run"])
    assert summary["parsed"] == 2  # good + malformed-but-kept
    assert summary["skipped"] == 1  # only the truly blank row
    assert summary["rows_missing_location"] == 1  # malformed row's v2locations was blank
    assert summary["date_parse_failed"] == 1       # malformed row's date didn't parse


def test_run_counts_location_parse_failed_distinctly_from_missing(monkeypatch, tmp_path):
    has_garbage_location = make_row(gkgrecordid="0", v2locations="garbage#novalues")
    has_no_location = make_row(gkgrecordid="1", v2locations="")

    path = tmp_path / "sample.tsv"
    path.write_text(
        "\n".join("\t".join(r) for r in (has_garbage_location, has_no_location)),
        encoding="utf-8",
    )

    summary = run(["--server", "http://x", "--user-id", "u", "--input", str(path), "--dry-run"])
    assert summary["rows_missing_location"] == 1
    assert summary["rows_location_parse_failed"] == 1


def test_run_missing_input_file_returns_error_summary_not_traceback(tmp_path):
    missing = tmp_path / "does-not-exist.tsv"
    summary = run(["--server", "http://x", "--user-id", "u", "--input", str(missing)])
    assert "error" in summary
    assert str(missing) in summary["error"]


def test_main_exits_non_zero_and_prints_json_error_on_missing_input(tmp_path, capsys):
    missing = tmp_path / "nope.tsv"
    with pytest.raises(SystemExit) as exc_info:
        main(["--server", "http://x", "--user-id", "u", "--input", str(missing)])
    assert exc_info.value.code != 0
    printed = json.loads(capsys.readouterr().out.strip())
    assert "error" in printed


def test_main_exits_zero_on_success(monkeypatch, tmp_path, capsys):
    lines = ["\t".join(make_row(gkgrecordid="0"))]
    path = tmp_path / "sample.tsv"
    path.write_text("\n".join(lines), encoding="utf-8")

    try:
        main(["--server", "http://x", "--user-id", "u", "--input", str(path), "--dry-run"])
    except SystemExit as e:
        pytest.fail(f"main() should not exit on success, got SystemExit({e.code})")
    printed = json.loads(capsys.readouterr().out.strip())
    assert "error" not in printed
    assert printed["parsed"] == 1
