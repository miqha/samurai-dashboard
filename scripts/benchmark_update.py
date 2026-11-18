#!/usr/bin/env python3
"""Offline replay of the old and current update schedulers on identical records.

This is a controlled, time-scaled network profile, not a live-site speed claim.
No HTTP requests are made and the saved dashboard is never changed. Supply the
preserved pre-change scripts directory with --baseline. The output records the
source/code hashes, profile, transferred bytes, requests and measured wall time.
"""
import argparse
import ast
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from test_update_dashboard import UpdateRunnerTests, write_snapshot, NOW
from gotquestions_public import extract_pack
from refresh_http import read_payload
import refresh_http
import update_dashboard
from dashboard_time import MOSCOW

BASELINE_ADAPTER = "At load time only MOSCOW = ZoneInfo('Europe/Moscow') is bound to the portable dashboard UTC+3 timezone; preserved baseline bytes and hash are unchanged."


def load_module(path):
    spec = importlib.util.spec_from_file_location("baseline_update", path)
    module = importlib.util.module_from_spec(spec)
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    bindings = [node for node in tree.body if isinstance(node, ast.Assign)
                and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == "MOSCOW"
                and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                and node.value.func.id == "ZoneInfo" and not node.value.keywords
                and len(node.value.args) == 1 and isinstance(node.value.args[0], ast.Constant)
                and node.value.args[0].value == "Europe/Moscow"]
    if len(bindings) != 1:
        raise ValueError("The preserved baseline timezone binding differs from the expected source")
    bindings[0].value = ast.copy_location(ast.Name(id="_SAMURAI_BENCHMARK_MOSCOW", ctx=ast.Load()), bindings[0].value)
    module.__dict__["_SAMURAI_BENCHMARK_MOSCOW"] = MOSCOW
    # Compile once: no initial execution or retry with partially imported state.
    exec(compile(ast.fix_missing_locations(tree), str(path), "exec"), module.__dict__)
    module.__dict__.pop("_SAMURAI_BENCHMARK_MOSCOW")
    return module


def digest(payload):
    return hashlib.sha256(payload).hexdigest()


