"""A real exported checkout restores without network and preserves current data."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from export_github import export_github
from restore_bootstrap import restore_bootstrap
from update_dashboard import GENERATED, validate_snapshot


class GithubExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="samurai-export-test-")
        cls.exported = Path(cls.temporary.name) / "repository"
        export_github(ROOT, cls.exported)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def copy_export(self, name):
        result = Path(self.temporary.name) / name
        shutil.copytree(self.exported, result)
        self.addCleanup(shutil.rmtree, result, True)
        return result

    def test_upload_contains_workflow_and_no_large_or_runtime_files(self):
        self.assertTrue((self.exported / ".github/workflows/pages.yml").is_file())
        self.assertTrue((self.exported / ".gitignore").is_file())
        for name in (".updates", ".checks", "data", "samurai-dashboard.html", "training-data.js"):
            self.assertFalse((self.exported / name).exists(), name)
        self.assertTrue(all(p.stat().st_size < 25 * 1024 * 1024 for p in self.exported.rglob("*") if p.is_file()))

    def test_offline_roundtrip_and_idempotency(self):
        root = self.copy_export("roundtrip")
        result = restore_bootstrap(root)
        self.assertTrue(result["restored"])
        history = json.loads((root / "data/dashboard.json").read_text())
        validate_snapshot(root, history, history["cutoff"])
        for name in GENERATED:
            if name != "samurai-dashboard.html":
                self.assertEqual((root / name).read_bytes(), (ROOT / name).read_bytes(), name)
        current = root / "data/dashboard.json"
        # A complete later local snapshot must never be reset to bootstrap.
        current.write_bytes(current.read_bytes() + b"\n")
        digest = hashlib.sha256(current.read_bytes()).hexdigest()
        self.assertFalse(restore_bootstrap(root)["restored"])
        self.assertEqual(hashlib.sha256(current.read_bytes()).hexdigest(), digest)

    def test_corruption_does_not_publish_partial_snapshot(self):
        root = self.copy_export("corrupted")
        archive = root / "bootstrap/snapshot.tar.gz"
        archive.write_bytes(archive.read_bytes() + b"corrupted")
        with self.assertRaisesRegex(ValueError, "целостность"):
            restore_bootstrap(root)
        self.assertFalse((root / "data/dashboard.json").exists())
        self.assertFalse((root / "training-data.js").exists())

    def test_traversal_in_manifest_does_not_write_outside_root(self):
        root = self.copy_export("traversal")
        path = root / "bootstrap/manifest.json"
        manifest = json.loads(path.read_text())
        manifest["files"]["../escaped.txt"] = {"bytes": 0, "sha256": hashlib.sha256(b"").hexdigest()}
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "недопустимые"):
            restore_bootstrap(root)
        self.assertFalse((root.parent / "escaped.txt").exists())
        self.assertFalse((root / "data/dashboard.json").exists())

    def test_partial_current_snapshot_is_never_overwritten(self):
        root = self.copy_export("partial")
        current = root / "data.js"
        current.write_text("preserve me")
        with self.assertRaisesRegex(ValueError, "неполный"):
            restore_bootstrap(root)
        self.assertEqual(current.read_text(), "preserve me")
        self.assertFalse((root / "data/dashboard.json").exists())


if __name__ == "__main__":
    unittest.main()
