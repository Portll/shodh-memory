"""Unit tests for run_eval.py -- pure scoring/aggregation logic first, then
stubbed-HTTP orchestration. Never touches a live server (monkeypatches
urllib.request.urlopen), matching scripts/gdelt/test_ingest_gkg.py's pattern.
"""
import json
from datetime import datetime, timezone

import pytest

import run_eval
from run_eval import (
    aggregate,
    build_recall_payload,
    evaluate_query,
    filter_by_window,
    main,
    parse_iso8601,
    run,
)


def _mem(id_, created_at):
    return {"id": id_, "experience": {"content": "c"}, "created_at": created_at, "score": 1.0}


# =============================================================================
# parse_iso8601 (duplicated pure helper -- must handle the same shapes as
# build_queries.parse_iso8601, since both consume RecallMemory.created_at,
# which is chrono's to_rfc3339())
# =============================================================================
def test_parse_iso8601_handles_z_and_nanosecond_offset_forms():
    assert parse_iso8601("2020-01-01T00:00:00Z") == datetime(2020, 1, 1, tzinfo=timezone.utc)
    dt = parse_iso8601("2020-01-01T00:00:00.123456789+00:00")
    assert dt.microsecond == 123456


# =============================================================================
# filter_by_window
# =============================================================================
def test_filter_by_window_keeps_only_in_window_preserving_order():
    memories = [
        _mem("a", "2020-01-05T00:00:00Z"),
        _mem("b", "2019-01-01T00:00:00Z"),
        _mem("c", "2020-01-06T00:00:00Z"),
    ]
    start = parse_iso8601("2020-01-01T00:00:00Z")
    end = parse_iso8601("2020-01-10T00:00:00Z")
    filtered = filter_by_window(memories, start, end)
    assert [m["id"] for m in filtered] == ["a", "c"]


def test_filter_by_window_no_bounds_returns_all():
    memories = [_mem("a", "2020-01-05T00:00:00Z")]
    assert filter_by_window(memories, None, None) == memories


def test_filter_by_window_excludes_unparseable_timestamp_conservatively():
    memories = [_mem("a", "not-a-date"), _mem("b", "2020-01-05T00:00:00Z")]
    start = parse_iso8601("2020-01-01T00:00:00Z")
    end = parse_iso8601("2020-01-10T00:00:00Z")
    filtered = filter_by_window(memories, start, end)
    assert [m["id"] for m in filtered] == ["b"]


def test_filter_by_window_boundary_inclusive():
    start = parse_iso8601("2020-01-01T00:00:00Z")
    end = parse_iso8601("2020-01-10T00:00:00Z")
    memories = [_mem("edge-start", "2020-01-01T00:00:00Z"), _mem("edge-end", "2020-01-10T00:00:00Z")]
    filtered = filter_by_window(memories, start, end)
    assert {m["id"] for m in filtered} == {"edge-start", "edge-end"}


def test_filter_by_window_end_exclusive_drops_the_end_instant():
    # Mirrors build_queries.py's precedence family, which computes gold
    # with end_inclusive=False (the anchor's own instant is not "before"
    # it). The runner's filter must honor the SAME inclusivity the gold
    # was computed with, or a record the builder correctly excluded from
    # gold could still count as "retrieved-in-window" here.
    start = parse_iso8601("2020-01-01T00:00:00Z")
    end = parse_iso8601("2020-01-10T00:00:00Z")
    memories = [_mem("edge-start", "2020-01-01T00:00:00Z"), _mem("edge-end", "2020-01-10T00:00:00Z")]
    filtered = filter_by_window(memories, start, end, end_inclusive=False)
    assert [m["id"] for m in filtered] == ["edge-start"]


