import importlib
import io
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

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

    def test_errore_arresto_client_non_salta_la_rimozione_container(self):
        job = {"version": 1, "code": "result = df", "chart": "bar", "filters": {}}
        process = Mock(stdin=Mock(closed=False), stdout=io.BytesIO())
        process.stdin.write.side_effect = BrokenPipeError()
        process.poll.return_value = None
        process.wait.side_effect = subprocess.TimeoutExpired("docker", 5)
        calls = []

        def docker(command, **kwargs):
            calls.append(command)
            return SimpleNamespace(returncode=0, stdout=b"")

        with patch.object(self.sandbox.subprocess, "Popen", return_value=process), patch.object(self.sandbox.subprocess, "run", side_effect=docker):
            with self.assertRaises(self.sandbox.SandboxCleanupError):
                self.sandbox.execute_isolated(job, [], "sha256:" + "a" * 64)
        self.assertEqual([command[1:3] for command in calls], [["rm", "-f"], ["ps", "-aq"]])
        self.assertEqual(calls[1][-1], f"name=^/{calls[0][-1]}$")

    def test_cleanup_docker_non_confermato_non_restituisce_risultati(self):
        job = {"version": 1, "code": "result = df", "chart": "bar", "filters": {}}
        for failure in ("rm", "ps", "residuo", "timeout"):
            with self.subTest(failure=failure):
                process = Mock(stdin=io.BytesIO(), stdout=io.BytesIO(), returncode=1)
                process.poll.return_value = 1

                def docker(command, **kwargs):
                    if failure == "timeout":
                        raise subprocess.TimeoutExpired(command, 10)
                    return SimpleNamespace(
                        returncode=int(command[1] == failure),
                        stdout=b"container" if failure == "residuo" else b"",
                    )

                with patch.object(self.sandbox.subprocess, "Popen", return_value=process), patch.object(self.sandbox.subprocess, "run", side_effect=docker):
                    with self.assertRaises(self.sandbox.SandboxCleanupError):
                        self.sandbox.execute_isolated(job, [], "sha256:" + "a" * 64)


if __name__ == "__main__":
    unittest.main()
