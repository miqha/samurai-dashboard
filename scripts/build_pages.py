#!/usr/bin/env python3
"""Validate a saved snapshot and prepare an isolated GitHub Pages artifact.

No network or credentials are needed. Only assets referenced by index.html,
ECharts' license and the published catalog reach the artifact. The release hash
covers those assets and runtime settings; generated release metadata cannot hash
itself, and its publication timestamp deliberately does not change the version.
"""

import argparse
from datetime import date, datetime, timezone
import hashlib
from html import escape, unescape
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
from urllib.parse import unquote, urlsplit

from update_dashboard import validate_snapshot

ROOT = Path(__file__).resolve().parents[1]
BUILD_TOOL = "samurai-pages-v1"
ADDITIONAL_ASSETS = ("vendor/ECHARTS-LICENSE.txt", "data/catalog.json")
REPOSITORY_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+\Z")


class PagesBuildError(ValueError):
    """The input or destination is unsafe or incomplete."""


class _References(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.assets = []
        self.script_position = None

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "script":
            if self.script_position is None:
                self.script_position = self.getpos()
            if attrs.get("src"):
                self.assets.append(attrs["src"])
        elif tag == "link" and "stylesheet" in attrs.get("rel", "").lower().split():
            if attrs.get("href"):
                self.assets.append(attrs["href"])


def _asset_path(root, reference):
    """Accept only simple relative local URLs, never arbitrary filesystem reads."""
    parsed = urlsplit(reference)
    path = PurePosixPath(unquote(parsed.path))
    if (parsed.scheme or parsed.netloc or parsed.query or parsed.fragment
            or not parsed.path or path.is_absolute() or ".." in path.parts
            or "\\" in parsed.path or "\x00" in parsed.path):
        raise PagesBuildError(f"Unsupported public asset URL: {reference!r}")
    relative = path.as_posix()
    source = root / relative
    if not source.is_file() or source.is_symlink() or root not in source.resolve().parents:
        raise PagesBuildError(f"Missing or unsafe public asset: {relative}")
    if source.suffix not in (".js", ".css"):
        raise PagesBuildError(f"Unexpected public asset type: {relative}")
    return relative


def public_asset_paths(root=ROOT):
    """Return the explicit public source allowlist, also usable by exporters."""
    root = Path(root).resolve()
    parser = _References()
    parser.feed((root / "index.html").read_text(encoding="utf-8"))
    assets = {_asset_path(root, reference) for reference in parser.assets}
    for name in ADDITIONAL_ASSETS:
        path = root / name
        if not path.is_file() or path.is_symlink() or root not in path.resolve().parents:
            raise PagesBuildError(f"Missing or unsafe public asset: {name}")
        assets.add(name)
    return tuple(sorted(assets))


def _inject_configuration(html):
    parser = _References()
    parser.feed(html)
    if parser.script_position is None:
        raise PagesBuildError("index.html contains no scripts")
    if "site-config.js" in parser.assets:
        raise PagesBuildError("Source index.html must keep its local configuration")
    line, column = parser.script_position
    position = sum(len(row) for row in html.splitlines(keepends=True)[:line - 1]) + column
    return html[:position] + '<script src="site-config.js"></script>\n  ' + html[position:]



def _version_assets(html, version):
    """Give every executable/style URL this release's cache key."""
    def replace_tag(match):
        tag = match.group(0)
        parser = _References()
        parser.feed(tag)
        if not parser.assets:
            return tag
        reference = parser.assets[0]
        def replace_attribute(attr):
            value = attr.group(3) if attr.group(2) else attr.group(4)
            if unescape(value) != reference:
                return attr.group(0)
            quote = attr.group(2) or '"'
            return attr.group(1) + quote + escape(reference + "?v=" + version, quote=True) + quote
        return re.sub(r"(\b(?:src|href)\s*=\s*)(?:([\"'])(.*?)\2|([^\s\"'=<>`]+))",
                      replace_attribute, tag, flags=re.IGNORECASE | re.DOTALL)
    return re.sub(r"<(?:script|link)\b[^>]*>", replace_tag, html, flags=re.IGNORECASE)


def actions_url(repository):
    if not repository:
        return None
    if not REPOSITORY_PATTERN.fullmatch(repository) or repository.split("/", 1)[1] in (".", ".."):
        raise PagesBuildError("Repository must have the form OWNER/REPO")
    return f"https://github.com/{repository}/actions/workflows/pages.yml"


def _timestamp(value):
    try:
        instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError) as error:
        raise PagesBuildError("Publication time must be an ISO timestamp with timezone") from error
    if instant.tzinfo is None:
        raise PagesBuildError("Publication time must include a timezone")
    return instant.astimezone(timezone.utc).isoformat(timespec="seconds")