# =============================================================================
# build_recall_payload
# =============================================================================
def test_build_recall_payload_shape():
    query = {
        "qid": "rw_0001", "family": "radius_window", "text": "what happened",
        "geo": {"lat": 1.0, "lon": 2.0, "radius_m": 3.0},
        "window": {"start": "2020-01-01T00:00:00Z", "end": "2020-01-02T00:00:00Z"},
        "gold_ids": ["a"], "expect_empty": False,
    }
    payload = build_recall_payload(query, "gdelt-user", limit=10)
    assert payload == {
        "user_id": "gdelt-user",
        "query": "what happened",
        "mode": "hybrid",
        "geo_lat": 1.0,
        "geo_lon": 2.0,
        "geo_radius_meters": 3.0,
        "limit": 10,
    }


# =============================================================================
# evaluate_query -- stubbed HTTP, scoring logic
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


def _stub_recall(monkeypatch, responses_by_limit):
    def fake_urlopen(request, timeout=None):
        body = json.loads(request.data.decode("utf-8"))
        limit = body["limit"]
        return _FakeResponse(json.dumps(responses_by_limit[limit]).encode("utf-8"))

    monkeypatch.setattr(run_eval.urllib.request, "urlopen", fake_urlopen)


def test_evaluate_query_radius_window_scores_recall_against_gold(monkeypatch):
    query = {
        "qid": "rw_0001", "family": "radius_window", "text": "q",
        "geo": {"lat": 1.0, "lon": 2.0, "radius_m": 100.0},
        "window": {"start": "2020-01-01T00:00:00Z", "end": "2020-01-31T00:00:00Z"},
        "gold_ids": ["a", "b", "c"], "expect_empty": False,
    }
    primary_response = {"memories": [_mem("a", "2020-01-05T00:00:00Z"), _mem("b", "2020-01-06T00:00:00Z")]}
    diag_response = {"memories": [_mem("a", "2020-01-05T00:00:00Z"), _mem("b", "2020-01-06T00:00:00Z"), _mem("c", "2020-01-07T00:00:00Z")]}
    _stub_recall(monkeypatch, {10: primary_response, 50: diag_response})

    result = evaluate_query("http://x", query, "u")
    assert result["family"] == "radius_window"
    assert result["gold_count"] == 3
    assert result["hits_primary"] == 2
    assert result["recall_at_10"] == pytest.approx(2 / 3)
    assert result["precision_at_10"] == pytest.approx(2 / 10)  # 2 hits out of the fixed 10-slot limit
    assert result["hits_diagnostic"] == 3
    assert result["recall_at_10_diagnostic_limit50"] == pytest.approx(1.0)


def test_evaluate_query_honors_window_end_inclusive_flag(monkeypatch):
    # A precedence-shaped query: window.end_inclusive=False must be
    # threaded through to filter_by_window so a same-instant result isn't
    # counted as retrieved-in-window even though it's not gold either way.
    query = {
        "qid": "pr_0001", "family": "precedence", "text": "q",
        "geo": {"lat": 1.0, "lon": 2.0, "radius_m": 100.0},
        "window": {"start": "2020-01-01T00:00:00Z", "end": "2020-01-10T00:00:00Z", "end_inclusive": False},
        "gold_ids": ["before"], "expect_empty": False,
    }
    # Server returns the true gold hit plus a same-instant-as-end record
    # that a naive inclusive filter would also keep (harmless for scoring
    # here since it isn't gold either, but exercising the plumbing).
    response = {"memories": [_mem("before", "2020-01-05T00:00:00Z"), _mem("same-instant", "2020-01-10T00:00:00Z")]}
    _stub_recall(monkeypatch, {10: response, 50: response})

    result = evaluate_query("http://x", query, "u")
    assert result["retrieved_count_primary"] == 1  # same-instant excluded
    assert result["hits_primary"] == 1
    assert result["recall_at_10"] == pytest.approx(1.0)


# =============================================================================
# expect_empty as scoring source of truth -- must agree with family
# =============================================================================
def test_evaluate_query_rejects_negative_family_with_expect_empty_false():
    query = {
        "qid": "neg_bad", "family": "negative", "text": "q",
        "geo": {"lat": 1.0, "lon": 2.0, "radius_m": 100.0}, "window": None,
        "gold_ids": [], "expect_empty": False,
    }
    with pytest.raises(ValueError, match="inconsistent"):
        evaluate_query("http://x", query, "u")


