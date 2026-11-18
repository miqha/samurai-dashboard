#!/usr/bin/env python3
"""Offline checks for the isolated, fixed-script full-data update pipeline."""

from datetime import datetime, timezone
import json
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import update_dashboard as updater

NOW = datetime(2026, 11, 8, 22, 15, tzinfo=timezone.utc)  # 9 November in Moscow.


def write_snapshot(root, *, stamp="2026-11-09T01:15:00+03:00", cutoff="2026-11-09"):
    data = root / "data"
    data.mkdir(exist_ok=True)
    history = {"team": {"id": updater.TEAM_ID}, "fetchedAt": stamp, "builtAt": stamp, "cutoff": cutoff,
               "coverage": {"errors": [], "issues": [], "listedTournaments": 1,
                            "loadedTournaments": 1, "includedTournaments": 1},
               "tournaments": [{"id": 101, "included": True, "mask": "10", "totalQuestions": 2,
                                "knownQuestions": 2, "maskTaken": 1, "score": 1,
                                "resultsAvailable": True, "canceledQuestions": [], "dataIssues": [],
                                "fieldRates": [.5, .2], "fieldCounts": [2, 5], "fieldSuccesses": [1, 1]}]}
    difficulty = {"teamId": updater.TEAM_ID, "fetchedAt": stamp, "complete": True,
                  "tournaments": [{"id": 101}], "errors": []}
    intersections = {**difficulty, "tournaments": [{"id": 101, "relatedIds": []}]}
    catalog = {"teamId": updater.TEAM_ID, "fetchedAt": stamp, "complete": True,
               "teamHistoryVerified": True, "teamHistoryCheckedAt": stamp, "teamTournamentIds": [101],
               "pagination": {"terminalEmptyPage": True, "uniqueTournaments": 1,
                              "pages": [{"page": 1, "count": 1}, {"page": 2, "count": 0}]},
               "tournaments": [{"id": 201, "dateStart": stamp, "dateEnd": "2026-11-15T12:00:00+03:00"}]}
    authors = {"teamId": updater.TEAM_ID, "sourceSnapshotAt": stamp, "sourceBuiltAt": stamp,
               "allRegistered": {"tournaments": 1}, "included": {"tournaments": 1}}
    bridge = {"status": "truedl_bridge_available", "coverage": {"tournaments": 2},
              "tournaments": [{"tournamentId": 101}, {"tournamentId": 201}]}
    documents = {"dashboard": history, "team-difficulty": difficulty,
                 "team-intersections": intersections, "catalog": catalog,
                 "authors-data": authors, "gotquestions": bridge, "training": {"meta": {"updatedAt": stamp, "complete": True,
                    "coverage": {"packages": 0, "expectedQuestions": 0},
                    "yearWindow": {"from": "2025-11-09", "toInclusive": cutoff}}, "questions": []},
                 "training-year-catalog": {"meta": {"complete": True, "terminalEmptyPage": True,
                    "from": "2025-11-09", "toInclusive": cutoff, "totalResults": 0, "sourceQuestions": 0}, "packages": []},
                 "training-year-status": {"checkedAt": stamp, "catalogPacks": 0, "cachedPacks": 0,
                    "errors": [], "rateLimited": False, "verifiedInRunPacks": 0,
                    "refreshRunId": json.loads((root / ".refresh-context.json").read_text())["runId"] if (root / ".refresh-context.json").exists() else None}}
    for name, document in documents.items():
        (data / (name + ".json")).write_text(json.dumps(document), encoding="utf-8")
    for name, variable in (("data", "DATA"), ("team-difficulty", "DIFFICULTY"),
                           ("team-intersections", "INTERSECTIONS"), ("catalog-data", "CATALOG"), ("training-data", "TRAINING_DATA")):
        key = {"data": "dashboard", "catalog-data": "catalog", "training-data": "training"}.get(name, name)
        (root / (name + ".js")).write_text("window.SAMURAI_" + variable + "=" + json.dumps(documents[key]) + ";", encoding="utf-8")
    write_derived(root)
    (root / "samurai-dashboard.html").write_text("<!doctype html><html><script>window.SAMURAI_DATA={};</script></html>", encoding="utf-8")