def _destination(root, output):
    target = Path(output)
    if not target.is_absolute():
        target = root / target
    if target.is_symlink():
        raise PagesBuildError("The artifact destination cannot be a symbolic link")
    target = target.resolve()
    protected = [root, *(root / name for name in ("data", "scripts", "tests", "vendor", "bootstrap", ".github", ".updates", ".checks"))]
    if target in root.parents or any(target == path or path in target.parents for path in protected[1:]) or target == root:
        raise PagesBuildError("The artifact destination overlaps project sources")
    if target.exists():
        if not target.is_dir():
            raise PagesBuildError("The artifact destination is not a directory")
        if any(target.iterdir()):
            try:
                manifest = json.loads((target / "site-manifest.json").read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                raise PagesBuildError("Refusing to replace a nonempty directory not created by build_pages.py") from error
            if manifest.get("buildTool") != BUILD_TOOL:
                raise PagesBuildError("Refusing to replace a directory not created by build_pages.py")
    return target


def validate_saved_snapshot(root=ROOT):
    root = Path(root).resolve()
    history = json.loads((root / "data/dashboard.json").read_text(encoding="utf-8"))
    cutoff = history.get("cutoff")
    if not isinstance(cutoff, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", cutoff):
        raise PagesBuildError("Snapshot cutoff must have the form YYYY-MM-DD")
    try:
        date.fromisoformat(cutoff)
    except ValueError as error:
        raise PagesBuildError("Snapshot cutoff is not a real date") from error
    validate_snapshot(root, history, cutoff)
    return history


def build_pages(root=ROOT, output="_site", repository=None, published_at=None):
    root = Path(root).resolve()
    target = _destination(root, output)
    repository = repository if repository is not None else os.environ.get("GITHUB_REPOSITORY")
    action_link = actions_url(repository)
    history = validate_saved_snapshot(root)
    assets = public_asset_paths(root)
    html = _inject_configuration((root / "index.html").read_text(encoding="utf-8"))
    configuration = {"mode": "static", "actionsUrl": action_link,
                     "dataUpdatedAt": history["fetchedAt"], "cutoff": history["cutoff"]}
    digest = hashlib.sha256()
    content = [("index.html", html.encode("utf-8")),
               ("runtime-settings", json.dumps(configuration, sort_keys=True, separators=(",", ":")).encode("utf-8"))]
    content.extend((name, (root / name).read_bytes()) for name in assets)
    for name, payload in content:
        # Length framing avoids ambiguous concatenations of names and contents.
        encoded_name = name.encode("utf-8")
        digest.update(len(encoded_name).to_bytes(8, "big")); digest.update(encoded_name)
        digest.update(len(payload).to_bytes(8, "big")); digest.update(payload)
    configuration["version"] = digest.hexdigest()
    html = _version_assets(html, configuration["version"])
    manifest = {**configuration, "publishedAt": _timestamp(published_at or datetime.now(timezone.utc).isoformat()),
                "buildTool": BUILD_TOOL}
    target.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{target.name}-build-", dir=target.parent))
    backup = None
    keep_backup = False
    try:
        for name in assets:
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / name, destination)
        (stage / "index.html").write_text(html, encoding="utf-8")
        (stage / "site-config.js").write_text("window.SAMURAI_SITE=" + json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
        (stage / "site-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (stage / ".nojekyll").write_text("", encoding="utf-8")
        if target.exists():
            backup = Path(tempfile.mkdtemp(prefix=f".{target.name}-previous-", dir=target.parent))
            backup.rmdir()
            os.replace(target, backup)
        try:
            os.replace(stage, target)
        except OSError as error:
            if backup is not None:
                try:
                    os.replace(backup, target)
                except OSError:
                    keep_backup = True
                    raise PagesBuildError(f"Cannot restore the previous artifact; recovery copy retained at {backup}") from error
                backup = None
            raise
    finally:
        shutil.rmtree(stage, ignore_errors=True)
        if backup is not None and not keep_backup:
            shutil.rmtree(backup, ignore_errors=True)
    return {"output": str(target), "files": len(assets) + 4, **manifest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--validate-only", action="store_true", help="Check the complete saved snapshot without building an artifact")
    parser.add_argument("--output", default="_site", help="Artifact directory; relative to project root")
    parser.add_argument("--repository", help="GitHub OWNER/REPO, otherwise GITHUB_REPOSITORY")
    parser.add_argument("--published-at", help="Override UTC publication timestamp for reproducible checks")
    args = parser.parse_args()
    try:
        if args.validate_only:
            history = validate_saved_snapshot()
            result = {"status": "valid", "cutoff": history["cutoff"], "dataUpdatedAt": history["fetchedAt"]}
        else:
            result = build_pages(output=args.output, repository=args.repository, published_at=args.published_at)
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        parser.exit(1, f"Pages build failed: {error}\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
