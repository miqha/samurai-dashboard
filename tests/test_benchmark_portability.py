"""The optional preserved-baseline replay must not require Windows tzdata."""
import hashlib
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfoNotFoundError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import benchmark_update as B
from dashboard_time import MOSCOW


class BenchmarkPortabilityTests(unittest.TestCase):
    def test_baseline_loads_once_without_iana_data_and_preserves_exact_source(self):
        path = ROOT / "benchmarks/baseline/update_dashboard.py"
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        with patch("zoneinfo.ZoneInfo", side_effect=ZoneInfoNotFoundError("No Windows IANA database")) as lookup:
            loaded = B.load_module(path)
        lookup.assert_not_called()
        self.assertIs(loaded.MOSCOW, MOSCOW)
        self.assertTrue(callable(loaded.run_update))
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        self.assertNotIn("_SAMURAI_BENCHMARK_MOSCOW", loaded.__dict__)


if __name__ == "__main__":
    unittest.main()
