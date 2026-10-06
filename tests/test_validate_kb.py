"""Controlli del validator con copie temporanee del DRAFT, senza toccare gli originali."""

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)
        for directory in ("knowledge_base", "scripts", "data_agent/config", "data"):
            shutil.copytree(ROOT / directory, self.root / directory)

    def validate(self):
        return subprocess.run(
            [sys.executable, "-X", "utf8", str(self.root / "scripts/validate_kb.py")],
            capture_output=True, text=True, encoding="utf-8",
        )

    def replace(self, relative, old, new):
        path = self.root / relative
        content = path.read_text(encoding="utf-8")
        self.assertIn(old, content)
        path.write_text(content.replace(old, new, 1), encoding="utf-8")

    def test_accepts_current_documents(self):
        result = self.validate()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_external_reference_in_ingest(self):
        self.replace("knowledge_base/manifest.yaml", "exclude:",
                     "  - docs/references/kb_plausibility_notes.md\nexclude:")
        self.assertNotEqual(self.validate().returncode, 0)

    def test_rejects_wrong_week6_window_even_if_other_row_matches(self):
        self.replace("knowledge_base/reference/visit_schedule_windows.md",
                     "| Week 6 | +42 | **±4 giorni** |",
                     "| Week 6 | +42 | **±3 giorni** |")
        self.replace("knowledge_base/reference/visit_schedule_windows.md",
                     "| Week 3 | +21 | ±3 giorni |",
                     "| Week 3 | +21 | ±4 giorni |")
        self.assertNotEqual(self.validate().returncode, 0)

    def test_rejects_target_day_different_from_config(self):
        self.replace("knowledge_base/reference/visit_schedule_windows.md",
                     "| Week 6 | +42 | **±4 giorni** |",
                     "| Week 6 | +43 | **±4 giorni** |")
        self.assertNotEqual(self.validate().returncode, 0)


if __name__ == "__main__":
    unittest.main()
