import hashlib
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data_agent"))

from data_loader import load_analytic_dataset  # noqa: E402


CSV = ROOT / "data" / "trialpulse_operations.csv"
EXPECTED_SHA256 = "3f9ad9042443eeecf70071132b87032f2564a6dba4b3d81f01efb18bd8aff7ec"


class DataLoaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.df, cls.quality = load_analytic_dataset(CSV)

    def test_row_counts(self):
        self.assertEqual(self.quality["physical_rows"], 1508)
        self.assertEqual(self.quality["logical_rows"], 1500)
        self.assertEqual(self.quality["duplicates_removed"], 8)

    def test_status_normalization(self):
        values = self.df["participant_status"].dropna().astype(str)
        self.assertTrue(values.eq(values.str.strip().str.lower()).all())
        self.assertEqual(self.quality["normalized_values"], 15)

    def test_dirty_dates(self):
        self.assertEqual(self.quality["inconsistent_actual_dates"], 15)

    def test_dirty_queries(self):
        self.assertEqual(self.quality["inconsistent_query_rows"], 3)

    def test_dates_parse(self):
        self.assertEqual(sum(self.quality["unparseable_dates"].values()), 0)

    def test_csv_hash(self):
        digest = hashlib.sha256(CSV.read_bytes()).hexdigest()
        self.assertEqual(digest, EXPECTED_SHA256)


if __name__ == "__main__":
    unittest.main()