def write_derived(root):
    def sha(name):
        return hashlib.sha256((root / name).read_bytes()).hexdigest()
    history = json.loads((root / 'data/dashboard.json').read_text())
    catalog = json.loads((root / 'data/catalog.json').read_text())
    stamp = history['fetchedAt']
    docs = {
        'played-questions': {'teamId': updater.TEAM_ID, 'complete': True, 'builtAt': stamp,
            'sourceHistorySha256': sha('data/dashboard.json'), 'sourceBridgeSha256': sha('data/gotquestions.json'),
            'catalogFetchedAt': stamp, 'tournaments': [{'tournamentId': 101}], 'questions': [],
            'coverage': {'matchedQuestions': 0}},
        'played-questions-catalog': {'meta': {'complete': True, 'terminalEmptyPage': True, 'fetchedAt': stamp}},
        'registration-training': {'teamId': updater.TEAM_ID, 'builtAt': stamp,
            'source': {'inputSha256': {name: sha(name) for name in ('data/dashboard.json', 'data/catalog.json', 'data/training.json')}},
            'tournaments': [{'tournamentId': 101, 'authorBasis': 'unavailable', 'authors': []}]},
        'gotquestions-source-status': {'checkedAt': stamp, 'status': 'reachable', 'httpStatus': 200}
    }
    for name, doc in docs.items():
        (root / f'data/{name}.json').write_text(json.dumps(doc), encoding='utf-8')
    for name, variable, key in [('played-questions-data', 'PLAYED_QUESTIONS', 'played-questions'),
                               ('registration-training', 'REGISTRATION_TRAINING', 'registration-training')]:
        (root / f'{name}.js').write_text('window.SAMURAI_' + variable + '=' + json.dumps(docs[key]) + ';', encoding='utf-8')


def edit_history(root, mutate):
    """Keep JSON and its browser payload consistent in upstream-response fixtures."""
    target = root / "data/dashboard.json"
    history = json.loads(target.read_text(encoding="utf-8"))
    mutate(history)
    serialized = json.dumps(history)
    target.write_text(serialized, encoding="utf-8")
    (root / "data.js").write_text("window.SAMURAI_DATA=" + serialized + ";", encoding="utf-8")
    write_derived(root)
    return history


class UpdateRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="samurai-update-test-")
        self.root = Path(self.temp.name).resolve()
        (self.root / "scripts").mkdir()
        for filename, _label in updater.STEPS:
            (self.root / "scripts" / filename).write_text("# fixed original script\n")
        for filename in updater.SCRIPT_DEPENDENCIES:
            (self.root / "scripts" / filename).write_text("# fixed original dependency\n")
        for filename in ("app.js", "style.css", "index.html", "README.md"):
            (self.root / filename).write_text("original source " + filename)
        (self.root / "vendor").mkdir()
        (self.root / "vendor/library.js").write_text("original vendor")
        (self.root / "data/raw").mkdir(parents=True)
        (self.root / "data/raw/team.json").write_text('{"old":true}')
        write_snapshot(self.root, stamp="2026-11-07T12:00:00+03:00", cutoff="2026-11-07")
        self.original = self.contents()
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def contents(self):
        return {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*")
                if path.is_file() and ".updates" not in path.parts}

    def runner(self, args, **kwargs):
        self.calls.append((args, kwargs))
        stage = Path(kwargs["cwd"])
        for filename in updater.SCRIPT_DEPENDENCIES:
            if not (stage / "scripts" / filename).is_file():
                raise AssertionError("Missing staged script dependency: " + filename)
        if Path(args[1]).name == "build_standalone.py":
            write_snapshot(stage)
            (stage / "data/raw/team.json").write_text('{"new":true}')
            (stage / "data/raw/new.json").write_text('{"new":true}')
            # Even accidental source changes in the staging tree cannot publish.
            (stage / "app.js").write_text("should never overwrite original app")
            (stage / "index.html").write_text("should never overwrite original UI")
            (stage / "scripts/fetch_data.py").write_text("should never overwrite original script")
        return subprocess.CompletedProcess(args, 0, "private output not displayed", "")

    def run_update(self, **kwargs):
        return updater.run_update(root=self.root, subprocess_runner=kwargs.pop("subprocess_runner", self.runner),
                                  now=NOW, parallel=kwargs.pop("parallel", False), **kwargs)

    def assert_clean_staging(self):
        self.assertEqual(list((self.root / ".updates/temp").iterdir()), [])

    def test_success_uses_fixed_arguments_moscow_date_and_never_overwrites_sources(self):
        events = []
        result = self.run_update(report=events.append)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["cutoff"], "2026-11-09")
        self.assertEqual(len(self.calls), len(updater.STEPS))
        for (args, options), (filename, _label) in zip(self.calls, updater.STEPS):
            self.assertEqual(args[0], sys.executable)
            self.assertEqual(Path(args[1]).name, filename)
            self.assertTrue(Path(options["cwd"]).is_relative_to(self.root / ".updates/temp"))
            self.assertIs(options["shell"], False)
            self.assertIs(options["check"], False)
            self.assertEqual(options["stdout"], subprocess.PIPE)
        self.assertEqual(self.calls[0][0][2:], ["--refresh", "--cutoff", "2026-11-09"])
        self.assertEqual(self.calls[1][0][2:], ["--refresh", "--reuse-refreshed-metadata"])
        self.assertEqual(self.calls[2][0][2:], ["--refresh"])
        self.assertEqual(self.calls[3][0][2:], [])
        self.assertEqual(self.calls[4][0][2:], ["--reuse-refreshed-history"])
        self.assertEqual(self.calls[5][0][2:], ["--catalog", "data/catalog.json", "--probe-homepage", "--refresh-probe"])
        self.assertEqual(self.calls[6][0][2:], ["--refresh-year"])
        self.assertEqual(self.calls[7][0][2:], ["--refresh"])
        self.assertEqual(self.calls[8][0][2:], ["--refresh"])
        self.assertEqual(self.calls[9][0][2:], [])
        changed = {key for key in self.original if self.original[key] != self.contents()[key]}
        self.assertTrue(changed)
        self.assertTrue(changed <= set(updater.GENERATED) | {"data/raw/team.json"})
        self.assertEqual(self.root.joinpath("data/raw/new.json").read_text(), '{"new":true}')
        self.assertEqual(events[0]["status"], "running")
        self.assertEqual(events[-1]["label"], "Все данные обновлены")
        self.assertTrue(all(set(event) == {"step", "total", "label", "status"} for event in events))
        self.assertNotIn("private output", json.dumps(events))
        self.assert_clean_staging()

    def test_nonzero_exit_preserves_every_original_file_and_stops_pipeline(self):
        for failure in range(1, len(updater.STEPS) + 1):
            with self.subTest(step=failure):
                self.calls = []

                def failing(args, **kwargs):
                    completed = self.runner(args, **kwargs)
                    if len(self.calls) == failure:
                        return subprocess.CompletedProcess(args, 2, "raw private response", "unsafe upstream details")
                    return completed

                with self.assertRaises(updater.UpdateError) as context:
                    self.run_update(subprocess_runner=failing)
                self.assertNotIn("unsafe", str(context.exception))
                self.assertEqual(len(self.calls), failure)
                self.assertEqual(self.contents(), self.original)
                self.assert_clean_staging()

    def test_timeout_preserves_old_snapshot_without_exposing_raw_error(self):
        def timeout(args, **kwargs):
            raise subprocess.TimeoutExpired(args, 10, output="secret upstream response")

        with self.assertRaises(updater.UpdateError) as context:
            self.run_update(subprocess_runner=timeout)
        self.assertNotIn("secret", str(context.exception))
        self.assertEqual(self.contents(), self.original)
        diagnostics = json.loads((self.root / ".updates/last-error.json").read_text())
        self.assertTrue(diagnostics["timeout"])
        self.assertEqual(diagnostics["exceptionType"], "TimeoutExpired")
        self.assertIn("secret upstream response", diagnostics["stdoutTail"])
        self.assert_clean_staging()

    def test_failed_step_keeps_bounded_local_diagnostics_and_public_source_error_codes(self):
        def failed_difficulty(args, **kwargs):
            self.calls.append((args, kwargs))
            if Path(args[1]).name == "fetch_team_difficulty.py":
                stage = Path(kwargs["cwd"])
                (stage / "data/team-difficulty.json").write_text(json.dumps({"complete": False, "errors": [
                    {"id": 101, "error": "HTTP Error 429: Too Many Requests", "at": "2026-11-09T01:15:00+03:00",
                     "unexpectedField": "never retain this"}]}))
                return subprocess.CompletedProcess(args, 1, "x" * 4000 + " Saved 0 tournaments, 1 errors",
                                                   str(stage) + " token=do-not-save Bearer hidden-value")
            return subprocess.CompletedProcess(args, 0)

        with self.assertRaises(updater.UpdateError) as caught:
            self.run_update(subprocess_runner=failed_difficulty)
        self.assertNotIn("429", str(caught.exception))
        diagnostic = json.loads((self.root / ".updates/last-error.json").read_text())
        self.assertEqual(diagnostic["step"], 2)
        self.assertEqual(diagnostic["script"], "fetch_team_difficulty.py")
        self.assertEqual(diagnostic["returncode"], 1)
        self.assertLessEqual(len(diagnostic["stdoutTail"]), 2400)
        self.assertIn("<staging>", diagnostic["stderrTail"])
        self.assertNotIn("do-not-save", diagnostic["stderrTail"])
        self.assertNotIn("hidden-value", diagnostic["stderrTail"])
        source = diagnostic["metadataErrors"][0]
        self.assertEqual(source["file"], "data/team-difficulty.json")
        self.assertEqual(source["errorCount"], 1)
        self.assertEqual(source["errors"][0]["httpStatus"], 429)
        self.assertNotIn("unexpectedField", source["errors"][0])
        self.assertEqual(self.contents(), self.original)
        self.assert_clean_staging()

    def test_partial_or_inconsistent_outputs_never_replace_good_snapshot(self):
        mutations = (
            ("dashboard.json", lambda doc: doc["coverage"].update(errors=[{"error": "network"}])),
            ("dashboard.json", lambda doc: doc["coverage"].update(loadedTournaments=0)),
            ("dashboard.json", lambda doc: doc["tournaments"][0].update(score=0)),
            ("dashboard.json", lambda doc: doc["tournaments"][0].update(knownQuestions=1)),
            ("team-difficulty.json", lambda doc: doc.update(complete=False)),
            ("team-intersections.json", lambda doc: doc.update(tournaments=[])),
            ("catalog.json", lambda doc: doc["pagination"].update(terminalEmptyPage=False)),
            ("authors-data.json", lambda doc: doc.update(sourceSnapshotAt="yesterday")),
            ("gotquestions.json", lambda doc: doc["tournaments"].pop()),
            ("played-questions.json", lambda doc: doc.update(sourceHistorySha256="stale")),
            ("registration-training.json", lambda doc: doc["source"]["inputSha256"].update({"data/training.json": "stale"})),
        )
        for filename, mutate in mutations:
            with self.subTest(filename=filename):
                def partial(args, **kwargs):
                    completed = self.runner(args, **kwargs)
                    if Path(args[1]).name == "build_standalone.py":
                        path = Path(kwargs["cwd"]) / "data" / filename
                        doc = json.loads(path.read_text())
                        mutate(doc)
                        path.write_text(json.dumps(doc))
                    return completed

                with self.assertRaises(updater.UpdateError):
                    self.run_update(subprocess_runner=partial)
                self.assertEqual(self.contents(), self.original)
                self.assert_clean_staging()

    def test_successful_script_without_fresh_outputs_is_rejected(self):
        with self.assertRaises(updater.UpdateError):
            self.run_update(subprocess_runner=lambda args, **kw: subprocess.CompletedProcess(args, 0))
        self.assertEqual(self.contents(), self.original)
        self.assert_clean_staging()

    def test_zero_points_and_uncredited_bonus_survive_full_publication(self):
        edit_history(self.root, lambda history: history["tournaments"][0].update(
            rating={"b": 750, "inRating": False}))

        def zero_points(args, **kwargs):
            result = self.runner(args, **kwargs)
            if Path(args[1]).name == "build_standalone.py":
                edit_history(Path(kwargs["cwd"]), lambda history: history["tournaments"][0].update(
                    rating={"b": 0, "inRating": False}))
            return result

        self.assertEqual(self.run_update(subprocess_runner=zero_points)["status"], "success")
        saved = json.loads((self.root / "data/dashboard.json").read_text())
        self.assertEqual(saved["tournaments"][0]["rating"], {"b": 0, "inRating": False})
        self.assertIn('"b": 0, "inRating": false', (self.root / "data.js").read_text())
        self.assert_clean_staging()

    def test_missing_previously_known_points_do_not_publish_even_if_bonus_uncredited(self):
        missing_variants = ("rating-absent", "rating-null", "b-absent", "b-null")
        for old_points in (0, 750):
            for missing in missing_variants:
                with self.subTest(old_points=old_points, source=missing):
                    edit_history(self.root, lambda history: history["tournaments"][0].update(
                        rating={"b": old_points, "inRating": False}))
                    original = self.contents()

                    def missing_points(args, **kwargs):
                        result = self.runner(args, **kwargs)
                        if Path(args[1]).name == "build_standalone.py":
                            def mutate(history):
                                row = history["tournaments"][0]
                                if missing == "rating-absent":
                                    row.pop("rating", None)
                                else:
                                    row["rating"] = {"rating-null": None, "b-absent": {"inRating": False},
                                                     "b-null": {"b": None, "inRating": False}}[missing]
                            edit_history(Path(kwargs["cwd"]), mutate)
                        return result

                    with self.assertRaisesRegex(updater.UpdateError, "ранее известный турнирный балл B"):
                        self.run_update(subprocess_runner=missing_points)
                    self.assertEqual(self.contents(), original)
                    self.assert_clean_staging()

    def test_invalid_points_are_rejected_instead_of_published_as_missing_or_zero(self):
        for points in (True, False, -1, float("nan"), float("inf"), -float("inf"), "1251", {}, []):
            with self.subTest(points=points):
                def invalid_points(args, **kwargs):
                    result = self.runner(args, **kwargs)
                    if Path(args[1]).name == "build_standalone.py":
                        edit_history(Path(kwargs["cwd"]), lambda history: history["tournaments"][0].update(
                            rating={"b": points, "inRating": True}))
                    return result

                with self.assertRaisesRegex(updater.UpdateError, "некорректный турнирный балл B"):
                    self.run_update(subprocess_runner=invalid_points)
                self.assertEqual(self.contents(), self.original)
                self.assert_clean_staging()

    def test_previously_unincluded_game_does_not_require_historical_points(self):
        edit_history(self.root, lambda history: history["tournaments"][0].update(
            included=False, rating={"b": 750, "inRating": True}))
        self.assertEqual(self.run_update()["status"], "success")
        self.assert_clean_staging()

    def test_uncalculated_new_points_remain_explicitly_missing(self):
        for rating in (None, {}, {"b": None, "inRating": False}):
            with self.subTest(rating=rating):
                def uncalculated(args, **kwargs):
                    result = self.runner(args, **kwargs)
                    if Path(args[1]).name == "build_standalone.py":
                        edit_history(Path(kwargs["cwd"]), lambda history: history["tournaments"][0].update(
                            rating=rating))
                    return result

                self.assertEqual(self.run_update(subprocess_runner=uncalculated)["status"], "success")
                saved = json.loads((self.root / "data/dashboard.json").read_text())
                self.assertEqual(saved["tournaments"][0]["rating"], rating)
                self.assert_clean_staging()

    def test_atomic_replace_failure_rolls_back_all_previously_published_files(self):
        replace = updater.os.replace
        failed = False

        def fail_once(source, target):
            nonlocal failed
            if Path(target) == self.root / "catalog-data.js" and not failed:
                failed = True
                raise OSError("simulated write failure")
            return replace(source, target)

        with patch.object(updater.os, "replace", side_effect=fail_once):
            with self.assertRaises(updater.UpdateError):
                self.run_update()
        self.assertTrue(failed)
        self.assertEqual(self.contents(), self.original)
        self.assert_clean_staging()

    def test_progress_observer_failure_does_not_fail_successful_publication(self):
        def broken_observer(event):
            raise OSError("job status cannot be saved")

        result = self.run_update(report=broken_observer)
        self.assertEqual(result["status"], "success")
        self.assertNotEqual(self.contents(), self.original)
        self.assert_clean_staging()

    def test_parallel_source_lanes_overlap_but_join_before_derived_stages(self):
        history_started, training_started = threading.Event(), threading.Event()
        complete = set()
        guard = threading.Lock()

        def parallel_runner(args, **kwargs):
            name = Path(args[1]).name
            if name == "fetch_data.py":
                history_started.set()
                self.assertTrue(training_started.wait(2), "annual retrieval should overlap history")
            if name == "fetch_training.py":
                training_started.set()
                self.assertTrue(history_started.wait(2), "history should overlap annual retrieval")
            if name in ("fetch_gotquestions.py", "fetch_played_questions.py", "fetch_registration_authors.py", "build_standalone.py"):
                with guard:
                    self.assertTrue({"fetch_data.py", "fetch_training.py", "fetch_catalog.py"} <= complete)
            result = self.runner(args, **kwargs)
            with guard:
                complete.add(name)
            return result

        events = []
        result = self.run_update(subprocess_runner=parallel_runner, parallel=True, report=events.append)
        self.assertEqual(result["status"], "success")
        self.assertEqual(set(result["stageSeconds"]), {name for name, _label in updater.STEPS})
        self.assertEqual([event["step"] for event in events], sorted(event["step"] for event in events))
        self.assert_clean_staging()

    def test_source_cooldown_is_carried_across_failed_isolated_refreshes(self):
        def limited(args, **kwargs):
            stage = Path(kwargs["cwd"])
            (stage / ".gq-cooldown.json").write_text('{"untilEpoch":9999999999,"httpStatus":429}')
            return subprocess.CompletedProcess(args, 1)

        with self.assertRaises(updater.UpdateError):
            self.run_update(subprocess_runner=limited)
        self.assertTrue((self.root / ".updates/gotquestions-cooldown.json").exists())
        seen = []

        def next_run(args, **kwargs):
            seen.append((Path(kwargs["cwd"]) / ".gq-cooldown.json").exists())
            return subprocess.CompletedProcess(args, 1)

        with self.assertRaises(updater.UpdateError):
            self.run_update(subprocess_runner=next_run)
        self.assertEqual(seen, [True])
        self.assertEqual(self.contents(), self.original)

    def test_repeated_update_uses_published_cache_and_a_new_clean_staging_tree(self):
        first = self.run_update()
        first_stage = self.calls[0][1]["cwd"]
        first_files = self.contents()
        self.calls = []
        second = self.run_update()
        self.assertEqual(first["status"], second["status"])
        self.assertNotEqual(first_stage, self.calls[0][1]["cwd"])
        after = self.contents()
        # A successful refresh has a new identity even when the source bodies
        # are unchanged; only this verification receipt should differ here.
        self.assertNotEqual(json.loads(after["data/training-year-status.json"])["refreshRunId"],
                            json.loads(first_files["data/training-year-status.json"])["refreshRunId"])
        after.pop("data/training-year-status.json")
        first_files.pop("data/training-year-status.json")
        self.assertEqual(after, first_files)
        self.assert_clean_staging()

    def test_persistent_disk_failure_keeps_backups_and_does_not_claim_complete_rollback(self):
        replace = updater.os.replace
        published = 0

        def fail_write_and_first_restore(source, target):
            nonlocal published
            if Path(target) == self.root / "catalog-data.js":
                raise OSError("simulated persistent write failure")
            if Path(target) == self.root / "data.js":
                published += 1
                if published > 1:
                    raise OSError("simulated persistent restoration failure")
            return replace(source, target)

        with patch.object(updater.os, "replace", side_effect=fail_write_and_first_restore):
            with self.assertRaises(updater.UpdateError) as caught:
                self.run_update()
        self.assertIs(caught.exception.snapshot_preserved, False)
        backups = list((self.root / ".updates/temp").glob("*-backup"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "data.js").read_bytes(), self.original["data.js"])
        self.assertIn("Резервная копия сохранена", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
