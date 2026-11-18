#!/usr/bin/env python3
"""Network-free coverage and provenance checks for the annual public catalogue."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import training_year_catalog as catalog


def package(identifier):
    return {"id": identifier, "title": "Пакет", "published": True,
            "questionCount": 36, "startDate": "$D2025-10-01T00:00:00.000Z",
            "endDate": "$D2025-12-01T00:00:00.000Z", "pubDate": "$D2026-01-01T00:00:00.000Z",
            "tIds": [123], "truedls": [5.2], "teams": [40]}


def page(rows, number=1, total=None):
    total = len(rows) if total is None else total
    result = {"items": rows, "metadata": {"page": number, "pageSize": 100,
              "totalResults": total, "totalPages": (total + 99) // 100}}
    stream = '7:["$","div",null,{"initialData":' + json.dumps(result, ensure_ascii=False) + '}]\n'
    middle = len(stream) // 2
    return ("<html><script>self.__next_f.push(" + json.dumps([1, stream[:middle]]) + ")</script>"
            "<script>self.__next_f.push(" + json.dumps([1, stream[middle:]]) + ")</script></html>").encode()


class AnnualCatalogueTests(unittest.TestCase):
    def test_exact_public_query_and_source_dates(self):
        url = catalog.search_url("2025-11-10", "2026-11-10", 2)
        self.assertEqual(urlsplit(url).netloc, "gotquestions.online")
        query = parse_qs(urlsplit(url).query)
        self.assertEqual(query["startPlayed"], ["2025-11-10"])
        self.assertEqual(query["endPlayed"], ["2026-11-10"])
        self.assertEqual(query["limit"], ["100"])
        result = catalog.build_catalog([page([package(1)]), page([], 2)], "2025-11-10", "2026-11-10")
        self.assertTrue(result["meta"]["complete"])
        self.assertEqual(result["meta"]["sourceQuestions"], 36)
        self.assertEqual(result["packages"][0]["startDate"], "2025-10-01T00:00:00.000Z")
        self.assertEqual(result["packages"][0]["truedls"], [5.2])
        self.assertEqual(len(result["meta"]["pages"][0]["sha256"]), 64)

    def test_all_pages_and_unique_ids_are_required(self):
        first = page([package(n) for n in range(1, 101)], total=101)
        second = page([package(101)], 2, 101)
        terminal = page([], 3)
        result = catalog.build_catalog([first, second, terminal], "2025-11-10", "2026-11-10")
        self.assertEqual(len(result["packages"]), 101)
        for invalid in ([first], [first, second], [first, page([package(100)], 2, 101), terminal]):
            with self.assertRaises(ValueError):
                catalog.build_catalog(invalid, "2025-11-10", "2026-11-10")

    def test_search_change_or_wrong_page_is_rejected(self):
        first = page([package(n) for n in range(1, 101)], total=101)
        for second in (page([package(101)], 2, 102), page([package(101)], 1, 101), page([], 2, 101)):
            with self.assertRaises(ValueError):
                catalog.build_catalog([first, second, page([], 3)], "2025-11-10", "2026-11-10")

    def test_unpublished_or_malformed_records_are_rejected(self):
        for change in ({"published": False}, {"id": True}, {"questionCount": "36"},
                       {"endDate": "2026-01-01"}):
            row = {**package(1), **change}
            with self.assertRaises(ValueError):
                catalog.build_catalog([page([row]), page([], 2)], "2025-11-10", "2026-11-10")

    def test_login_html_cannot_become_empty_success(self):
        with self.assertRaises(ValueError):
            catalog.search_result(b"<html>Sign in</html>")

    def test_empty_catalogue_and_date_mismatch_cache(self):
        result = catalog.build_catalog([page([])], "2025-11-10", "2026-11-10")
        self.assertEqual(result["packages"], [])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            folder = root / "data/training-year-sources/catalog"
            folder.mkdir(parents=True)
            (folder / "request.json").write_text(json.dumps({"from": "2024-11-10", "toInclusive": "2025-11-10"}))
            with self.assertRaisesRegex(ValueError, "different date interval"):
                catalog.create_catalog(root, "2025-11-10", "2026-11-10")

    def test_saved_actual_snapshot_reproduces_claimed_catalogue(self):
        root = Path(__file__).resolve().parents[1]
        current = json.loads((root / "data/training-year-catalog.json").read_text())
        paths = [root / p["sourceFile"] for p in current["meta"]["pages"]]
        result = catalog.build_catalog([p.read_bytes() for p in paths], current["meta"]["from"],
                                       current["meta"]["toInclusive"], current["meta"]["fetchedAt"])
        self.assertEqual(result, current)
        self.assertEqual(len(result["packages"]), len({p["id"] for p in result["packages"]}))


if __name__ == "__main__":
    unittest.main()
