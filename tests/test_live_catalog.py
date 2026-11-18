#!/usr/bin/env python3
"""Network-free checks for catalogue freshness, failures and API pagination.

Run: python3 -m unittest discover -s samurai-dashboard/tests -p 'test_live_catalog.py'
"""
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import fetch_catalog as catalog
import serve

AS_OF = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)


def tournament(identifier=201):
    return {"id": identifier, "name": "Проверочный синхрон", "type": {"id": 3, "name": "Синхрон"},
            "dateStart": "2026-11-08T09:00:00+00:00", "dateEnd": "2026-11-15T09:00:00+00:00",
            "archive": False, "difficultyForecast": 4.5, "trueDL": None,
            "editors": [], "gotQuestionsTags": [], "questionQty": {"1": 12, "2": 12, "3": 12}}


def bundle(identifier=201):
    with patch.object(catalog, "utc_now", return_value=AS_OF):
        value = catalog.make_bundle([tournament(identifier)],
                                    [{"page": 1, "count": 1}, {"page": 2, "count": 0}], AS_OF, 90)
        value.update({"teamTournamentIds": [101], "teamHistoryCheckedAt": AS_OF.isoformat(),
                      "teamHistorySource": catalog.API + "/teams/100321/tournaments", "teamHistoryVerified": True})
        return value


class CatalogStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="samurai-catalog-test-")
        self.root = Path(self.temporary.name)
        (self.root / "data").mkdir()
        self.clock = 1000.0
        self.timer = patch.object(serve.time, "monotonic", side_effect=lambda: self.clock)
        self.timer.start()

    def tearDown(self):
        self.timer.stop()
        self.temporary.cleanup()

    def store(self, loader, cached=None):
        if cached is not None:
            (self.root / "data/catalog.json").write_text(json.dumps(cached), encoding="utf-8")
        return serve.CatalogStore(root=self.root, loader=loader)

    def test_first_request_refreshes_disk_snapshot_and_then_uses_short_cache(self):
        loader = Mock(return_value=bundle(202))
        store = self.store(loader, bundle(201))
        first = store.get()
        self.assertEqual(first["tournaments"][0]["id"], 202)
        self.assertEqual(first["_live"]["status"], "fresh")
        self.clock += serve.REFRESH_SECONDS - 1
        self.assertEqual(store.get()["_live"]["status"], "fresh")
        self.assertEqual(loader.call_count, 1)
        self.clock += 1
        store.get()
        self.assertEqual(loader.call_count, 2)

    def test_force_refresh_is_rate_limited_to_fifteen_seconds(self):
        loader = Mock(return_value=bundle())
        store = self.store(loader)
        store.get()
        self.clock += 14.99
        store.get(force=True)
        self.assertEqual(loader.call_count, 1)
        self.clock += .01
        store.get(force=True)
        self.assertEqual(loader.call_count, 2)

    def test_failed_refresh_retains_original_snapshot_and_stale_flag(self):
        original = bundle()
        loader = Mock(side_effect=RuntimeError("upstream unavailable"))
        store = self.store(loader, original)
        result = store.get()
        self.assertEqual(result["fetchedAt"], original["fetchedAt"])
        self.assertEqual(result["tournaments"], original["tournaments"])
        self.assertEqual(result["_live"]["status"], "stale")
        self.assertIn("upstream unavailable", result["_live"]["error"])
        self.clock += 1
        cached = store.get()
        self.assertEqual(cached["_live"]["status"], "stale")
        self.assertEqual(loader.call_count, 1)

    def test_success_after_failure_clears_stale_error(self):
        loader = Mock(side_effect=[RuntimeError("temporary outage"), bundle(202)])
        store = self.store(loader, bundle(201))
        self.assertEqual(store.get()["_live"]["status"], "stale")
        self.clock += 15
        recovered = store.get(force=True)
        self.assertEqual(recovered["_live"]["status"], "fresh")
        self.assertIsNone(recovered["_live"]["error"])
        self.assertEqual(recovered["tournaments"][0]["id"], 202)

    def test_no_snapshot_and_network_failure_is_unavailable(self):
        store = self.store(Mock(side_effect=RuntimeError("offline")))
        result = store.get()
        self.assertIs(result["complete"], False)
        self.assertEqual(result["tournaments"], [])
        self.assertEqual(result["_live"]["status"], "unavailable")

    def test_concurrent_request_gets_refreshing_snapshot_without_duplicate_fetch(self):
        started = threading.Event()
        release = threading.Event()

        def loading():
            started.set()
            if not release.wait(3):
                raise AssertionError("Test did not release mock loader")
            return bundle(202)

        loader = Mock(side_effect=loading)
        store = self.store(loader, bundle(201))
        returned = []
        worker = threading.Thread(target=lambda: returned.append(store.get()))
        worker.start()
        try:
            self.assertTrue(started.wait(2))
            during = store.get()
            self.assertEqual(during["_live"]["status"], "refreshing")
            self.assertEqual(during["tournaments"][0]["id"], 201)
            self.assertEqual(loader.call_count, 1)
        finally:
            release.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(returned[0]["_live"]["status"], "fresh")

    def test_partial_refresh_does_not_replace_complete_snapshot(self):
        partial = bundle(202)
        partial["complete"] = False
        store = self.store(Mock(return_value=partial), bundle(201))
        result = store.get()
        self.assertEqual(result["tournaments"][0]["id"], 201)
        self.assertEqual(result["_live"]["status"], "stale")

    def test_malformed_success_is_rejected_instead_of_marked_fresh(self):
        malformed = [{"complete": True}, {"complete": True, "tournaments": "wrong shape"},
                     {"complete": True, "tournaments": [None]},
                     {"complete": "yes", "tournaments": []}]
        for value in malformed:
            with self.subTest(value=value):
                store = self.store(Mock(return_value=value), bundle(201))
                result = store.get()
                self.assertEqual(result["tournaments"][0]["id"], 201)
                self.assertEqual(result["_live"]["status"], "stale")

    def test_malformed_disk_cache_cannot_crash_fallback_or_claim_success(self):
        malformed = ["invalid cache", 42, {"complete": True},
                     {"complete": True, "tournaments": "bad"}]
        for value in malformed:
            with self.subTest(value=value):
                store = self.store(Mock(side_effect=RuntimeError("offline")), value)
                result = store.get()
                self.assertIs(result["complete"], False)
                self.assertEqual(result["tournaments"], [])
                self.assertEqual(result["_live"]["status"], "unavailable")