def test_evaluate_query_rejects_positive_family_with_expect_empty_true():
    query = {
        "qid": "rw_bad", "family": "radius_window", "text": "q",
        "geo": {"lat": 1.0, "lon": 2.0, "radius_m": 100.0}, "window": None,
        "gold_ids": ["a"], "expect_empty": True,
    }
    with pytest.raises(ValueError, match="inconsistent"):
        evaluate_query("http://x", query, "u")


def test_evaluate_query_consistency_check_raises_before_any_http_call(monkeypatch):
    # The check must fail closed BEFORE spending an HTTP call on a query
    # whose scoring path is already known to be undecidable.
    def fail_urlopen(*a, **k):
        raise AssertionError("must not call recall for an inconsistent query")

    monkeypatch.setattr(run_eval.urllib.request, "urlopen", fail_urlopen)
    query = {
        "qid": "neg_bad", "family": "negative", "text": "q",
        "geo": {"lat": 1.0, "lon": 2.0, "radius_m": 100.0}, "window": None,
        "gold_ids": [], "expect_empty": False,
    }
    with pytest.raises(ValueError):
        evaluate_query("http://x", query, "u")


def test_evaluate_query_applies_window_filter_before_scoring(monkeypatch):
    query = {
        "qid": "rw_0002", "family": "radius_window", "text": "q",
        "geo": {"lat": 1.0, "lon": 2.0, "radius_m": 100.0},
        "window": {"start": "2020-01-01T00:00:00Z", "end": "2020-01-31T00:00:00Z"},
        "gold_ids": ["a"], "expect_empty": False,
    }
    # Server returns a gold hit but OUTSIDE the window -- must not count.
    primary_response = {"memories": [_mem("a", "2019-06-01T00:00:00Z")]}
    diag_response = {"memories": [_mem("a", "2019-06-01T00:00:00Z")]}
    _stub_recall(monkeypatch, {10: primary_response, 50: diag_response})

    result = evaluate_query("http://x", query, "u")
    assert result["hits_primary"] == 0
    assert result["recall_at_10"] == 0.0


def test_evaluate_query_negative_family_passes_on_empty_response(monkeypatch):
    query = {
        "qid": "neg_0001", "family": "negative", "text": "q",
        "geo": {"lat": 80.0, "lon": 2.0, "radius_m": 100.0},
        "window": {"start": "2020-01-01T00:00:00Z", "end": "2020-01-31T00:00:00Z"},
        "gold_ids": [], "expect_empty": True,
    }

    def fake_urlopen(request, timeout=None):
        return _FakeResponse(json.dumps({"memories": []}).encode("utf-8"))

    monkeypatch.setattr(run_eval.urllib.request, "urlopen", fake_urlopen)

    result = evaluate_query("http://x", query, "u")
    assert result["family"] == "negative"
    assert result["passed"] is True
    assert result["raw_retrieved_count"] == 0


def test_evaluate_query_negative_family_fails_on_leaked_result(monkeypatch):
    query = {
        "qid": "neg_0001", "family": "negative", "text": "q",
        "geo": {"lat": 80.0, "lon": 2.0, "radius_m": 100.0},
        "window": {"start": "2020-01-01T00:00:00Z", "end": "2020-01-31T00:00:00Z"},
        "gold_ids": [], "expect_empty": True,
    }

    def fake_urlopen(request, timeout=None):
        return _FakeResponse(json.dumps({"memories": [_mem("leaked", "2020-01-01T00:00:00Z")]}).encode("utf-8"))

    monkeypatch.setattr(run_eval.urllib.request, "urlopen", fake_urlopen)

    result = evaluate_query("http://x", query, "u")
    assert result["passed"] is False
    assert result["raw_retrieved_count"] == 1


