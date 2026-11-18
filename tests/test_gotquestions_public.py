import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from gotquestions_public import extract_next, extract_pack, normalize_pack, plain_text


def packet():
    return {"id": 42, "title": "Новый пакет", "startDate": "2026-10-20T00:00:00.000Z",
            "endDate": "2026-10-30T00:00:00.000Z", "pubDate": "2026-11-01T00:00:00.000Z", "published": True,
            "truedls": [5.7, 4.2, 0], "tIds": [10, 11, 12], "teams": [2, 100, 3],
            "editors": [{"person": {"id": 123, "name": "Иван Редактор"}}],
            "tours": [{"id": 7, "number": 1, "title": "", "questions": [
                {"id": 100, "number": 0, "text": "Дуплет.\\n1. Первый?\\n2. Второй?", "razdatkaText": "Раздатка",
                 "razdatkaPic": "/pics/42/handout.png", "answerPic": "/pics/42/answer.png", "audio": "/sound.ogg",
                 "commentPic": "/pics/42/comment.png", "commentAudio": "/comment.mp3", "answer": "Ответ.",
                 "authors": [{"person": {"id": 23, "name": "Иван Автор", "surname": "Автор"}}]},
                {"id": 101, "number": 1, "text": "Тот же текст", "answer": "Ответ", "authors": []},
                {"id": 102, "number": 2, "text": "Тот же текст", "answer": "", "authors": [], "takenDown": True}]}]}


