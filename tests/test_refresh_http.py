"""Freshness, transfer compression and isolated-run cache reuse regression checks."""
import copy
import gzip
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import refresh_http as H
import fetch_training_year as F
import fetch_team_difficulty as D
import fetch_played_questions as P
from test_training_year import fixture_pack, store


def response(body, headers=None):
    value = io.BytesIO(body)
    value.headers = headers or {}
    value.status = 200
    return value


class RefreshHTTPTests(unittest.TestCase):
    def test_gzip_decodes_and_bounds_decoded_size(self):
        source = "Текст".encode() * 1000
        self.assertEqual(H.read_payload(response(gzip.compress(source), {"Content-Encoding": "gzip"}), len(source)), source)
        with self.assertRaisesRegex(ValueError, "size limit"):
            H.read_payload(response(gzip.compress(source), {"Content-Encoding": "gzip"}), len(source) - 1)

    def test_wire_size_and_cached_header_values_are_bounded(self):
        with self.assertRaisesRegex(ValueError, "transfer size limit"):
            H.read_payload(response(b"a" * 21), 20)
        self.assertNotIn("If-None-Match", H.conditional_headers({"httpValidators": {"ETag": "value\r\nInjected: header"}}))

    def test_304_requires_a_verified_cache_and_sent_validator(self):
        for cached in (None, {}, {"httpValidators": {}}):
            request = Request("https://gotquestions.online/pack/1")
            error = HTTPError(request.full_url, 304, "not modified", {}, io.BytesIO(b""))
            with self.assertRaisesRegex(ValueError, "Unsolicited"):
                H.refresh_payload(request, cached, Mock(side_effect=error))
            self.assertTrue(error.fp.closed)

    def test_fresh_conditional_response_preserves_body_age_and_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); cached = store(root, fixture_pack())
            cached["httpValidators"] = {"ETag": '"pack-v1"'}
            F.write_json(F.cache_path(root, 1), cached)
            error = HTTPError(cached["sourceUrl"], 304, "not modified", {"ETag": '"pack-v1"'}, io.BytesIO())
            opener = Mock(side_effect=error)
            actual = F.fetch_one(root, {"id": 1, "questionCount": 1}, F.Pacer(0), refresh=True, opener=opener)
            request = opener.call_args.args[0]
            self.assertEqual(request.get_header("If-none-match"), '"pack-v1"')
            self.assertEqual(actual["fetchedAt"], cached["fetchedAt"])
            self.assertEqual(actual["packSha256"], cached["packSha256"])
            self.assertEqual(actual["pack"], cached["pack"])
            self.assertGreater(actual["checkedAt"], cached["fetchedAt"])
            self.assertEqual(actual["lastHttpStatus"], 304)

    def test_tampered_cache_cannot_be_revalidated_with_304(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); cached = store(root, fixture_pack())
            cached["pack"]["title"] = "tampered"; cached["httpValidators"] = {"ETag": '"v1"'}
            F.write_json(F.cache_path(root, 1), cached)
            opener = Mock(side_effect=HTTPError(cached["sourceUrl"], 304, "not modified", {}, None))
            with self.assertRaisesRegex(ValueError, "Unsolicited"):
                F.fetch_one(root, {"id": 1, "questionCount": 1}, F.Pacer(0), refresh=True, opener=opener)
            self.assertIsNone(opener.call_args.args[0].get_header("If-none-match"))

    def test_rate_limit_survives_to_next_pacer_without_touching_saved_pack(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); store(root, fixture_pack())
            path = F.cache_path(root, 1); before = path.read_bytes()
            error = HTTPError("https://gotquestions.online/pack/1", 429, "limited", {"Retry-After": "120"}, None)
            opener = Mock(side_effect=error)
            with self.assertRaises(HTTPError):
                F.fetch_one(root, {"id": 1, "questionCount": 1}, F.Pacer(0, root=root), refresh=True, opener=opener)
            never = Mock(side_effect=AssertionError("network should honor cooldown"))
            with self.assertRaisesRegex(RuntimeError, "cooldown"):
                F.fetch_one(root, {"id": 1, "questionCount": 1}, F.Pacer(0, root=root), refresh=True, opener=never)
            never.assert_not_called()
            self.assertEqual(path.read_bytes(), before)

    def test_same_second_or_future_cache_from_another_run_is_not_reused(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".refresh-context.json").write_text(json.dumps({"runId": "b" * 32, "startedAt": "2026-11-17T00:00:00+00:00"}))
            cached = store(root, fixture_pack()); cached.update(checkedAt="2099-01-01T00:00:00+00:00", refreshRunId="a" * 32)
            F.write_json(F.cache_path(root, 1), cached)
            never = Mock(side_effect=OSError("fresh GET required"))
            with patch.object(P, "urlopen", never), self.assertRaisesRegex(OSError, "fresh GET"):
                P.get_pack(root, 1, True, "2026-11-17T00:00:00+00:00", F.Pacer(0))
            never.assert_called_once()

    def test_rating_metadata_receipt_and_run_identity_both_required(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root / "data/raw").mkdir(parents=True)
            stamp = "2026-11-17T00:00:00+00:00"
            (root / ".refresh-context.json").write_text(json.dumps({"runId": "b" * 32, "startedAt": stamp}))
            cached = {"data": {"id": 1, "trueDL": 0, "difficultyForecast": None, "gotQuestionsTags": []},
                      "source": D.API + "/tournaments/1", "fetchedAt": stamp, "refreshRunId": "b" * 32}
            path = root / "data/raw/1-meta.json"; path.write_text(json.dumps(cached))
            tournament = {"id": 1, "sourceFetchedAt": {"metadata": stamp}}
            self.assertEqual(D.from_refreshed_metadata(tournament, {}, root)["trueDL"], 0)
            cached["refreshRunId"] = "a" * 32; path.write_text(json.dumps(cached))
            with self.assertRaisesRegex(ValueError, "not freshly"):
                D.from_refreshed_metadata(tournament, {}, root)


if __name__ == "__main__":
    unittest.main()