def test_evaluate_query_negative_family_only_makes_one_http_call(monkeypatch):
    query = {
        "qid": "neg_0001", "family": "negative", "text": "q",
        "geo": {"lat": 80.0, "lon": 2.0, "radius_m": 100.0}, "window": None,
        "gold_ids": [], "expect_empty": True,
    }
    calls = []

    def fake_urlopen(request, timeout=None):
        calls.append(request)
        return _FakeResponse(json.dumps({"memories": []}).encode("utf-8"))

    monkeypatch.setattr(run_eval.urllib.request, "urlopen", fake_urlopen)
    evaluate_query("http://x", query, "u")
    assert len(calls) == 1


def test_evaluate_query_zero_gold_is_not_a_divide_by_zero_and_is_unmeasurable(monkeypatch):
    # Defensive: a malformed/degenerate radius_window query with empty gold
    # should not crash the runner, and must not be scored as a 0.0 miss --
    # there is nothing to have hit or missed. `None` signals "excluded from
    # averaging" to aggregate(), rather than silently depressing the mean.
    query = {
        "qid": "rw_weird", "family": "radius_window", "text": "q",
        "geo": {"lat": 1.0, "lon": 2.0, "radius_m": 100.0}, "window": None,
        "gold_ids": [], "expect_empty": False,
    }

    def fake_urlopen(request, timeout=None):
        return _FakeResponse(b'{"memories": []}')

    monkeypatch.setattr(run_eval.urllib.request, "urlopen", fake_urlopen)
    result = evaluate_query("http://x", query, "u")
    assert result["recall_at_10"] is None
    assert result["recall_at_10_diagnostic_limit50"] is None


# =============================================================================
# aggregate
# =============================================================================
def test_aggregate_computes_macro_average_recall_and_negative_pass_rate():
    results = [
        {"qid": "rw_0001", "family": "radius_window", "gold_count": 2, "retrieved_count_primary": 2,
         "hits_primary": 2, "recall_at_10": 1.0, "precision_at_10": 0.2,
         "retrieved_count_diagnostic": 2, "hits_diagnostic": 2, "recall_at_10_diagnostic_limit50": 1.0},
        {"qid": "pr_0001", "family": "precedence", "gold_count": 2, "retrieved_count_primary": 1,
         "hits_primary": 1, "recall_at_10": 0.5, "precision_at_10": 0.1,
         "retrieved_count_diagnostic": 2, "hits_diagnostic": 2, "recall_at_10_diagnostic_limit50": 1.0},
        {"qid": "neg_0001", "family": "negative", "raw_retrieved_count": 0, "passed": True},
        {"qid": "neg_0002", "family": "negative", "raw_retrieved_count": 1, "passed": False},
    ]
    summary = aggregate(results)
    assert summary["recall_at_10"] == pytest.approx(0.75)
    assert summary["precision_at_10"] == pytest.approx(0.15)
    assert summary["negative_pass_rate"] == pytest.approx(0.5)
    assert summary["per_family"]["radius_window"]["recall_at_10"] == pytest.approx(1.0)
    assert summary["per_family"]["precedence"]["recall_at_10"] == pytest.approx(0.5)
    assert summary["per_family"]["negative"]["negative_pass_rate"] == pytest.approx(0.5)
    assert summary["gold_count_distribution"] == {"min": 2, "max": 2, "mean": pytest.approx(2.0)}
    assert summary["n_queries"] == 4