class PublicGotQuestionsTests(unittest.TestCase):
    def test_public_json_is_parsed_without_executing_scripts(self):
        p = packet()
        # A random question's partial pack precedes the actual requested pack.
        data = '0:{"pack":{"id":999,"title":"random"}}\n5:' + json.dumps({"pack": p}, ensure_ascii=False)
        source = '<script>throw new Error("must not execute")</script>'
        cut = len(data) // 2
        for chunk in [data[:cut], data[cut:]]:
            source += '<script>self.__next_f.push(' + json.dumps([1, chunk]) + ')</script>'
        self.assertEqual(extract_next(source), data)
        self.assertEqual(extract_pack(source, 42), p)
        with self.assertRaises(ValueError):
            extract_pack(source, 43)

    def test_long_flight_texts_use_utf8_byte_lengths_and_may_be_adjacent(self):
        p = packet()
        p["tours"][0]["questions"][0]["comment"] = "$1a"
        p["tours"][0]["questions"][0]["source"] = "$1b"
        p["tours"][0]["questions"][0]["note"] = "$$1a"
        comment = 'Длинный комментарий.\nСодержит кириллицу и {"pack":{"id":999,"tours":[]}}.'
        attribution = "Источник: статья.\nВторая строка."
        data = "1a:T" + format(len(comment.encode("utf-8")), "x") + "," + comment
        data += "1b:T" + format(len(attribution.encode("utf-8")), "x") + "," + attribution
        data += "5:" + json.dumps({"pack": p}, ensure_ascii=False) + "\n"
        # A network script chunk boundary can also occur inside a text record.
        source = "".join('<script>self.__next_f.push(' + json.dumps([1, part]) + ')</script>'
                         for part in [data[:100], data[100:]])
        q = extract_pack(source, 42)["tours"][0]["questions"][0]
        self.assertEqual(q["comment"], comment)
        self.assertEqual(q["source"], attribution)
        self.assertEqual(q["note"], "$1a")

    def test_unresolved_flight_reference_fails_instead_of_becoming_question_text(self):
        p = packet()
        p["tours"][0]["questions"][0]["text"] = "$1a"
        data = '5:' + json.dumps({"pack": p}, ensure_ascii=False)
        source = '<script>self.__next_f.push(' + json.dumps([1, data]) + ')</script>'
        with self.assertRaisesRegex(ValueError, "Unresolved public Flight"):
            extract_pack(source, 42)

    def test_preserve_all_questions_media_and_exact_author_identity(self):
        result = normalize_pack(packet(), "2025-11-10", "2026-11-10", "2026-11-10T01:00:00Z")
        self.assertEqual(len(result["questions"]), 3)
        q = result["questions"][0]
        self.assertEqual(q["number"], 0)
        self.assertEqual(q["text"], "Раздатка\n\nДуплет.\n1. Первый?\n2. Второй?")
        self.assertTrue(q["flags"]["nonstandardTiming"])
        self.assertEqual(q["authors"][0]["id"], "gq-person-23")
        self.assertEqual(q["authors"][0]["surname"], "Автор")
        self.assertEqual({m["role"] for m in q["media"]}, {"handout", "question", "answer", "comment"})
        self.assertTrue(all(m["url"].startswith("https://gotquestions.online/") for m in q["media"]))
        self.assertTrue(result["questions"][2]["flags"]["takenDown"])
        self.assertTrue(result["questions"][2]["flags"]["missingAnswer"])
        self.assertTrue(result["questions"][1]["flags"]["missingAuthors"])
        self.assertEqual(result["questions"][1]["authors"], [])  # No invented editor attribution.

    def test_choose_an_official_observation_without_an_invented_mean(self):
        p = normalize_pack(packet())["package"]
        self.assertEqual(p["trueDl"], 4.2)
        self.assertEqual(p["ratingTournamentId"], 11)
        self.assertEqual(p["trueDlValues"], [5.7, 4.2, 0])
        self.assertEqual(p["difficultySelection"], "most_teams_tournament")
        changed = packet()
        changed["truedls"] = [False, "4.2", None, float("nan"), 11]
        result = normalize_pack(changed)
        self.assertIsNone(result["package"]["trueDl"])
        self.assertEqual(len(result["questions"]), 3)
        self.assertTrue(all(q["flags"]["missingDifficulty"] for q in result["questions"]))

    def test_training_categories_share_played_question_classifier(self):
        p = packet()
        p["tours"][0]["questions"][0]["text"] = "Дуплет. Назовите два слова на парные согласные."
        q = normalize_pack(p)["questions"][0]
        self.assertEqual(q["classification"], {"format": "duplet", "handout": "with", "forms": ["paired_initials"]})
        self.assertNotIn("evidence", q["classification"])

    def test_question_difficulty_uses_paired_counts_and_never_package_truedl(self):
        p = packet()
        q = p["tours"][0]["questions"][0]
        q.update(correctAnswers=[1, 62, 0], teamsCount=[2, 100, 3], complexity=["50", "62", "0"])
        result = normalize_pack(p)["questions"][0]["difficultyObservations"]
        self.assertEqual(result[1], {"sourceIndex": 1, "tournamentId": 11, "correctAnswers": 62, "teamsCount": 100, "rate": .62, "trueDl": 4.2})
        q["teamsCount"] = [100]
        self.assertEqual(normalize_pack(p)["questions"][0]["difficultyObservations"], [])
        q["teamsCount"] = [2, 100, 3]
        p["tIds"] = [99]
        p["truedls"] = [7]
        result = normalize_pack(p)["questions"][0]["difficultyObservations"]
        self.assertTrue(all(x["tournamentId"] is None and x["trueDl"] is None for x in result))
        # Zero trueDL is a valid packet observation, not a question take rate.
        self.assertEqual(result[2]["rate"], 0)

    def test_question_difficulty_rejects_invalid_denominators_and_successes(self):
        p = packet()
        q = p["tours"][0]["questions"][0]
        q.update(correctAnswers=[False, 11, 1, float("nan"), 1.5, 0, 3], teamsCount=[30, 10, 0, 40, 30, True, 30])
        result = normalize_pack(p)["questions"][0]["difficultyObservations"]
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["sourceIndex"], 6)
        self.assertEqual(result[0]["rate"], .1)

    def test_inert_html_text_preserves_paragraphs_and_lists(self):
        text = plain_text('<p>А &amp; Б</p><ul><li>Первый</li><li>Второй<br>перенос</li></ul><script>alert(1)</script>')
        self.assertIn("А & Б", text)
        self.assertIn("• Первый", text)
        self.assertIn("Второй\nперенос", text)
        self.assertNotIn("alert", text)
        self.assertNotIn("<", text)
        self.assertEqual(plain_text("2 < 3"), "2 < 3")

    def test_date_window_uses_play_date_and_duplicates_fail_explicitly(self):
        p = packet()
        p["startDate"] = "2005-01-13T00:00:00.000Z"
        self.assertFalse(normalize_pack(p, "2025-11-10", "2026-11-10")["package"]["inRequestedDateWindow"])
        p["tours"][0]["questions"][1]["id"] = 100
        with self.assertRaises(ValueError):
            normalize_pack(p)

    def test_legacy_cached_date_markers_and_source_review_flags_are_preserved(self):
        p = packet()
        p["startDate"] = "$D2026-10-20T00:00:00.000Z"
        p["endDate"] = "$D2026-10-30T00:00:00.000Z"
        p["pubDate"] = "$D2026-11-01T00:00:00.000Z"
        p["tours"][0]["questions"][0].update(hasControversials=True, hasAppeals=True, marked=True)
        result = normalize_pack(p, "2025-11-10", "2026-11-10")
        self.assertEqual(result["package"]["dateStart"], "2026-10-20T00:00:00.000Z")
        self.assertEqual(result["package"]["dateEnd"], "2026-10-30T00:00:00.000Z")
        self.assertEqual(result["package"]["publishedAt"], "2026-11-01T00:00:00.000Z")
        self.assertTrue(result["package"]["inRequestedDateWindow"])
        self.assertTrue(all(result["questions"][0]["flags"][key] for key in ["hasControversials", "hasAppeals", "marked"]))


if __name__ == "__main__":
    unittest.main()
