#!/usr/bin/env python3
"""Restore the bundled public seed once, without replacing a newer snapshot."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MAX_SEED_BYTES = 512 * 1024 * 1024


def allowed_path(name, generated):
    path = PurePosixPath(name)
    return (not path.is_absolute() and str(path) == name
            and all(part not in (".", "..", "") and not part.startswith(".") for part in path.parts)
            and "\\" not in name
            and (name in generated or (path.parts[0] == "data" and path.suffix in (".json", ".txt", ".html"))))


def restore_bootstrap(root=ROOT):
    from build_standalone import main as build_standalone
    from update_dashboard import GENERATED, _publish, validate_snapshot

    root = Path(root).resolve()
    archive = root / "bootstrap/snapshot.tar.gz"
    if not archive.exists():
        return {"restored": False, "reason": "no-bootstrap"}
    generated = set(GENERATED) - {"samurai-dashboard.html"}
    present = [name for name in generated if (root / name).exists()]
    if len(present) == len(generated):
        if not (root / "samurai-dashboard.html").is_file():
            build_standalone(root)
        return {"restored": False, "reason": "snapshot-present"}
    # Source caches alone may be present. Never combine an incomplete current
    # output snapshot with an older baseline, however.
    anchors = {name for name in generated if not name.startswith("data/")} | {"data/dashboard.json"}
    if anchors.intersection(present):
        raise ValueError("Найден неполный снимок. Сохраните копию папки и выполните полное обновление; исходные данные не заменены.")
    manifest = json.loads((archive.parent / "manifest.json").read_text(encoding="utf-8"))
    if (manifest.get("format") != 1 or hashlib.sha256(archive.read_bytes()).hexdigest() != manifest.get("archiveSha256")
            or not isinstance(manifest.get("files"), dict) or not generated <= manifest["files"].keys()):
        raise ValueError("Не удалось подтвердить целостность начального снимка.")
    expected = manifest["files"]
    if not all(allowed_path(name, generated) and isinstance(record, dict)
               and type(record.get("bytes")) is int and record["bytes"] >= 0
               and isinstance(record.get("sha256"), str) for name, record in expected.items()):
        raise ValueError("В начальном снимке недопустимые пути или размеры файлов.")
    if sum(record["bytes"] for record in expected.values()) > MAX_SEED_BYTES:
        raise ValueError("Начальный снимок превышает допустимый размер.")
    parent = root / ".updates/temp"
    parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bootstrap-", dir=parent) as directory:
        stage = Path(directory)
        with tarfile.open(archive, "r:gz") as source:
            seen = set()
            for member in source:
                if (member.name in seen or member.name not in expected or not member.isfile()
                        or member.size != expected[member.name]["bytes"]):
                    raise ValueError("Начальный снимок содержит неподтверждённый файл.")
                seen.add(member.name)
                stream = source.extractfile(member)
                payload = stream.read(member.size + 1)
                if len(payload) != member.size or hashlib.sha256(payload).hexdigest() != expected[member.name]["sha256"]:
                    raise ValueError("Файл начального снимка повреждён.")
                target = stage / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(payload)
            if seen != set(expected):
                raise ValueError("Начальный снимок неполон.")
        # Render and check the baseline with current code before changing any
        # files in the user's copy. Only public source assets enter this stage.
        for pattern in ("*.js", "*.css", "index.html"):
            for path in root.glob(pattern):
                if path.is_file() and path.name not in generated:
                    shutil.copy2(path, stage / path.name)
        shutil.copytree(root / "vendor", stage / "vendor")
        build_standalone(stage)
        history = json.loads((stage / "data/dashboard.json").read_text(encoding="utf-8"))
        validate_snapshot(stage, history, history["cutoff"])
        files = [name for name in expected if not (root / name).exists()]
        files.append("samurai-dashboard.html")
        _publish(root, stage, files=files)
    return {"restored": True, "files": len(files), "cutoff": history["cutoff"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        print(json.dumps(restore_bootstrap(args.root), ensure_ascii=False))
    except (OSError, ValueError, tarfile.TarError) as error:
        parser.exit(1, f"Не удалось восстановить начальный снимок: {error}\n")


if __name__ == "__main__":
    main()