def test_aggregate_excludes_none_recall_from_average_and_counts_it():
    results = [
        {"qid": "rw_0001", "family": "radius_window", "gold_count": 2, "retrieved_count_primary": 2,
         "hits_primary": 2, "recall_at_10": 1.0, "precision_at_10": 0.2,
         "retrieved_count_diagnostic": 2, "hits_diagnostic": 2, "recall_at_10_diagnostic_limit50": 1.0},
        {"qid": "rw_weird", "family": "radius_window", "gold_count": 0, "retrieved_count_primary": 0,
         "hits_primary": 0, "recall_at_10": None, "precision_at_10": 0.0,
         "retrieved_count_diagnostic": 0, "hits_diagnostic": 0, "recall_at_10_diagnostic_limit50": None},
    ]
    summary = aggregate(results)
    # The None-gold query must not drag the average toward 0 -- only the
    # single measurable query (recall 1.0) contributes.
    assert summary["recall_at_10"] == pytest.approx(1.0)
    assert summary["skipped_no_gold"] == 1
    assert summary["per_family"]["radius_window"]["recall_at_10"] == pytest.approx(1.0)
    # The None-gold query is also excluded from gold_count_distribution --
    # gold_count=0 there is a "not measured" marker, not a real data point.
    assert summary["gold_count_distribution"] == {"min": 2, "max": 2, "mean": pytest.approx(2.0)}


def test_aggregate_gold_count_distribution_none_when_no_positive_queries():
    results = [{"qid": "neg_0001", "family": "negative", "raw_retrieved_count": 0, "passed": True}]
    summary = aggregate(results)
    assert summary["gold_count_distribution"] is None


def test_aggregate_no_negative_queries_leaves_negative_pass_rate_none():
    results = [
        {"qid": "rw_0001", "family": "radius_window", "gold_count": 1, "retrieved_count_primary": 1,
         "hits_primary": 1, "recall_at_10": 1.0, "precision_at_10": 0.1,
         "retrieved_count_diagnostic": 1, "hits_diagnostic": 1, "recall_at_10_diagnostic_limit50": 1.0},
    ]
    summary = aggregate(results)
    assert summary["negative_pass_rate"] is None


# =============================================================================
# run() / main() -- end-to-end, hard-fail gate
# =============================================================================
def _write_queries(path, queries):
    with open(path, "w", encoding="utf-8") as fh:
        for q in queries:
            fh.write(json.dumps(q) + "\n")


def test_run_reads_queries_jsonl_and_scores(monkeypatch, tmp_path):
    queries_path = tmp_path / "queries.jsonl"
    _write_queries(queries_path, [
        {"qid": "rw_0001", "family": "radius_window", "text": "q",
         "geo": {"lat": 1.0, "lon": 2.0, "radius_m": 100.0},
         "window": {"start": "2020-01-01T00:00:00Z", "end": "2020-01-31T00:00:00Z"},
         "gold_ids": ["a"], "expect_empty": False},
        {"qid": "neg_0001", "family": "negative", "text": "q",
         "geo": {"lat": 80.0, "lon": 2.0, "radius_m": 100.0}, "window": None,
         "gold_ids": [], "expect_empty": True},
    ])

    def fake_urlopen(request, timeout=None):
        body = json.loads(request.data.decode("utf-8"))
        if body["geo_lat"] == 80.0:
            return _FakeResponse(json.dumps({"memories": []}).encode("utf-8"))
        return _FakeResponse(json.dumps({"memories": [_mem("a", "2020-01-05T00:00:00Z")]}).encode("utf-8"))

    monkeypatch.setattr(run_eval.urllib.request, "urlopen", fake_urlopen)

    summary = run(["--server", "http://x", "--user-id", "u", "--queries", str(queries_path)])
    assert summary["negative_pass_rate"] == 1.0
    assert summary["recall_at_10"] == 1.0


def test_run_missing_queries_file_returns_error(tmp_path):
    summary = run(["--server", "http://x", "--user-id", "u", "--queries", str(tmp_path / "nope.jsonl")])
    assert "error" in summary