def captured_workload(root):
    read = lambda name: json.loads((root / "data" / name).read_text(encoding="utf-8"))
    history, year, played, bridge, calendar = [read(name) for name in
        ("dashboard.json", "training-year-catalog.json", "played-questions-catalog.json", "gotquestions.json", "catalog.json")]
    resources, metadata, results, overlaps = {}, [], [], []
    def resource(key, value, pack=False):
        if pack:
            flight = "5:" + json.dumps({"pack": value}, ensure_ascii=False, separators=(",", ":"))
            payload = ("<script>self.__next_f.push(" + json.dumps([1, flight], ensure_ascii=False) + ")</script>").encode()
        else:
            payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        resources[key] = {"body": payload, "gzip": gzip.compress(payload), "pack": pack,
                          "id": value["id"] if pack else None}
        return key
    initial = [resource(name, read("raw/" + name + ".json")["data"]) for name in ("team", "tournaments")]
    for row in history["tournaments"]:
        tid = row["id"]
        metadata.append(resource(f"meta/{tid}", read(f"raw/{tid}-meta.json")["data"]))
        results.append(resource(f"results/{tid}", read(f"raw/{tid}-results.json")["data"]))
    for row in read("team-intersections.json")["tournaments"]:
        overlaps.append(resource(f"intersections/{row['id']}", row))
    year_ids = {row["id"] for row in year["packages"]}
    included = {row["id"] for row in history["tournaments"] if row.get("included")}
    needed = {pid for row in bridge["tournaments"] if row["tournamentId"] in included for pid in row.get("packetIds", [])}
    needed |= {row["id"] for row in played["packages"] if set(row.get("tIds", [])) & included}
    for identifier in sorted(year_ids | needed):
        annual = root / f"data/training-year-sources/packs/{identifier}.json"
        own = root / f"data/played-question-sources/packs/{identifier}.json"
        cached = json.loads((annual if annual.exists() else own).read_text(encoding="utf-8"))
        resource(f"pack/{identifier}", cached["pack"], pack=True)
    def pages(name, rows):
        # Preserve actual captured catalogue contents and pagination; the public
        # search's dynamic page chrome is intentionally excluded in both runs.
        return [resource(name + "/" + str(index), rows[index * 100:(index + 1) * 100])
                for index in range((len(rows) + 99) // 100 + 1)]
    return resources, {"initial": initial, "metadata": metadata, "results": results, "overlaps": overlaps,
        "calendar": pages("calendar", calendar["tournaments"]),
        "annualSearch": pages("annual-search", year["packages"]),
        "playedSearch": pages("played-search", played["packages"]),
        "annualPacks": [f"pack/{identifier}" for identifier in sorted(year_ids)],
        "playedPacks": [f"pack/{identifier}" for identifier in sorted(needed)],
        "oldPlayedFetches": [f"pack/{identifier}" for identifier in sorted(needed - year_ids)],
        "homepage": [resource("homepage", {"status": "reachable"})]}


def save_capture(path, resources, workload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps({"workload": workload,
            "resources": {key: {"pack": row["pack"], "id": row["id"], "sha256": digest(row["body"])}
                          for key, row in resources.items()}}, ensure_ascii=False))
        for key, row in resources.items():
            archive.writestr("records/" + key + ".json", row["body"])


def load_capture(path):
    resources = {}
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        for key, row in manifest["resources"].items():
            body = archive.read("records/" + key + ".json")
            if digest(body) != row["sha256"]:
                raise ValueError("Captured benchmark record integrity mismatch")
            resources[key] = {"body": body, "gzip": gzip.compress(body), "pack": row["pack"], "id": row["id"]}
    return resources, manifest["workload"]


class Replay:
    def __init__(self, resources, workload, *, optimized, scale, latency, bandwidth):
        self.resources, self.workload = resources, workload
        self.optimized, self.scale, self.latency, self.bandwidth = optimized, scale, latency, bandwidth
        self.requests, self.bytes, self.decoded_bytes, self.receipts = 0, 0, 0, {}
        self.lock = threading.Lock()

    def batch(self, keys, interval, workers):
        next_start = 0.0
        pacer = threading.Lock()
        def fetch(key):
            nonlocal next_start
            with pacer:
                delay = max(0, next_start - time.monotonic())
                next_start = max(time.monotonic(), next_start) + interval * self.scale
            if delay:
                time.sleep(delay)
            row = self.resources[key]
            wire = row["gzip"] if self.optimized else row["body"]
            # Fixed profile is identical; only HTTP compression and the actual
            # scheduler/request changes differ between the two implementations.
            time.sleep((self.latency + len(wire) / self.bandwidth) * self.scale)
            response = io.BytesIO(wire)
            response.headers = {"Content-Encoding": "gzip"} if self.optimized else {}
            body = read_payload(response, 40_000_000) if self.optimized else response.read()
            if row["pack"]:
                parsed = extract_pack(body.decode(), row["id"])
            else:
                parsed = json.loads(body)
            value_hash = digest(json.dumps(parsed, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())
            with self.lock:
                self.requests += 1
                self.bytes += len(wire)
                self.decoded_bytes += len(body)
                self.receipts[key] = value_hash
        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(fetch, keys))

    def runner(self, args, **options):
        name = Path(args[1]).name
        w = self.workload
        if name == "fetch_data.py":
            self.batch(w["initial"], 1.25, 1)
            self.batch(w["metadata"] + w["results"], 1.25, 5)
        elif name == "fetch_team_difficulty.py" and "--reuse-refreshed-metadata" not in args:
            self.batch(w["metadata"], 1.25, 4)
        elif name == "fetch_team_intersections.py":
            self.batch(w["overlaps"], 1.25, 4)
        elif name == "fetch_catalog.py":
            self.batch(w["calendar"], 1.25, 1)
            if "--reuse-refreshed-history" not in args:
                self.batch([w["initial"][1]], 1.25, 1)
        elif name == "fetch_gotquestions.py":
            self.batch(w["homepage"], 0, 1)
        elif name == "fetch_training.py":
            self.batch(w["annualSearch"], 2, 1)
            self.batch(w["annualPacks"], .5 if self.optimized else 1.3, 3)
        elif name == "fetch_played_questions.py":
            self.batch(w["playedSearch"], 1.5, 1)
            if self.optimized:
                self.batch(w["oldPlayedFetches"], .5, 3)
            else:
                fetched = set(w["oldPlayedFetches"])
                for index, key in enumerate(w["playedPacks"]):
                    if index:
                        time.sleep(1.3 * self.scale)
                    if key in fetched:
                        self.batch([key], 0, 1)
        elif name == "build_standalone.py":
            write_snapshot(Path(options["cwd"]))
        return subprocess.CompletedProcess(args, 0, "offline replay", "")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=ROOT / "benchmarks/baseline", help="Preserved pre-change updater directory")
    parser.add_argument("--inputs", type=Path, default=ROOT / ".checks/update-benchmark-inputs.zip")
    parser.add_argument("--capture-current", action="store_true", help="Replace replay inputs with the current saved public records")
    parser.add_argument("--output", type=Path, default=ROOT / ".checks/update-benchmark.json")
    parser.add_argument("--scale", type=float, default=.02)
    parser.add_argument("--latency", type=float, default=.25, help="Simulated request latency before body, seconds")
    parser.add_argument("--bandwidth", type=float, default=1_000_000, help="Simulated bytes/second for each connection")
    args = parser.parse_args()
    if not 0 < args.scale <= 1 or args.latency < 0 or args.bandwidth <= 0:
        parser.error("Invalid replay network profile")
    if args.capture_current or not args.inputs.exists():
        resources, workload = captured_workload(ROOT)
        save_capture(args.inputs, resources, workload)
    else:
        resources, workload = load_capture(args.inputs)
    baseline_file = args.baseline / "update_dashboard.py"
    baseline = load_module(baseline_file)
    results, receipts = {}, {}
    for label, module, optimized in (("before", baseline, False), ("after", update_dashboard, True)):
        case = UpdateRunnerTests(); case.setUp()
        replay = Replay(resources, workload, optimized=optimized, scale=args.scale, latency=args.latency, bandwidth=args.bandwidth)
        clock = time.perf_counter()
        try:
            module.run_update(root=case.root, subprocess_runner=replay.runner, now=NOW)
            wall = time.perf_counter() - clock
            results[label] = {"wallSeconds": round(wall, 3), "requests": replay.requests,
                              "transferBytes": replay.bytes, "decodedBytes": replay.decoded_bytes}
            receipts[label] = replay.receipts
        finally:
            case.tearDown()
    if receipts["before"] != receipts["after"]:
        raise ValueError("Parsed source records differ between old and new replay")
    document = {"measuredAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scope": "Offline, time-scaled captured-record replay through the preserved old and current updater schedulers; not live end-to-end timing",
        "baselineAdapter": BASELINE_ADAPTER,
        "profile": {"timeScale": args.scale, "latencySeconds": args.latency, "bytesPerSecondPerConnection": args.bandwidth,
                    "conditional304Responses": 0, "gotQuestionsStartsPerSecondBefore": 1 / 1.3,
                    "gotQuestionsStartsPerSecondAfter": 2, "gotQuestionsWorkers": 3,
                    "ratingStartIntervalSeconds": 1.25},
        "limitations": ["Public record bodies are captured locally; dynamic site HTML is excluded identically in both runs.",
                        "Network latency, throughput and sleeps are scaled; Python parsing, staging and validation run at real speed.",
                        "Derived-output fixture validates transactional scheduler behavior, not a second live data collection.",
                        "All pack bodies are rechecked with 200 responses; no credit is taken for possible 304 responses."],
        "workload": {name: len(keys) for name, keys in workload.items()},
        "inputBundle": {"file": str(args.inputs.relative_to(ROOT)) if args.inputs.is_relative_to(ROOT) else str(args.inputs),
                        "sha256": digest(args.inputs.read_bytes())},
        "sourceRecords": {key: {"sha256": digest(row["body"]), "bytes": len(row["body"]), "gzipBytes": len(row["gzip"])} for key, row in resources.items()},
        "codeSha256": {"before": digest(baseline_file.read_bytes()), "after": digest(Path(update_dashboard.__file__).read_bytes()),
                       "http": digest(Path(refresh_http.__file__).read_bytes()), "replay": digest(Path(__file__).read_bytes())},
        "results": results, "sameParsedRecords": True,
        "speedup": round(results["before"]["wallSeconds"] / results["after"]["wallSeconds"], 3)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "results": results, "offlineReplaySpeedup": document["speedup"], "sameParsedRecords": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
