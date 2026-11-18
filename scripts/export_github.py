#!/usr/bin/env python3
"""Create a clean, browser-uploadable repository folder from a local snapshot."""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MARKER = ".samurai-github-export.json"
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


def export_github(root=ROOT, destination=None):
    from restore_bootstrap import allowed_path
    from update_dashboard import GENERATED, validate_snapshot

    root = Path(root).resolve()
    destination = Path(destination or root.parent / "samurai-dashboard-github").resolve()
    if (destination == root or root in destination.parents or destination in root.parents
            or destination.is_symlink()):
        raise ValueError("Выберите отдельную папку рядом с проектом.")
    if destination.exists():
        raise ValueError("Папка экспорта уже существует: выберите новое имя, чтобы сохранить её содержимое.")
    history = json.loads((root / "data/dashboard.json").read_text(encoding="utf-8"))
    validate_snapshot(root, history, history["cutoff"])
    generated = set(GENERATED) - {"samurai-dashboard.html"}
    seed = {name: root / name for name in generated}
    for path in (root / "data").rglob("*"):
        name = path.relative_to(root).as_posix()
        if path.is_file() and allowed_path(name, generated):
            seed[name] = path
    if any(path.is_symlink() for path in seed.values()):
        raise ValueError("В начальном снимке найдены ссылки вместо обычных файлов.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="samurai-export-", dir=destination.parent) as directory:
        stage = Path(directory) / "repository"
        stage.mkdir()
        # Copy a small explicit source set. User/runtime/browser files can never
        # accidentally become part of the repository or its published artifact.
        for pattern in ("*.js", "*.css", "index.html", "*.md", "*.command", "*.cmd", ".gitignore"):
            for path in root.glob(pattern):
                if path.is_file() and path.name not in generated:
                    shutil.copy2(path, stage / path.name)
        for name in ("scripts", "tests", "vendor", "benchmarks", ".github"):
            shutil.copytree(root / name, stage / name,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store", "*.tmp"))
        bootstrap = stage / "bootstrap"
        bootstrap.mkdir()
        archive = bootstrap / "snapshot.tar.gz"
        records = {}
        with archive.open("wb") as output, gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|") as tar:
                for name, path in sorted(seed.items()):
                    payload = path.read_bytes()
                    records[name] = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
                    entry = tarfile.TarInfo(name)
                    entry.size, entry.mtime, entry.mode = len(payload), 0, 0o644
                    tar.addfile(entry, io.BytesIO(payload))
        manifest = {"format": 1, "cutoff": history["cutoff"], "dataUpdatedAt": history["fetchedAt"],
                    "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "files": records}
        (bootstrap / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (stage / MARKER).write_text(json.dumps({"format": 1, "cutoff": history["cutoff"]}) + "\n", encoding="utf-8")
        oversized = [path.relative_to(stage).as_posix() for path in stage.rglob("*")
                     if path.is_file() and path.stat().st_size > MAX_UPLOAD_BYTES]
        if oversized:
            raise ValueError("Файлы превышают лимит браузерной загрузки GitHub: " + ", ".join(oversized))
        if not (stage / ".github/workflows/pages.yml").is_file():
            raise ValueError("Не найдена конфигурация публикации Pages.")
        seed_bytes = archive.stat().st_size
        shutil.move(str(stage), str(destination))
    return {"directory": str(destination), "seedBytes": seed_bytes, "seedFiles": len(records)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    print(json.dumps(export_github(destination=args.output), ensure_ascii=False))
