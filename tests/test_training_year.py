"""End-to-end completeness and resumable-cache checks for the year archive."""

import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.error import HTTPError
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import fetch_training_year as F


def fixture_pack(identifier=1, *, difficulty=5, text="Текст вопроса", answer="Ответ"):
    return {"id": identifier, "title": "Пакет " + str(identifier), "published": True,
            "type": "kvrm", "startDate": "2026-01-01T00:00:00Z", "endDate": "2026-01-02T00:00:00Z",
            "pubDate": "2026-01-03T00:00:00Z", "tIds": [100 + identifier],
            "truedls": [difficulty], "teams": [20], "editors": [],
            "tours": [{"number": 1, "questions": [{"id": 1, "number": 1, "text": text,
                "answer": answer, "authors": [], "razdatkaPic": "/pics/1/handout.png"}]}]}


def store(root, pack, version=2):
    encoded = json.dumps(pack, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    value = {"formatVersion": version, "fetchedAt": "2026-11-09T22:00:00Z", "sourceUrl": "https://gotquestions.online/pack/" + str(pack["id"]),
             "sourceQuestionCount": 1, "htmlSha256": "a" * 64,
             "packSha256": hashlib.sha256(encoded).hexdigest(), "pack": pack}
    F.write_json(F.cache_path(root, pack["id"]), value)
    return value


def catalog(identifiers=(1,)):
    return {"meta": {"complete": True, "terminalEmptyPage": True, "from": "2025-11-10",
            "toInclusive": "2026-11-10", "totalResults": len(identifiers), "sourceQuestions": len(identifiers),
            "sourceUrl": "https://gotquestions.online/search?type=packages", "fetchedAt": "2026-11-09T22:00:00Z",
            "dateBasis": "GotQuestions public play-date filter", "pages": [{"page": 1, "count": len(identifiers)}, {"page": 2, "count": 0}]},
            "packages": [{"id": identifier, "questionCount": 1} for identifier in identifiers]}


class TrainingYearTests(unittest.TestCase):
    def test_requires_all_public_catalogue_results(self):
        value = catalog()
        for field in ("complete", "terminalEmptyPage"):
            bad = copy.deepcopy(value); bad["meta"][field] = False
            with self.assertRaises(ValueError): F.validate_catalog(bad)
        bad = catalog((1, 1))
        with self.assertRaisesRegex(ValueError, "Duplicate"): F.validate_catalog(bad)

    def test_missing_pack_never_publishes_a_partial_year(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            store(root, fixture_pack())
            old = root / "training-data.js"; old.write_text("previous verified snapshot")
            with self.assertRaisesRegex(ValueError, "incomplete"):
                F.build(root, catalog((1, 2)))
            self.assertEqual(old.read_text(), "previous verified snapshot")

    def test_complete_bank_keeps_unknown_difficulty_media_and_reprinted_text(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            store(root, fixture_pack(1, difficulty=None, text="Дуплет: общий текст"))
            store(root, fixture_pack(2, difficulty=0, text="Дуплет: общий текст"))
            bank = F.build(root, catalog((1, 2)))
            self.assertEqual(len(bank["questions"]), 2)
            self.assertEqual(len({q["id"] for q in bank["questions"]}), 2)
            self.assertIsNone(bank["questions"][0]["package"]["trueDl"])
            self.assertEqual(bank["questions"][1]["package"]["trueDl"], 0)
            self.assertTrue(all(q["flags"]["nonstandardTiming"] and q["media"] for q in bank["questions"]))
            self.assertEqual(bank["meta"]["coverage"]["questionsWithoutDifficulty"], 1)

    def test_declared_count_and_cache_integrity_must_match(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); pack = fixture_pack(); store(root, pack)
            path = F.cache_path(root, 1)
            self.assertIsNotNone(F.validated_cache(path, {"id": 1, "questionCount": 1}))
            self.assertIsNone(F.validated_cache(path, {"id": 1, "questionCount": 2}))
            payload = F.read_json(path); payload["pack"]["title"] = "tampered"
            F.write_json(path, payload)
            self.assertIsNone(F.validated_cache(path, {"id": 1, "questionCount": 1}))

    def test_old_unresolved_flight_cache_is_repaired_selectively(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            pack = fixture_pack(); pack["tours"][0]["questions"][0]["comment"] = "$1a"
            store(root, pack, version=1)
            self.assertIsNone(F.validated_cache(F.cache_path(root, 1), {"id": 1, "questionCount": 1}))
            # An escaped literal dollar answer is legitimate after the fixed parser.
            pack = fixture_pack(answer="$5"); store(root, pack, version=2)
            self.assertIsNotNone(F.validated_cache(F.cache_path(root, 1), {"id": 1, "questionCount": 1}))

    def test_verified_cache_needs_no_network_and_429_preserves_it(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); store(root, fixture_pack())
            path = F.cache_path(root, 1); original = path.read_bytes()
            never = Mock(side_effect=AssertionError("network"))
            F.fetch_one(root, {"id": 1, "questionCount": 1}, F.Pacer(0), opener=never)
            never.assert_not_called()
            limited = Mock(side_effect=HTTPError("https://gotquestions.online/pack/1", 429, "limited", {}, None))
            pacer = F.Pacer(0)
            with self.assertRaises(HTTPError):
                F.fetch_one(root, {"id": 1, "questionCount": 1}, pacer, refresh=True, opener=limited)
            self.assertTrue(pacer.stopped.is_set()); limited.assert_called_once()
            self.assertEqual(path.read_bytes(), original)

    def test_json_javascript_and_completeness_agree(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); store(root, fixture_pack())
            bank = F.build(root, catalog()); F.publish(root, bank)
            saved = F.read_json(root / "data/training.json")
            script = (root / "training-data.js").read_text()
            embedded = json.loads(script.split("=", 1)[1].strip().removesuffix(";"))
            self.assertEqual(saved, embedded)
            self.assertNotIn("package", saved["questions"][0])
            self.assertEqual(saved["questions"][0]["packageId"], bank["questions"][0]["package"]["id"])
            restored = [{**{key: value for key, value in q.items() if key != "packageId"},
                         "package": next(p for p in saved["packages"] if p["id"] == q["packageId"])}
                        for q in saved["questions"]]
            self.assertEqual(restored, bank["questions"], "Compact serialization loses no field")
            self.assertEqual(saved["meta"]["coverage"]["questions"], saved["meta"]["coverage"]["expectedQuestions"])

    def test_real_year_has_every_declared_public_question(self):
        value = F.read_json(ROOT / "data/training-year-catalog.json")
        bank = F.build(ROOT, value)
        expected = sum(row["questionCount"] for row in value["packages"])
        self.assertEqual(bank["meta"]["coverage"]["questions"], expected)
        self.assertEqual(bank["meta"]["coverage"]["packages"], value["meta"]["totalResults"])
        self.assertEqual(len({q["id"] for q in bank["questions"]}), expected)
        recovered = next(q for q in bank["questions"] if q["canonicalQuestionId"] == 482929)
        self.assertGreater(len(recovered["comment"]), 1000)


if __name__ == "__main__":
    unittest.main()