def test_run_surfaces_expect_empty_family_inconsistency_as_clean_error(monkeypatch, tmp_path):
    queries_path = tmp_path / "queries.jsonl"
    _write_queries(queries_path, [
        {"qid": "neg_bad", "family": "negative", "text": "q",
         "geo": {"lat": 1.0, "lon": 2.0, "radius_m": 100.0}, "window": None,
         "gold_ids": [], "expect_empty": False},
    ])

    def fail_urlopen(*a, **k):
        raise AssertionError("must not call recall for an inconsistent query")

    monkeypatch.setattr(run_eval.urllib.request, "urlopen", fail_urlopen)

    summary = run(["--server", "http://x", "--user-id", "u", "--queries", str(queries_path)])
    assert "error" in summary
    assert "neg_bad" in summary["error"]


def test_main_exits_nonzero_when_negative_pass_rate_below_one(monkeypatch, tmp_path, capsys):
    queries_path = tmp_path / "queries.jsonl"
    _write_queries(queries_path, [
        {"qid": "neg_0001", "family": "negative", "text": "q",
         "geo": {"lat": 80.0, "lon": 2.0, "radius_m": 100.0}, "window": None,
         "gold_ids": [], "expect_empty": True},
    ])

    def fake_urlopen(request, timeout=None):
        return _FakeResponse(json.dumps({"memories": [_mem("leaked", "2020-01-01T00:00:00Z")]}).encode("utf-8"))

    monkeypatch.setattr(run_eval.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(SystemExit) as exc_info:
        main(["--server", "http://x", "--user-id", "u", "--queries", str(queries_path)])
    assert exc_info.value.code != 0
    printed = json.loads(capsys.readouterr().out.strip())
    assert printed["negative_pass_rate"] == 0.0


def test_main_exits_nonzero_when_there_are_zero_negative_controls(monkeypatch, tmp_path, capsys):
    # CRITICAL regression: a queries.jsonl with no negative-control rows at
    # all must NOT exit 0. negative_pass_rate is None in that case (see
    # aggregate()), and a run that performed no leakage validation is a
    # FAILED run, not a vacuous pass -- `None or < 1.0` must both fail
    # main(), not just the numeric branch.
    queries_path = tmp_path / "queries.jsonl"
    _write_queries(queries_path, [
        {"qid": "rw_0001", "family": "radius_window", "text": "q",
         "geo": {"lat": 1.0, "lon": 2.0, "radius_m": 100.0},
         "window": {"start": "2020-01-01T00:00:00Z", "end": "2020-01-31T00:00:00Z", "end_inclusive": True},
         "gold_ids": ["a"], "expect_empty": False},
    ])

    def fake_urlopen(request, timeout=None):
        return _FakeResponse(json.dumps({"memories": [_mem("a", "2020-01-05T00:00:00Z")]}).encode("utf-8"))

    monkeypatch.setattr(run_eval.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(SystemExit) as exc_info:
        main(["--server", "http://x", "--user-id", "u", "--queries", str(queries_path)])
    assert exc_info.value.code != 0
    printed = json.loads(capsys.readouterr().out.strip())
    assert printed["negative_pass_rate"] is None
    assert printed["recall_at_10"] == 1.0  # positive-family scoring is otherwise unaffected


def test_main_exits_zero_when_all_negatives_pass(monkeypatch, tmp_path, capsys):
    queries_path = tmp_path / "queries.jsonl"
    _write_queries(queries_path, [
        {"qid": "neg_0001", "family": "negative", "text": "q",
         "geo": {"lat": 80.0, "lon": 2.0, "radius_m": 100.0}, "window": None,
         "gold_ids": [], "expect_empty": True},
    ])

    def fake_urlopen(request, timeout=None):
        return _FakeResponse(json.dumps({"memories": []}).encode("utf-8"))

    monkeypatch.setattr(run_eval.urllib.request, "urlopen", fake_urlopen)

    try:
        main(["--server", "http://x", "--user-id", "u", "--queries", str(queries_path)])
    except SystemExit as e:
        pytest.fail(f"main() should not exit on all-pass negatives, got SystemExit({e.code})")
    printed = json.loads(capsys.readouterr().out.strip())
    assert printed["negative_pass_rate"] == 1.0