class FetchCatalogTests(unittest.TestCase):
    def setUp(self):
        self.network = patch.object(catalog, "urlopen", side_effect=AssertionError("Real network forbidden in tests"))
        self.network.start()

    def tearDown(self):
        self.network.stop()

    def test_all_pages_followed_even_after_short_page_and_long_async_is_retained(self):
        long_async = tournament(201)
        long_async["dateStart"] = "2025-01-01T00:00:00+00:00"
        pages = [([long_async, tournament(202)], {"Date": "Mon, 09 Nov 2026 12:00:00 GMT"}),
                 ([tournament(203)], {}), ([], {}),
                 ([{"idteam": 100321, "idtournament": 202}, {"idteam": 100321, "idtournament": 202}], {})]
        with patch.object(catalog, "read_json", side_effect=pages) as read, patch.object(catalog, "utc_now", return_value=AS_OF):
            result = catalog.fetch_catalog(now=AS_OF, horizon_days=90)
        self.assertEqual(read.call_count, 4)
        self.assertTrue(result["complete"])
        self.assertTrue(result["pagination"]["terminalEmptyPage"])
        self.assertEqual(result["pagination"]["receivedRows"], 3)
        self.assertEqual(result["pagination"]["uniqueTournaments"], 3)
        self.assertEqual([t["id"] for t in result["tournaments"]], [201, 202, 203])
        self.assertEqual(result["teamTournamentIds"], [202])
        self.assertIs(result["teamHistoryVerified"], True)
        self.assertEqual(result["teamHistoryCheckedAt"], "2026-11-09T12:00:00+00:00")
        self.assertEqual(read.call_args_list[-1].args[0], catalog.API + "/teams/100321/tournaments")
        for index, call in enumerate(read.call_args_list[:-1], 1):
            query = parse_qs(urlsplit(call.args[0]).query)
            self.assertEqual(query["page"], [str(index)])
            self.assertEqual(query["itemsPerPage"], ["512"])
            self.assertEqual(query["dateEnd[after]"], ["2026-11-09"])
            self.assertEqual(query["dateStart[before]"], ["2027-02-07"])
            self.assertNotIn("dateStart[after]", query)

    def test_empty_source_catalogue_has_positive_pagination_evidence(self):
        with patch.object(catalog, "read_json", return_value=([], {})):
            result = catalog.fetch_catalog(now=AS_OF)
        self.assertIs(result["complete"], True)
        self.assertEqual(result["tournaments"], [])
        self.assertEqual(result["pagination"]["pages"][0]["count"], 0)
        self.assertIs(result["pagination"]["terminalEmptyPage"], True)

    def test_repeated_page_is_not_silently_treated_as_complete(self):
        with patch.object(catalog, "read_json", side_effect=[([tournament()], {}), ([tournament()], {})]):
            with self.assertRaisesRegex(RuntimeError, "Pagination did not advance"):
                catalog.fetch_catalog(now=AS_OF)

    def test_failed_later_page_does_not_overwrite_saved_snapshot(self):
        with tempfile.TemporaryDirectory(prefix="samurai-catalog-fetch-test-") as temporary:
            root = Path(temporary)
            catalog.save_catalog(bundle(), root=root)
            before_json = (root / "data/catalog.json").read_bytes()
            before_js = (root / "catalog-data.js").read_bytes()
            with patch.object(catalog, "read_json", side_effect=[([tournament(202)], {}), RuntimeError("page 2 failed")]):
                with self.assertRaisesRegex(RuntimeError, "page 2 failed"):
                    catalog.refresh_catalog(root=root, now=AS_OF)
            self.assertEqual((root / "data/catalog.json").read_bytes(), before_json)
            self.assertEqual((root / "catalog-data.js").read_bytes(), before_js)

    def test_failed_team_history_does_not_overwrite_complete_snapshot(self):
        with tempfile.TemporaryDirectory(prefix="samurai-catalog-history-test-") as temporary:
            root = Path(temporary)
            catalog.save_catalog(bundle(), root=root)
            before = (root / "data/catalog.json").read_bytes()
            with patch.object(catalog, "read_json", side_effect=[([tournament(202)], {}), ([], {}), RuntimeError("team history failed")]):
                with self.assertRaisesRegex(RuntimeError, "team history failed"):
                    catalog.refresh_catalog(root=root, now=AS_OF)
            self.assertEqual((root / "data/catalog.json").read_bytes(), before)

    def test_malformed_or_wrong_team_history_cannot_mark_live_exclusions_verified(self):
        for history in ([{"idtournament": "wrong"}], [{"idtournament": 303, "idteam": 999}], [None]):
            with self.subTest(history=history):
                with patch.object(catalog, "read_json", side_effect=[([tournament()], {}), ([], {}), (history, {})]):
                    with self.assertRaisesRegex(ValueError, "team tournament history"):
                        catalog.fetch_catalog(now=AS_OF)

    def test_normalizer_preserves_nested_windows_top_level_false_and_source_scales(self):
        raw = tournament()
        raw.update({"archive": False, "hideResultsTo": "2026-11-16T20:00:00+00:00",
                    "difficultyForecast": 4.5, "trueDL": 3.8, "gotQuestionsTags": [13123],
                    "editors": [{"id": 7, "name": "Анна", "patronymic": "Ивановна", "surname": "Петрова", "gotQuestionsTag": 51}],
                    "paymentCategories": [{"amount": 100, "currency": "RUB", "surcharge": True}],
                    "synchData": {"archive": True, "dateRequestsAllowedTo": "2026-11-15T08:00:00+00:00",
                                  "hideResultsTo": "2026-12-01T20:00:00+00:00"},
                    "questions": ["Must not enter the metadata catalogue"], "answers": ["Hidden"]})
        value = catalog.normalize_tournament(raw)
        self.assertIs(value["archive"], False)
        self.assertEqual(value["dateRequestsAllowedTo"], "2026-11-15T08:00:00+00:00")
        self.assertEqual(value["hideResultsTo"], "2026-11-16T20:00:00+00:00")
        self.assertEqual(value["difficultyForecast"], 4.5)
        self.assertEqual(value["trueDL"], 3.8)
        self.assertEqual(value["gotQuestionsTags"], [13123])
        self.assertEqual(value["editors"], [{"id": 7, "name": "Анна Петрова", "gotQuestionsTag": 51}])
        self.assertTrue(value["paymentCategories"][0]["surcharge"])
        self.assertEqual(value["cancellationStatus"], "not-provided-by-api")
        self.assertNotIn("questions", value)
        self.assertNotIn("answers", value)

    def test_malformed_api_row_does_not_become_complete_catalogue(self):
        with patch.object(catalog, "read_json", side_effect=[([{"id": "wrong type"}], {}), ([], {})]):
            with self.assertRaises(ValueError):
                catalog.fetch_catalog(now=AS_OF)

    def test_json_error_object_with_http_success_is_rejected(self):
        response = io.BytesIO(b'{"error":"unexpected source response"}')
        response.headers = {}
        with patch.object(catalog, "urlopen", return_value=response) as opening:
            with self.assertRaisesRegex(RuntimeError, "JSON array"):
                catalog.read_json("https://api.rating.chgk.info/tournaments", attempts=1)
        self.assertEqual(opening.call_count, 1)

    def test_auth_denial_does_not_trigger_retries(self):
        error = HTTPError("https://api.rating.chgk.info/tournaments", 403, "Forbidden", {}, None)
        with patch.object(catalog, "urlopen", side_effect=error) as opening:
            with self.assertRaises(RuntimeError):
                catalog.read_json("https://api.rating.chgk.info/tournaments")
        self.assertEqual(opening.call_count, 1)

    def test_browser_snapshot_escapes_closing_script(self):
        value = bundle()
        value["tournaments"][0]["name"] = "</script><script>bad()</script>"
        with tempfile.TemporaryDirectory(prefix="samurai-catalog-save-test-") as temporary:
            root = Path(temporary)
            catalog.save_catalog(value, root=root)
            script = (root / "catalog-data.js").read_text(encoding="utf-8")
            self.assertNotIn("</script>", script)
            restored = json.loads(script.removeprefix("window.SAMURAI_CATALOG=").strip().removesuffix(";"))
            self.assertEqual(restored, value)


if __name__ == "__main__":
    unittest.main()
