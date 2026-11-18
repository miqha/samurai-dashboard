"""Provenance and eligibility checks for the real training catalog."""

import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("fetch_training", ROOT / "scripts/fetch_training.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class TrainingDataTests(unittest.TestCase):
    def setUp(self):
        self.manifest = M.read_json(ROOT / "data/training-sources/manifest.json")

    def test_real_packet_has_original_answers_authors_and_provenance(self):
        result = M.build(ROOT, self.manifest)
        first = next(q for q in result["questions"] if q["package"]["id"] == 1057 and q["number"] == 1)
        self.assertIn("ДЕннис МУррен", first["text"])
        self.assertEqual(first["answer"], 'Открывающие титры "Звездных войн".')
        self.assertEqual(first["authors"][0]["name"], "Иван Карбовник")
        self.assertIn("ползущие титры", first["acceptedText"])
        self.assertEqual(first["package"]["trueDl"], 6)
        self.assertEqual(first["package"]["difficultyScope"], "package")
        self.assertIsNone(first["provenance"]["gotQuestionsQuestionId"])
        self.assertEqual(first["sourceUrl"], "https://gotquestions.online/pack/1057")
        exact = next(q for q in result["questions"] if q["package"]["id"] == 1057 and q["number"] == 61)
        self.assertEqual(exact["provenance"]["gotQuestionsQuestionId"], 56699)
        self.assertIn("АравИнда АдИги", exact["text"])
        self.assertEqual(exact["sourceUrl"], "https://gotquestions.online/pack/1057")
        self.assertFalse(exact["provenance"]["gotQuestionsIdPacketMembershipVerified"])
        self.assertTrue(first["provenance"]["textSourceUrl"].startswith("https://raw.githubusercontent.com/chgk/"))
        self.assertEqual(len(first["provenance"]["textSha256"]), 64)

    def test_real_bank_complete_plain_text_and_same_60_second_format(self):
        result = M.build(ROOT, self.manifest)
        packet = [q for q in result["questions"] if q["package"]["id"] == 1057]
        self.assertEqual(len(packet), 75)
        self.assertGreaterEqual(len({a["name"] for q in packet for a in q["authors"]}), 10)
        self.assertEqual(len(result["questions"]), 207)
        self.assertEqual({q["package"]["trueDl"] for q in result["questions"]}, {4.9, 6, 6.8})
        self.assertEqual({p["id"]: p["sourceQuestionCount"] for p in result["packages"]}, {1057: 90, 1219: 60, 1525: 90})
        self.assertEqual({p["id"]: p["questions"] for p in result["packages"]}, {1057: 75, 1219: 50, 1525: 82})
        self.assertEqual(len({q["id"] for q in result["questions"]}), len(result["questions"]))
        for question in result["questions"]:
            self.assertTrue(question["text"].strip())
            self.assertTrue(question["answer"].strip())
            self.assertTrue(question["authors"])
            self.assertFalse(M.MEDIA.search(question["text"]))
            self.assertFalse(M.NONSTANDARD.search(question["text"]))
            self.assertTrue(M.finite_dl(question["package"]["trueDl"]))
            self.assertEqual(question["acceptedAnswers"], [])

    def test_parser_does_not_turn_editor_into_author_or_lose_coauthors(self):
        source = 'Тур:\n1 тур\n\nРедактор:\nИван Иванов\n\nВопрос 1:\nТекст\nс продолжением.\n\nОтвет:\nОтвет.\n\nЗачёт:\nЗачёт по смыслу.\n\nАвтор:\nАнна Сидорова (Минск), Пётр Петров (Рига)\n\nТур:\n2 тур\n\nВопрос 2:\nБез автора\n\nОтвет:\nДа.\n'
        items = M.parse_txt(source)
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["text"], "Текст с продолжением.")
        self.assertEqual(items[0]["Зачет"], "Зачёт по смыслу.")
        self.assertEqual([a["name"] for a in M.authors(items[0]["Автор"])], ["Анна Сидорова", "Пётр Петров"])
        self.assertNotIn("Автор", items[1])
        self.assertEqual(items[1]["tour"], "2 тур")

    def test_unknown_or_boolean_difficulty_is_not_zero(self):
        for invalid in [None, True, "6", float("nan"), float("inf"), -1, 11]:
            bad = copy.deepcopy(self.manifest)
            bad["packages"][0]["trueDl"] = invalid
            with self.assertRaises(ValueError):
                M.build(ROOT, bad)
        self.assertTrue(M.finite_dl(0))

    def test_exact_played_packet_and_future_window_are_excluded(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            M.write_json(root / "data/team-difficulty.json", {"tournaments": [{"gotQuestionsTags": [1057]}]})
            only_played = copy.deepcopy(self.manifest)
            only_played["packages"] = only_played["packages"][:1]
            result = M.build(root, only_played)
            self.assertEqual(result["questions"], [])
            self.assertGreater(result["meta"]["coverage"]["excluded"]["playedOrOpenPacket"], 0)
            M.write_json(root / "data/catalog.json", {"tournaments": [{"gotQuestionsTags": [1219], "dateEnd": "2099-01-01T00:00:00+00:00"}]})
            excluded = M.excluded_packet_ids(root, datetime.now(timezone.utc))
            self.assertEqual(excluded, {1057, 1219})
        future = copy.deepcopy(self.manifest)
        future["packages"][0]["dateEnd"] = "2099-01-01T00:00:00+00:00"
        result = M.build(ROOT, future)
        self.assertNotIn(1057, [q["package"]["id"] for q in result["questions"]])

    def test_source_checksum_fails_closed(self):
        bad = copy.deepcopy(self.manifest)
        bad["packages"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
            M.build(ROOT, bad)

    def test_declared_source_question_count_fails_closed(self):
        bad = copy.deepcopy(self.manifest)
        bad["packages"][1]["sourceQuestionCount"] = 61
        with self.assertRaisesRegex(ValueError, "expected 61 questions, got 60"):
            M.build(ROOT, bad)

    def test_official_truedl_and_packet_binding_must_agree(self):
        bad = copy.deepcopy(self.manifest)
        bad["packages"][0]["trueDl"] = 3
        with self.assertRaisesRegex(ValueError, "official difficulty/packet evidence mismatch"):
            M.build(ROOT, bad)

    def test_question_ids_require_the_complete_same_text(self):
        bad = copy.deepcopy(self.manifest)
        bad["packages"][0]["questionIds"]["1"] = 56699
        with self.assertRaisesRegex(ValueError, "question ID text mismatch"):
            M.build(ROOT, bad)

    def test_default_build_is_offline(self):
        with patch.object(M.urllib.request, "urlopen", side_effect=AssertionError("network should not be used")):
            result = M.build(ROOT, self.manifest)
        self.assertGreater(len(result["questions"]), 50)

    def test_refresh_stops_on_429_and_keeps_verified_sources(self):
        before = (ROOT / "data/training-sources/ruch17st.txt").read_bytes()
        response = urllib.error.HTTPError("https://example.org/packet", 429, "Too many requests", {}, None)
        with patch.object(M.urllib.request, "urlopen", side_effect=response) as request:
            errors = M.refresh_sources(ROOT, copy.deepcopy(self.manifest))
        self.assertEqual(request.call_count, 1)
        self.assertEqual(len(errors), 1)
        self.assertEqual((ROOT / "data/training-sources/ruch17st.txt").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
