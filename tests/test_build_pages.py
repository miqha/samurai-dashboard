"""Offline release checks: complete input, clean output and safe replacement."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build_pages as P
from test_update_dashboard import write_snapshot, write_derived


class PagesBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="samurai-pages-test-")
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()
        write_snapshot(self.root)
        (self.root / "index.html").write_text('<!doctype html>\n<html><head>\n<link rel="stylesheet" href="style.css">\n</head><body>\n  <script src="vendor/chart.js"></script>\n  <script src="data.js"></script>\n  <script src="app.js"></script>\n</body></html>\n', encoding="utf-8")
        (self.root / "style.css").write_text("body{color:#123}", encoding="utf-8")
        (self.root / "app.js").write_text("window.app=true;", encoding="utf-8")
        (self.root / "vendor").mkdir()
        (self.root / "vendor/chart.js").write_text("window.chart=true;", encoding="utf-8")
        (self.root / "vendor/ECHARTS-LICENSE.txt").write_text("Apache license", encoding="utf-8")
        for relative in ("data/raw/private.json", ".updates/last-error.json", ".checks/test.txt", "scripts/source.py", "unused.js"):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("not a public asset", encoding="utf-8")
        self.published = "2026-11-17T12:00:00+03:00"

    def tearDown(self):
        self.temp.cleanup()

    def build(self, **kwargs):
        return P.build_pages(self.root, repository="Samurai/dashboard", published_at=self.published, **kwargs)

    def contents(self, root):
        return {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob("*") if path.is_file()}

    def test_only_allowlisted_assets_are_published_and_config_precedes_every_script(self):
        original_index = (self.root / "index.html").read_bytes()
        result = self.build()
        output = self.root / "_site"
        names = set(self.contents(output))
        self.assertEqual(names, {"index.html", "style.css", "vendor/chart.js", "vendor/ECHARTS-LICENSE.txt", "data.js", "app.js", "data/catalog.json", "site-config.js", "site-manifest.json", ".nojekyll"})
        self.assertEqual(result["files"], len(names))
        self.assertEqual((self.root / "index.html").read_bytes(), original_index)
        html = (output / "index.html").read_text()
        self.assertLess(html.index('src="site-config.js?v='), html.index('src="vendor/chart.js?v='))
        self.assertNotIn('src="/', html)
        manifest = json.loads((output / "site-manifest.json").read_text())
        self.assertEqual(manifest["mode"], "static")
        self.assertEqual(manifest["actionsUrl"], "https://github.com/Samurai/dashboard/actions/workflows/pages.yml")
        self.assertEqual(manifest["publishedAt"], "2026-11-17T09:00:00+00:00")
        self.assertEqual(manifest["dataUpdatedAt"], "2026-11-09T01:15:00+03:00")
        self.assertEqual(manifest["cutoff"], "2026-11-09")
        self.assertRegex(manifest["version"], r"^[0-9a-f]{64}$")
        for reference in ("style.css", "site-config.js", "vendor/chart.js", "data.js", "app.js"):
            self.assertIn(reference + "?v=" + manifest["version"], html)
        script = (output / "site-config.js").read_text()
        self.assertEqual(json.loads(script.removeprefix("window.SAMURAI_SITE=").removesuffix(";\n")), manifest)

    def test_version_is_stable_but_covers_styles_data_html_and_settings(self):
        first = self.build()
        second = P.build_pages(self.root, output="other", repository="Samurai/dashboard", published_at="2026-11-18T00:00:00Z")
        self.assertEqual(first["version"], second["version"])
        (self.root / "style.css").write_text("body{color:red}")
        changed_style = self.build()
        self.assertNotEqual(first["version"], changed_style["version"])
        (self.root / "data/catalog.json").write_text((self.root / "data/catalog.json").read_text() + "\n")
        write_derived(self.root)
        changed_data = self.build()
        self.assertNotEqual(changed_style["version"], changed_data["version"])
        (self.root / "index.html").write_text((self.root / "index.html").read_text().replace("<body>", '<body class="new">'))
        changed_html = self.build()
        self.assertNotEqual(changed_data["version"], changed_html["version"])
        changed_settings = P.build_pages(self.root, repository="Another/dashboard", published_at=self.published)
        self.assertNotEqual(changed_html["version"], changed_settings["version"])

    def test_incomplete_snapshot_leaves_previous_artifact_intact(self):
        self.build()
        original = self.contents(self.root / "_site")
        (self.root / "data.js").write_text("window.SAMURAI_DATA={};")
        with self.assertRaises(RuntimeError):
            self.build()
        self.assertEqual(self.contents(self.root / "_site"), original)
        self.assertEqual(list(self.root.glob("._site-*")), [])

    def test_failed_publish_restores_previous_artifact(self):
        self.build()
        original = self.contents(self.root / "_site")
        (self.root / "style.css").write_text("body{color:green}")
        replace = os.replace

        def fail_publish(source, destination):
            if "-build-" in Path(source).name and Path(destination).resolve() == (self.root / "_site").resolve():
                raise OSError("simulated disk failure")
            return replace(source, destination)

        with patch.object(P.os, "replace", side_effect=fail_publish):
            with self.assertRaises(OSError):
                self.build()
        self.assertEqual(self.contents(self.root / "_site"), original)
        self.assertEqual(list(self.root.glob("._site-*")), [])

    def test_persistent_disk_failure_keeps_recovery_copy(self):
        self.build()
        original = self.contents(self.root / "_site")
        replace = os.replace

        def fail_after_backup(source, destination):
            if Path(destination).resolve() == (self.root / "_site").resolve():
                raise OSError("persistent disk failure")
            return replace(source, destination)

        with patch.object(P.os, "replace", side_effect=fail_after_backup):
            with self.assertRaisesRegex(P.PagesBuildError, "recovery copy retained"):
                self.build()
        backups = list(self.root.glob("._site-previous-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(self.contents(backups[0]), original)

    def test_unquoted_and_single_quoted_asset_urls_receive_release_version(self):
        path = self.root / "index.html"
        path.write_text(path.read_text().replace('src="app.js"', "src=app.js").replace('href="style.css"', "href='style.css'"))
        result = self.build()
        html = (self.root / "_site/index.html").read_text()
        self.assertIn('src="app.js?v=' + result["version"] + '"', html)
        self.assertIn("href='style.css?v=" + result["version"] + "'", html)

    def test_refuses_to_replace_sources_or_unrelated_directory(self):
        for output in (self.root, self.root.parent, self.root / "data/new", self.root / "scripts", self.root / "vendor/site", self.root / "bootstrap/site"):
            with self.subTest(output=output), self.assertRaises(P.PagesBuildError):
                self.build(output=output)
        unrelated = self.root / "unrelated"
        unrelated.mkdir()
        (unrelated / "keep.txt").write_text("keep")
        with self.assertRaises(P.PagesBuildError):
            self.build(output=unrelated)
        self.assertEqual((unrelated / "keep.txt").read_text(), "keep")

    def test_rejects_remote_traversal_query_and_symlink_assets(self):
        template = (self.root / "index.html").read_text()
        for reference in ("https://example.com/app.js", "//example.com/app.js", "../app.js", "/app.js", "%2e%2e/app.js", "app.js?x=1", "app.js#fragment"):
            (self.root / "index.html").write_text(template.replace('src="app.js"', f'src="{reference}"'))
            with self.subTest(reference=reference), self.assertRaises(P.PagesBuildError):
                self.build()
        (self.root / "index.html").write_text(template)
        (self.root / "app.js").unlink()
        (self.root / "app.js").symlink_to(self.root / "vendor/chart.js")
        with self.assertRaises(P.PagesBuildError):
            self.build()

    def test_repository_links_are_bounded_and_optional(self):
        for repository in ("https://github.com/x/y", "owner/repo?token=a", "owner/repo#main", "owner/repo/extra", "owner/..", "owner/.", "a@github.com/repo", "a b/repo"):
            with self.subTest(repository=repository), self.assertRaises(P.PagesBuildError):
                P.actions_url(repository)
        self.assertIsNone(P.actions_url(None))
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "owner/repo"}):
            result = P.build_pages(self.root, published_at=self.published)
        self.assertEqual(result["actionsUrl"], "https://github.com/owner/repo/actions/workflows/pages.yml")
        with self.assertRaises(P.PagesBuildError):
            P.build_pages(self.root, repository="owner/repo", published_at="2026-11-17T12:00:00")

    def test_no_source_script_and_unrelated_destination_symlink_are_rejected(self):
        (self.root / "index.html").write_text("<html></html>")
        with self.assertRaises(P.PagesBuildError):
            self.build()
        destination = self.root / "link"
        destination.symlink_to(self.root / "data", target_is_directory=True)
        with self.assertRaises(P.PagesBuildError):
            self.build(output=destination)


if __name__ == "__main__":
    unittest.main()
