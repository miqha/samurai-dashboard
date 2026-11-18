"""Calendar refresh must keep training presets and question metadata in sync."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import serve
import update_dashboard as U
from test_update_dashboard import write_snapshot, edit_history


class CalendarSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        for name in [x[0] for x in U.STEPS] + list(U.SCRIPT_DEPENDENCIES):
            (self.root / 'scripts' / name).write_text('# fixed source\n')
        (self.root / 'index.html').write_text('<html></html>')
        (self.root / 'vendor').mkdir()
        write_snapshot(self.root)
        edit_history(self.root, lambda h: h['tournaments'][0].update(name='Test tournament'))
        path = self.root / 'data/played-questions-catalog.json'
        doc = json.loads(path.read_text()); doc['packages'] = []; path.write_text(json.dumps(doc))
        self.catalog = json.loads((self.root / 'data/catalog.json').read_text())
        self.catalog['fetchedAt'] = '2026-11-10T12:00:00+00:00'
        self.catalog['teamHistoryCheckedAt'] = self.catalog['fetchedAt']
        self.original = self.contents()

    def tearDown(self):
        self.temp.cleanup()

    def contents(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*')
                if p.is_file() and '.updates' not in p.parts}

    def build_html(self, stage):
        (stage / 'samurai-dashboard.html').write_text('<html><script>window.SAMURAI_DATA={};</script></html>')

    def test_success_rebuilds_calendar_dependents_preserving_history_and_training(self):
        with patch.object(serve, 'build_standalone', side_effect=self.build_html):
            response = serve.refresh_catalog_snapshot(self.root, bundle=self.catalog)
        saved = json.loads((self.root / 'data/catalog.json').read_text())
        self.assertEqual(saved, self.catalog)
        self.assertNotIn('_registrationTraining', saved, 'Live transport data cannot change source hashes')
        preset = json.loads((self.root / 'data/registration-training.json').read_text())
        self.assertEqual(response['_registrationTraining'], preset)
        self.assertEqual(preset['source']['catalogFetchedAt'], saved['fetchedAt'])
        self.assertEqual(preset['source']['inputSha256']['data/catalog.json'], hashlib.sha256((self.root / 'data/catalog.json').read_bytes()).hexdigest())
        for name in ('data/dashboard.json', 'data.js', 'data/training.json', 'training-data.js',
                     'data/training-year-catalog.json'):
            self.assertEqual(self.original[name], (self.root / name).read_bytes())
        history = json.loads((self.root / 'data/dashboard.json').read_text())
        U.validate_snapshot(self.root, history, history['cutoff'])
        self.assertEqual(list((self.root / '.updates/temp').iterdir()), [])

    def test_failed_preset_rebuild_preserves_original_catalog_and_every_companion(self):
        with patch.object(serve, 'build_presets', side_effect=ValueError('Unavailable registration authors')):
            with self.assertRaises(ValueError):
                serve.refresh_catalog_snapshot(self.root, bundle=self.catalog)
        self.assertEqual(self.contents(), self.original)
        self.assertEqual(list((self.root / '.updates/temp').iterdir()), [])


if __name__ == '__main__':
    unittest.main()
