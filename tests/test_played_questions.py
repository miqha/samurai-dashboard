import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fetch_played_questions import build, classify, map_questions, publication_date, valid_cache


def packet(local=False):
    return {"tours": [{"number": k + 1, "questions": [
        {"id": k * 100 + i + 1, "number": i + 1 if local else k * 2 + i + 1, "text": "Вопрос"} for i in range(2)]} for k in range(2)]}


class PlayedQuestionsTests(unittest.TestCase):
    def test_publication_date_requires_actual_valid_timestamp(self):
        for value in ["2026-11-03T10:37:04.000Z", "2026-02-28T00:00:00+03:00"]:
            with self.subTest(value=value):
                self.assertEqual(publication_date(value), value)
        for value in [None, "", 0, True, "2026-11-03", "2026-11-03T10:00:00", "not-a-date",
                      "2026-02-30T10:00:00Z", "2026-11-03T24:00:00Z", "2026-11-03T10:00:00+01:60"]:
            with self.subTest(value=value):
                self.assertIsNone(publication_date(value))

    def test_matched_publication_comes_from_the_verified_pack_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data").mkdir()
            history = {"fetchedAt": "2026-11-17T00:00:00Z", "builtAt": "2026-11-17T00:00:00Z",
                       "cutoff": "2026-11-17", "team": {"id": 1}, "tournaments": [
                           {"id": 123, "name": "Тест", "included": True, "totalQuestions": 4, "questionQty": [2, 2]}]}
            (root / "data/dashboard.json").write_text(json.dumps(history))
            (root / "data/gotquestions.json").write_text(json.dumps({"tournaments": [{"tournamentId": 123, "packetIds": [50]}]}))
            catalog = {"meta": {"fetchedAt": "2099-01-01T00:00:00Z"},
                       "packages": [{"id": 50, "tIds": [123], "pubDate": "2099-01-01T00:00:00Z"}]}
            for value in ["2026-10-23T18:30:15.231Z", None, "2026-02-30T12:00:00Z"]:
                with self.subTest(pubDate=value):
                    pack = {**packet(), "id": 50, "published": True, "pubDate": value}
                    cache = {"pack": pack, "fetchedAt": "2099-01-01T00:00:00Z",
                             "htmlSha256": "a" * 64, "packSha256": "b" * 64}
                    with patch("fetch_played_questions.get_pack", return_value=cache):
                        result = build(root, history, catalog)
                    status = result["tournaments"][0]
                    self.assertEqual(status["status"], "matched")
                    self.assertEqual(status["publishedAt"], publication_date(value))
                    self.assertEqual(result["coverage"]["matchedGamesWithPublicationDate"], int(publication_date(value) is not None))
                    self.assertNotEqual(status["publishedAt"], catalog["packages"][0]["pubDate"])

    def test_exact_absolute_positions_and_zero_warmup(self):
        p = packet()
        p["tours"][0]["questions"].insert(0, {"id": 999, "number": 0})
        rows, method = map_questions({"totalQuestions": 4, "questionQty": [2, 2]}, p)
        self.assertEqual([x[0] for x in rows], [1, 2, 3, 4])
        self.assertEqual([x[1]["id"] for x in rows], [1, 2, 101, 102])
        self.assertEqual(method, "exact_absolute_numbers_1_to_N")

    def test_local_numbers_require_exact_explicit_tours_and_lengths(self):
        p = packet(local=True)
        rows, method = map_questions({"totalQuestions": 4, "questionQty": [2, 2]}, p)
        self.assertEqual([x[0] for x in rows], [1, 2, 3, 4])
        self.assertEqual(method, "exact_tour_and_local_numbers")
        p["tours"][1]["number"] = 1
        self.assertIsNone(map_questions({"totalQuestions": 4, "questionQty": [2, 2]}, p)[0])

    def test_incomplete_extra_and_duplicate_ids_fail_closed(self):
        p = packet()
        p["tours"][1]["questions"].pop()
        self.assertIsNone(map_questions({"totalQuestions": 4, "questionQty": [2, 2]}, p)[0])
        p = packet(); p["tours"][1]["questions"].append({"id": 555, "number": 5})
        self.assertIsNone(map_questions({"totalQuestions": 4, "questionQty": [2, 2]}, p)[0])
        p = packet(); p["tours"][1]["questions"][0]["id"] = 1
        self.assertIsNone(map_questions({"totalQuestions": 4, "questionQty": [2, 2]}, p)[0])

    def test_explicit_tiebreak_can_be_excluded_only_with_complete_main_sequence(self):
        p = packet()
        p["tours"].append({"number": 0, "title": "Перестрелка", "questions": [{"id": 999, "number": 5}]})
        rows, method = map_questions({"totalQuestions": 4, "questionQty": [2, 2]}, p)
        self.assertEqual([r[0] for r in rows], [1, 2, 3, 4])
        self.assertIn("explicit_supplementary", method)
        p["tours"][-1]["title"] = "Неизвестный тур"
        self.assertIsNone(map_questions({"totalQuestions": 4, "questionQty": [2, 2]}, p)[0])

    def test_format_only_reading_instructions_and_mixed_formats(self):
        self.assertEqual(classify({"text": "Дуплет. Два вопроса по 30 секунд."})["format"], "duplet")
        self.assertEqual(classify({"text": "[Ведущему: читать спокойно.] Блиц. Три вопроса."})["format"], "blitz")
        for term in ["Тетраблиц", "Тетра-блиц", "Тетра блиц", "Тетра–блиц", "Тетра‑блиц"]:
            self.assertEqual(classify({"text": term + ". 4 вопроса по 15 секунд."})["format"], "tetra")
        self.assertEqual(classify({"text": "Если выпадет 1 — дуплет, 2 — блиц. Время обсуждения вопросов одинаковое."})["format"], "other")
        self.assertEqual(classify({"text": "Икоситетра-блиц. Будет три вопроса."})["format"], "other")
        self.assertEqual(classify({"text": "Некто любил шахматный блиц. Назовите город."})["format"], "ordinary")
        self.assertEqual(classify({"text": "В интервью шахматист ответил на вопросы, после чего сыграл блиц."})["format"], "ordinary")

    def test_constraints_are_source_text_and_do_not_match_soglasno(self):
        self.assertEqual(classify({"text": "Согласно одной версии, он жил в Лиме. Назовите город."})["forms"], ["unmarked"])
        result = classify({"text": "Назовите его словом, в котором обе гласные одинаковые."})
        self.assertEqual(result["forms"], ["same_vowels"])
        self.assertIn("обе гласные одинаковые", result["evidence"]["forms"][0]["excerpt"])
        self.assertEqual(classify({"text": "Какое слово, в котором все пять гласных одинаковы, употребила Ольга?"})["forms"], ["same_vowels"])
        self.assertEqual(classify({"text": "Назовите ЕЁ словом, в котором из гласных есть только четыре буквы «о»."})["forms"], ["same_vowels"])
        self.assertEqual(classify({"text": "Назовите город.", "answer": "Дуплет. Гласные одинаковые.", "comment": "Одинаковые инициалы."})["forms"], ["unmarked"])
        self.assertEqual(classify({"text": "Назовите двумя словами на парные буквы."})["forms"], ["paired_initials"])
        self.assertEqual(classify({"text": "Назовите два слова, начинающиеся на парные согласные."})["forms"], ["paired_initials"])
        self.assertIn("same_initials", classify({"text": "Два слова, начинающиеся на одну и ту же букву."})["forms"])

    def test_parenthesized_and_question_prefixed_reading_declarations(self):
        # Published questions 443658, 447027, 482987 and 497143.
        cases = [("Дуплет (два вопроса по 30 секунд обсуждения).", "duplet"),
                 ("Дуплет (2 вопроса по 30 секунд обсуждения).", "duplet"),
                 ("Вопрос-дуплет. Два вопроса по 30 секунд обсуждения.", "duplet"),
                 ("Внимание, вопрос-блиц. Три вопроса по 20 секунд обсуждения.", "blitz")]
        for text, kind in cases:
            with self.subTest(text=text):
                self.assertEqual(classify({"text": text})["format"], kind)
        self.assertEqual(classify({"text": "Вопрос-тетра-блиц (четыре вопроса по 15 секунд)."})["format"], "tetra")
        for text in ["Ведущий назвал вопрос-дуплет удачным. Назовите ведущего.",
                     "Этот вопрос-блиц придумал шахматист. Назовите город.",
                     "Дуплет обсуждали участники рассказа. Назовите автора.",
                     "Внимание, вопрос-блицеры придумали в рассказе. Назовите город."]:
            with self.subTest(text=text):
                self.assertEqual(classify({"text": text})["format"], "ordinary")

    def test_handout_uses_only_published_handout_fields(self):
        self.assertEqual(classify({"text": "У него в руке была раздатка."})["handout"], "without")
        result = classify({"text": "Вопрос", "razdatkaPicGeneric": "/picture.png"})
        self.assertEqual(result["handout"], "with")
        self.assertEqual(result["evidence"]["handout"][0]["field"], "razdatkaPicGeneric")

    def test_handout_only_text_and_guarded_answer_forms(self):
        result = classify({"text": "", "razdatkaText": "Дуплет. Два вопроса по 30 секунд. Назовите словами на парные согласные."})
        self.assertEqual(result["format"], "duplet")
        self.assertIn("paired_initials", result["forms"])
        self.assertEqual(result["evidence"]["forms"][0]["field"], "razdatkaText")
        self.assertEqual(classify({})["format"], "other")
        self.assertEqual(classify({"text": "Вопрос про анаграммы. Назовите автора упомянутого романа."})["forms"], ["unmarked"])
        self.assertEqual(classify({"text": "В древности эту надпись читали как палиндром. Назовите город."})["forms"], ["unmarked"])
        self.assertIn("anagram", classify({"text": "Назовите ИГРЕКА и фамилию ИКСА анаграммами."})["forms"])
        self.assertIn("palindrome", classify({"form": "Палиндром"})["forms"])
        # Published explicit answer instructions, questions 437165 and 449108.
        self.assertIn("anagram", classify({"text": "Заполните оба пропуска анаграммами."})["forms"])
        self.assertIn("palindrome", classify({"text": "Закончите палиндромом нерифмованное двустишие."})["forms"])
        self.assertEqual(classify({"text": "Герой заполнил оба пропуска анаграммами. Назовите автора рассказа."})["forms"], ["unmarked"])
        self.assertEqual(classify({"text": "Поэт закончил палиндромом нерифмованное двустишие. В каком году он родился?"})["forms"], ["unmarked"])

    def test_actual_mapping_is_complete_unique_and_source_backed(self):
        root = Path(__file__).resolve().parents[1]
        path = root / "data/played-questions.json"
        if not path.exists():
            self.skipTest("Initial source snapshot not built yet")
        data = json.loads(path.read_text())
        history = json.loads((root / "data/dashboard.json").read_text())
        by_id = {t["id"]: t for t in history["tournaments"]}
        keys = {(q["tournamentId"], q["number"]) for q in data["questions"]}
        self.assertEqual(len(keys), len(data["questions"]))
        for status in data["tournaments"]:
            if status["status"] == "matched":
                t = by_id[status["tournamentId"]]
                self.assertEqual({n for tid, n in keys if tid == t["id"]}, set(range(1, t["totalQuestions"] + 1)))
                self.assertIn(status["link"], ["official_gotQuestionsTags", "gotquestions_published_rating_tIds"])
        for q in data["questions"]:
            self.assertTrue(q["sourceUrl"].endswith("/" + str(q["questionId"])))
            self.assertEqual(len(q["provenance"]["sourcePackSha256"]), 64)


if __name__ == "__main__":
    unittest.main()
