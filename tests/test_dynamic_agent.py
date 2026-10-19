import importlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data_agent"))


class ExecutorShutdownTests(unittest.TestCase):
    def run_executor(self, queue, body):
        script = "\n".join([
            "import signal, sys",
            "from unittest.mock import patch",
            "import pandas_executor as executor",
            *body,
        ])
        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "data_agent")}
        return subprocess.run(
            [sys.executable, "-c", script, "--queue", str(queue), "--image", "sha256:" + "a" * 64],
            capture_output=True, text=True, timeout=15, env=env,
        )

    def test_segnali_ripetuti_puliscono_la_coda_e_consentono_il_riavvio(self):
        for signum in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=signum), tempfile.TemporaryDirectory() as directory:
                queue = Path(directory)
                for _ in range(2):
                    result = self.run_executor(queue, [
                        f"def stop(_):\n    signal.raise_signal({int(signum)})\n    signal.raise_signal({int(signum)})",
                        "with patch.object(executor.time, 'sleep', side_effect=stop):",
                        "    executor.main()",
                    ])
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(list(queue.iterdir()), [])

    def test_cleanup_incerto_rimuove_ready_ma_conserva_il_blocco(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory)
            request = queue / ("a" * 32 + ".request.json")
            request.write_text("{}", encoding="utf-8")
            result = self.run_executor(queue, [
                "from pandas_sandbox import SandboxCleanupError",
                "with patch.object(executor, 'process_request', side_effect=SandboxCleanupError('cleanup')):",
                "    try:",
                "        executor.main()",
                "    except SandboxCleanupError:",
                "        pass",
            ])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((queue / "executor.ready").exists())
            self.assertTrue((queue / "executor.lock").exists())
            self.assertTrue(request.exists())
            restart = self.run_executor(queue, ["executor.main()"])
            self.assertNotEqual(restart.returncode, 0)
            self.assertIn("FileExistsError", restart.stderr)

    def test_lock_precedente_non_viene_cancellato(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory)
            (queue / "executor.lock").write_text("123", encoding="ascii")
            (queue / "executor.ready").write_text("preesistente", encoding="ascii")
            result = self.run_executor(queue, ["executor.main()"])
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((queue / "executor.lock").read_text(), "123")
            self.assertEqual((queue / "executor.ready").read_text(), "preesistente")

    def test_stop_durante_job_attende_cleanup_e_non_avvia_il_successivo(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory)
            first = queue / ("a" * 32 + ".request.json")
            second = queue / ("b" * 32 + ".request.json")
            first.write_text("{}", encoding="utf-8")
            second.write_text("{}", encoding="utf-8")
            result = self.run_executor(queue, [textwrap.dedent('''
                import io, json
                from types import SimpleNamespace
                import pandas_sandbox as sandbox
                events = []
                png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJawAAAAASUVORK5CYII="
                class Client:
                    returncode = 0
                    def __init__(self, *args, **kwargs):
                        self.stdin = io.BytesIO()
                        self.stdout = io.BytesIO(json.dumps({"rows": [{"label": "x", "value": 1}], "png": png}).encode())
                    def wait(self, **kwargs):
                        signal.raise_signal(signal.SIGTERM)
                        signal.raise_signal(signal.SIGINT)
                        return 0
                    def poll(self):
                        return 0
                    def kill(self):
                        raise AssertionError("Job di prova già terminato.")
                def docker(command, **kwargs):
                    events.append(command)
                    signal.raise_signal(signal.SIGINT)
                    return SimpleNamespace(returncode=0, stdout=b"")
                def job(path, *args):
                    events.append(path.name)
                    output = sandbox.execute_isolated({"version": 1, "code": "result = df", "chart": "bar", "filters": {}}, [], args[0])
                    assert output["rows"] == [{"label": "x", "value": 1}]
                previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
                with patch.object(executor, 'process_request', side_effect=job), patch.object(sandbox.subprocess, 'Popen', Client), patch.object(sandbox.subprocess, 'run', side_effect=docker):
                    executor.main()
                assert previous == {sig: signal.getsignal(sig) for sig in previous}
                print(json.dumps(events))
            ''')])
            self.assertEqual(result.returncode, 0, result.stderr)
            events = json.loads(result.stdout)
            self.assertEqual(events[0], first.name)
            self.assertEqual(events[1][1:3], ["rm", "-f"])
            self.assertEqual(events[2][1:3], ["ps", "-aq"])
            self.assertEqual(events[2][-1], f"name=^/{events[1][-1]}$")
            self.assertEqual(len(events), 3)
            self.assertEqual([path.name for path in queue.iterdir()], [second.name])

    @unittest.skipUnless(os.name == "posix", "Invio SIGTERM/SIGINT al processo disponibile solo su POSIX.")
    def test_segnali_posix_al_processo_e_riavvio(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory)
            for signum in (signal.SIGTERM, signal.SIGINT):
                child = subprocess.Popen([
                    sys.executable, str(Path(__file__).resolve().parents[1] / "data_agent" / "pandas_executor.py"),
                    "--queue", str(queue), "--image", "sha256:" + "a" * 64,
                ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                try:
                    deadline = time.monotonic() + 10
                    while not (queue / "executor.ready").exists():
                        self.assertIsNone(child.poll(), "Esecutore terminato prima della disponibilità.")
                        self.assertLess(time.monotonic(), deadline, "Avvio esecutore scaduto.")
                        time.sleep(0.01)
                    child.send_signal(signum)
                    _, error = child.communicate(timeout=10)
                    self.assertEqual(child.returncode, 0, error.decode())
                    self.assertEqual(list(queue.iterdir()), [])
                finally:
                    if child.poll() is None:
                        child.kill()
                    child.communicate(timeout=5)


class DynamicAgentTests(unittest.TestCase):
    def test_coda_risposta_pronta_correlazione_e_cleanup(self):
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJawAAAAASUVORK5CYII="
        job = {"version": 1, "code": "result = df", "chart": "bar", "filters": {}}
        for problem in (None, "chart", "filters"):
            with self.subTest(problem=problem), tempfile.TemporaryDirectory() as directory:
                queue = Path(directory)
                (queue / "executor.ready").touch()
                packet = {"analysis": "dynamic", "parameters_applied": {"chart": "bar"}, "scope": {"filters": {}},
                          "results": [{"label": "Gruppo sintetico", "value": 2}], "artifacts": [{"data": png}]}
                if problem == "chart":
                    packet["parameters_applied"]["chart"] = "line"
                if problem == "filters":
                    packet["scope"]["filters"] = {"site_id": "SITE_01"}
                identifier = "d" * 32
                response = queue / (identifier + ".response.json")
                response.write_text(json.dumps(packet), encoding="utf-8")
                with patch.object(self.agent.uuid, "uuid4") as uuid:
                    uuid.return_value.hex = identifier
                    if problem:
                        with self.assertRaisesRegex(ValueError, "Risultato non correlato"):
                            self.agent.submit_job(job, queue)
                    else:
                        self.assertEqual(self.agent.submit_job(job, queue), packet)
                self.assertEqual([item.name for item in queue.iterdir()], ["executor.ready"])

    def setUp(self):
        try:
            self.agent = importlib.import_module("dynamic_agent")
            self.executor = importlib.import_module("pandas_executor")
        except ModuleNotFoundError:
            self.fail("Agente dinamico ed esecutore separato non implementati.")

    def test_generazione_http_controllata_preserva_solo_codice(self):
        import httpx
        def transport(request):
            body = json.loads(request.content)
            self.assertEqual(body["model"], "openai/gpt-oss-120b")
            self.assertNotIn("tools", body)
            self.assertNotIn("records", body)
            return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"code": "result = df.groupby('study_id').size().reset_index(name='value').rename(columns={'study_id':'label'})"})}}], "usage": {"total_tokens": 100}})
        with httpx.Client(transport=httpx.MockTransport(transport)) as client:
            code, usage = self.agent.generate_code("Conta per studio", "bar", ["study_id"], api_key="synthetic_qa_key", client=client)
        self.assertIn("groupby", code)
        self.assertEqual(usage, {"total_tokens": 100})

    def test_generazione_rifiutata_troncata_e_codice_pericoloso(self):
        import httpx
        for response in (httpx.Response(429), httpx.Response(200, json={"choices": [{"finish_reason": "length", "message": {"content": "{}"}}]}), httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": '{"code":"import os"}'}}]})):
            with self.subTest(response=response.status_code), httpx.Client(transport=httpx.MockTransport(lambda r: response)) as client, self.assertRaises(ValueError):
                self.agent.generate_code("Analisi", "bar", ["study_id"], api_key="synthetic_qa_key", client=client)

    def test_generazione_line_conserva_il_codice_valido_senza_eseguirlo(self):
        import httpx
        expected = "result = df.rename(columns={'month':'period','study_id':'series'}).assign(label=df['month'])[['label','value','period','series']]"
        def transport(request):
            body = json.loads(request.content)
            scope = json.loads(body["messages"][1]["content"])
            self.assertEqual(scope["chart"], "line")
            self.assertEqual(scope["columns"], ["study_id", "month", "value"])
            self.assertNotIn("records", scope)
            return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"code": expected})}}]})
        with httpx.Client(transport=httpx.MockTransport(transport)) as client:
            code, _ = self.agent.generate_code("Arruolamenti mensili per studio", "line", ["study_id", "month", "value"], api_key="synthetic_qa_key", client=client)
        self.assertEqual(code, expected)

    def test_prompt_line_espone_un_esempio_validato_e_i_limiti_ast(self):
        import re
        import httpx
        from pandas_protocol import validate_code
        prompts = {}
        for chart in ("bar", "line"):
            def transport(request):
                prompts[chart] = json.loads(request.content)["messages"][0]["content"]
                return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": '{"code":"result = df"}'}}]})
            with httpx.Client(transport=httpx.MockTransport(transport)) as client:
                self.agent.generate_code("Arruolamenti mensili per studio", chart, [], api_key="synthetic_qa_key", client=client)
        self.assertEqual(prompts["bar"], self.agent.PROMPT)
        line = prompts["line"][len(prompts["bar"]):]
        for instruction in ("lambda", "sort_values", "nunique", "dropna", "screening_failure", "period", "series"):
            self.assertIn(instruction, line)
        example = re.search(r"```python\n(.*?)\n```", line, re.DOTALL)
        self.assertIsNotNone(example, "Manca un esempio line verificabile con il validatore reale.")
        validate_code(example.group(1))

    def test_line_con_costrutti_vietati_restituisce_400_prima_della_coda(self):
        import httpx
        from fastapi.testclient import TestClient
        import app
        for code in ("import os", "def count():\n return 1", "result = df.assign(value=lambda x: 1)"):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                queue = Path(directory)
                (queue / "executor.ready").touch()
                packet = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"code": code})}}]}
                with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=packet))) as provider:
                    with patch.dict("os.environ", {"TRIALPULSE_PANDAS_ENABLED": "1", "GROQ_API_KEY": "synthetic_qa_key"}), patch.object(self.agent, "QUEUE", queue), patch.object(self.agent.httpx, "Client", return_value=provider), patch.object(self.agent, "submit_job") as submit:
                        response = TestClient(app.app).post("/analyze", json={"analysis": "dynamic", "question": "Arruolamenti mensili per studio", "chart": "line"})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json(), {"detail": "Operazione non consentita nel codice generato."})
                submit.assert_not_called()
                self.assertFalse(list(queue.glob("*.request.json")))

    def test_quota_429_strutturata_senza_body_o_segreti(self):
        import httpx
        response = httpx.Response(429, headers={"x-ratelimit-remaining-tokens": "10", "x-ratelimit-reset-tokens": "4.5s"}, json={"error": "contenuto_riservato_non_esponibile"})
        with httpx.Client(transport=httpx.MockTransport(lambda request: response)) as client:
            try:
                self.agent.generate_code("Conta per studio", "bar", [], api_key="synthetic_qa_key", client=client)
            except self.agent.GenerationError as error:
                self.assertEqual(error.quota, {"model": "openai/gpt-oss-120b", "remaining": 10, "reset_seconds": 4.5})
                self.assertNotIn("contenuto_riservato", str(error))
                self.assertNotIn("synthetic_qa_key", str(error))
            else:
                self.fail("Il rate limit non deve produrre un risultato.")

    def test_esecutore_non_accetta_job_con_parametri_host(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ("a" * 32 + ".request.json")
            path.write_text(json.dumps({"version": 1, "code": "result = df", "chart": "bar", "filters": {}, "mount": "/"}), encoding="utf-8")
            with patch.object(self.executor, "execute_isolated") as isolated:
                self.executor.process_request(path, "sha256:" + "a" * 64)
                self.assertFalse(isolated.called)
            result = json.loads(path.with_name("a" * 32 + ".response.json").read_text())
            self.assertEqual(result, {"error": "Analisi dinamica non completata in sicurezza."})

    def test_filtri_esecutore_applicati_prima_del_container(self):
        from data_loader import load_analytic_dataset
        df, quality = load_analytic_dataset()
        records = self.executor.filtered_records(df, {"study_id": "NNR-ESK-02"})
        self.assertEqual(len(records), 456)
        self.assertTrue(all(row["study_id"] == "NNR-ESK-02" for row in records))
        with self.assertRaises(ValueError):
            self.executor.filtered_records(df, {"study_id": "UNKNOWN"})

    def test_esecutore_assente_fail_closed_senza_eseguire_codice(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            self.agent.submit_job({"version": 1, "code": "result = df", "chart": "bar", "filters": {}}, Path(directory), timeout=0.02)

    def test_api_dinamica_disabilitata_e_payload_extra_rifiutati(self):
        from fastapi.testclient import TestClient
        import app
        client = TestClient(app.app)
        with patch.dict("os.environ", {"TRIALPULSE_PANDAS_ENABLED": "0"}):
            self.assertEqual(client.post("/analyze", json={"analysis": "dynamic", "question": "Conta per studio", "chart": "bar"}).status_code, 400)
        self.assertEqual(client.post("/analyze", json={"analysis": "dynamic", "question": "Conta per studio", "chart": "bar", "code": "import os"}).status_code, 422)

    def test_cleanup_non_verificabile_arresta_esecutore(self):
        from pandas_sandbox import SandboxCleanupError
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ("b" * 32 + ".request.json")
            path.write_text(json.dumps({"version": 1, "code": "result = df", "chart": "bar", "filters": {}}), encoding="utf-8")
            with patch.object(self.executor, "execute_isolated", side_effect=SandboxCleanupError("cleanup")), self.assertRaises(SandboxCleanupError):
                self.executor.process_request(path, "sha256:" + "a" * 64)

    def test_risposta_tardiva_senza_richiesta_non_viene_scritta(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ("c" * 32 + ".request.json")
            path.write_text(json.dumps({"version": 1, "code": "result = df", "chart": "bar", "filters": {}}), encoding="utf-8")
            def cancel(*args):
                path.unlink()
                raise ValueError("timeout")
            with patch.object(self.executor, "execute_isolated", side_effect=cancel):
                self.executor.process_request(path, "sha256:" + "a" * 64)
            self.assertFalse(path.with_name("c" * 32 + ".response.json").exists())

    def test_envelope_corrotto_della_coda_produce_errore_controllato(self):
        for payload in ("null", "[]", '"string"', "{}"):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as directory:
                queue = Path(directory)
                (queue / "executor.ready").touch()
                def reply():
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline:
                        paths = list(queue.glob("*.request.json"))
                        if paths:
                            paths[0].with_name(paths[0].name.replace(".request.", ".response.")).write_text(payload, encoding="utf-8")
                            return
                        time.sleep(0.01)
                worker = threading.Thread(target=reply)
                worker.start()
                try:
                    with self.assertRaises(ValueError):
                        self.agent.submit_job({"version": 1, "code": "result = df", "chart": "bar", "filters": {}}, queue, timeout=2)
                finally:
                    worker.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
