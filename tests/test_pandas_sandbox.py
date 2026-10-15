import importlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data_agent"))


class SandboxContractTests(unittest.TestCase):
    def setUp(self):
        try:
            self.sandbox = importlib.import_module("pandas_sandbox")
        except ModuleNotFoundError:
            self.fail("Il confine di esecuzione isolata non è ancora implementato.")

    def test_rifiuta_opzioni_docker_e_percorsi_dal_job(self):
        for extra in ({"image": "other"}, {"mount": "/"}, {"privileged": True}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.sandbox.validate_job({"version": 1, "code": "result = df", "chart": "bar", "filters": {}, **extra})

    def test_codice_pandas_ammesso_ma_non_import_filesystem_rete_o_exec(self):
        self.sandbox.validate_code("result = df.groupby('study_id').size().reset_index(name='value')")
        for code in ("import os", "open('/etc/passwd')", "eval('1')", "df.to_csv('/tmp/x')", "pd.read_csv('x')", "df.__class__", "pd.io.common.os.system('id')"):
            with self.subTest(code=code), self.assertRaises(ValueError):
                self.sandbox.validate_code(code)

    def test_job_valido_preserva_codice_senza_eseguirlo(self):
        job = {"version": 1, "code": "result = df.groupby('study_id').size()", "chart": "bar", "filters": {"study_id": "NNR-PSI-01"}}
        self.assertEqual(self.sandbox.validate_job(job), job)

    def test_rifiuta_immagine_non_immutabile(self):
        with self.assertRaises(ValueError):
            self.sandbox.container_command("docker", "latest", "job", Path("seccomp.json"))

    def test_configurazione_non_pilotabile_con_mount_o_socket(self):
        cmd = self.sandbox.container_command("docker", "sha256:" + "a" * 64, "job", Path("seccomp.json"))
        self.assertIn("--network=none", cmd)
        self.assertIn("--read-only", cmd)
        self.assertIn("--cap-drop=ALL", cmd)
        self.assertIn("--user=65532:65532", cmd)
        self.assertIn("--memory=512m", cmd)
        self.assertIn("--memory-swap=512m", cmd)
        self.assertIn("--pids-limit=32", cmd)
        self.assertFalse(any(x.startswith(("--mount", "--volume", "-v", "--privileged")) for x in cmd))

    def test_output_non_finito_o_png_non_valido_rifiutato(self):
        for value in ({"rows": [{"label": "x", "value": float('nan')}], "png": ""}, {"rows": [{"label": "x", "value": 1}], "png": "eA=="}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.sandbox.validate_output(value)


if __name__ == "__main__":
    unittest.main()
