"""Collaudi reali opt-in, senza LLM e senza mount dell'host."""
import base64
import json
import os
import subprocess
import tempfile
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data_agent"))
from pandas_sandbox import container_command, docker_environment, execute_isolated

IMAGE = os.environ.get("TRIALPULSE_SANDBOX_IMAGE")
DOCKER = os.environ.get("TRIALPULSE_DOCKER", "docker")


@unittest.skipUnless(IMAGE, "Immagine Docker non configurata: test reale non eseguito.")
class DockerIsolationTests(unittest.TestCase):
    def test_sorgenti_leggibili_dall_utente_non_root(self):
        result = self.probe(
            "import os,json,stat; "
            "paths=['/app/pandas_protocol.py','/app/runner.py']; "
            "print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),"
            "'files':[{'path':path,'mode':stat.S_IMODE(os.stat(path).st_mode),"
            "'readable':bool(open(path,'rb').read()),'writable':os.access(path,os.W_OK)} "
            "for path in paths]}))"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "uid": 65532, "gid": 65532,
            "files": [
                {"path": "/app/pandas_protocol.py", "mode": 0o644, "readable": True, "writable": False},
                {"path": "/app/runner.py", "mode": 0o644, "readable": True, "writable": False},
            ],
        })

    def test_executor_pubblica_solo_output_validato_dal_confine_docker(self):
        import pandas_executor
        valid = "participants = df.loc[df['screening_failure'].eq(False)]\nresult = participants.groupby('study_id')['participant_id'].nunique().reset_index(name='value').rename(columns={'study_id':'label'})"
        for code in (valid, "result = df.head(0)"):
            with self.subTest(valid=code == valid), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                request = root / ("e" * 32 + ".request.json")
                request.write_text(json.dumps({"version": 1, "code": code, "chart": "bar", "filters": {}}), encoding="utf-8")
                with patch.object(pandas_executor, "__file__", str(root / "pandas_executor.py")):
                    pandas_executor.process_request(request, IMAGE, DOCKER)
                response = json.loads(request.with_name("e" * 32 + ".response.json").read_text(encoding="utf-8"))
                if code == valid:
                    self.assertEqual(response["results"], [{"label": "NNR-DXB-03", "value": 44}, {"label": "NNR-ESK-02", "value": 32},
                                                           {"label": "NNR-PSI-01", "value": 36}, {"label": "NNR-SER-04", "value": 42}])
                    chart = root / "generated_charts" / ("e" * 32 + ".png")
                    self.assertEqual(chart.read_bytes(), base64.b64decode(response["artifacts"][0]["data"]))
                else:
                    self.assertEqual(response, {"error": "Analisi dinamica non completata in sicurezza."})
                    self.assertFalse((root / "generated_charts").exists())

    def probe(self, code, timeout=20):
        name = "trialpulse-pandas-probe-" + uuid.uuid4().hex
        cmd = container_command(DOCKER, IMAGE, name)
        cmd[-1:-1] = ["--entrypoint=python"]
        cmd += ["-I", "-B", "-c", code]
        try:
            return subprocess.run(cmd, capture_output=True, timeout=timeout, env=docker_environment())
        finally:
            subprocess.run([DOCKER, "rm", "-f", name], check=True, capture_output=True, timeout=10)
            remaining = subprocess.run([DOCKER, "ps", "-aq", "--filter", f"name=^/{name}$"], check=True, capture_output=True, timeout=10)
            self.assertEqual(remaining.stdout.strip(), b"")

    def test_identita_limiti_capabilities_seccomp_e_segreti(self):
        os.environ["TRIALPULSE_SECRET_CANARY"] = "canary_not_a_real_secret"
        try:
            result = self.probe("import os,json,resource; print(json.dumps({'uid':os.getuid(),'memory':open('/sys/fs/cgroup/memory.max').read().strip(),'cpu':open('/sys/fs/cgroup/cpu.max').read().strip(),'pids':open('/sys/fs/cgroup/pids.max').read().strip(),'rlimit':resource.getrlimit(resource.RLIMIT_CPU),'status':open('/proc/self/status').read().splitlines(),'canary':'TRIALPULSE_SECRET_CANARY' in os.environ,'socket':os.path.exists('/var/run/docker.sock'),'env':sorted(os.environ)}))")
        finally:
            os.environ.pop("TRIALPULSE_SECRET_CANARY", None)
        self.assertEqual(result.returncode, 0, result.stderr)
        fields = json.loads(result.stdout)
        self.assertEqual(fields["uid"], 65532)
        self.assertEqual(fields["memory"], "536870912")
        self.assertEqual(fields["cpu"], "100000 100000")
        self.assertEqual(fields["pids"], "32")
        self.assertEqual(fields["rlimit"], [10, 10])
        self.assertFalse(fields["canary"] or fields["socket"])
        for line in ("CapEff:\t0000000000000000", "NoNewPrivs:\t1", "Seccomp:\t2"):
            self.assertIn(line, fields["status"])
        # GPG_KEY nell'immagine ufficiale è un fingerprint pubblico, non un segreto host.
        self.assertFalse(any(("KEY" in x or "TOKEN" in x or "SECRET" in x) and x != "GPG_KEY" for x in fields["env"]))

    def test_socket_rete_dns_e_metadata_non_accessibili(self):
        result = self.probe("import socket,json; denied=[]\nfor family in (socket.AF_INET,socket.AF_INET6,socket.AF_UNIX):\n try: socket.socket(family); denied.append(False)\n except PermissionError: denied.append(True)\nprint(json.dumps(denied))")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [True, True, True])

    def test_filesystem_host_non_montato_e_root_readonly(self):
        result = self.probe("import os,json; denied=False\ntry: open('/app/overwrite','w')\nexcept OSError: denied=True\nprint(json.dumps({'readonly':denied,'host':os.path.exists('/host'),'env':os.path.exists('/app/.env'),'tmp':os.statvfs('/tmp').f_blocks*os.statvfs('/tmp').f_frsize}))")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"readonly": True, "host": False, "env": False, "tmp": 67108864})

    def test_limite_memoria_reale(self):
        result = self.probe("x=bytearray(1024*1024*1024)")
        self.assertEqual(result.returncode, 137)

    def test_limite_cpu_reale(self):
        result = self.probe("while True: pass", timeout=18)
        self.assertEqual(result.returncode, 137)

    def test_timeout_termina_intero_job(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.probe("import time; time.sleep(60)", timeout=2)

    def test_limite_processi_reale(self):
        result = self.probe("import os,time,json; pids=[]\ntry:\n for i in range(100):\n  pid=os.fork()\n  if pid==0: time.sleep(15); os._exit(0)\n  pids.append(pid)\nexcept OSError: print(json.dumps({'limit':True,'spawned':len(pids)}),flush=True)\nfor pid in pids: os.kill(pid,9); os.waitpid(pid,0)")
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertTrue(value["limit"])
        self.assertLess(value["spawned"], 32)

    def test_pandas_png_bar_line_e_determinismo(self):
        records = [{"study_id": "A", "participant_id": "1"}, {"study_id": "A", "participant_id": "1"}, {"study_id": "B", "participant_id": "2"}]
        code = "result = df.groupby('study_id')['participant_id'].nunique().reset_index(name='value').rename(columns={'study_id':'label'})"
        job = {"version": 1, "code": code, "chart": "bar", "filters": {}}
        first = execute_isolated(job, records, IMAGE, DOCKER)
        self.assertEqual(first["rows"], [{"label": "A", "value": 1}, {"label": "B", "value": 1}])
        self.assertTrue(base64.b64decode(first["png"]).startswith(b"\x89PNG"))
        self.assertEqual(execute_isolated(job, records, IMAGE, DOCKER), first)
        job["chart"] = "line"
        records = [{"study_id": "A", "month": "2026-01", "value": 2}, {"study_id": "B", "month": "2026-01", "value": 3}, {"study_id": "A", "month": "2026-02", "value": 4}]
        job["code"] = "result = df.rename(columns={'study_id':'series','month':'period'}).assign(label=df['month'] + ' ' + df['study_id'])[['label','value','period','series']]"
        line = execute_isolated(job, records, IMAGE, DOCKER)
        self.assertEqual(line["rows"], [{"label": "2026-01 A", "value": 2, "period": "2026-01", "series": "A"}, {"label": "2026-01 B", "value": 3, "period": "2026-01", "series": "B"}, {"label": "2026-02 A", "value": 4, "period": "2026-02", "series": "A"}])
        self.assertNotEqual(line["png"], first["png"])

    def test_arruolamenti_csv_ufficiale_in_parita_con_ground_truth(self):
        from data_loader import load_analytic_dataset
        from pandas_executor import filtered_records
        df, quality = load_analytic_dataset()
        code = "participants = df.loc[df['screening_failure'].eq(False)]\nresult = participants.groupby('study_id')['participant_id'].nunique().reset_index(name='value').rename(columns={'study_id':'label'})"
        job = {"version": 1, "code": code, "chart": "bar", "filters": {}}
        result = execute_isolated(job, filtered_records(df, {}), IMAGE, DOCKER)
        self.assertEqual(result["rows"], [{"label": "NNR-DXB-03", "value": 44}, {"label": "NNR-ESK-02", "value": 32}, {"label": "NNR-PSI-01", "value": 36}, {"label": "NNR-SER-04", "value": 42}])
        self.assertEqual(quality["duplicates_removed"], 8)

    def test_recruitment_temporale_per_studio_sito_sul_csv(self):
        from data_loader import load_analytic_dataset
        from pandas_executor import filtered_records
        df, quality = load_analytic_dataset()
        code = """participants = df.loc[df['screening_failure'].eq(False)].drop_duplicates(subset=['study_id','participant_id']).dropna(subset=['enrollment_date']).copy()
participants['period'] = participants['enrollment_date'].dt.strftime('%Y-%m')
result = participants.groupby(['period','study_id','site_id'])['participant_id'].nunique().reset_index(name='value')
result['series'] = result['study_id'] + ' ' + result['site_id']
result['label'] = result['period'] + ' ' + result['series']
result = result[['label','value','period','series']]"""
        result = execute_isolated({"version": 1, "code": code, "chart": "line", "filters": {"study_id": "NNR-ESK-02"}}, filtered_records(df, {"study_id": "NNR-ESK-02"}), IMAGE, DOCKER)
        self.assertEqual(sum(row["value"] for row in result["rows"]), 32)
        self.assertTrue(all(row["series"].startswith("NNR-ESK-02 SITE_") for row in result["rows"]))
        self.assertEqual(len({(row["period"], row["series"]) for row in result["rows"]}), len(result["rows"]))

    def test_line_con_mesi_non_ordinati_preserva_valori_senza_inventare_mesi(self):
        records = [{"study_id": "A", "month": "2026-03", "value": 4}, {"study_id": "B", "month": "2026-02", "value": 3}, {"study_id": "A", "month": "2026-01", "value": 2}]
        code = "result = df.rename(columns={'study_id':'series','month':'period'}).assign(label=df['month'] + ' ' + df['study_id'])[['label','value','period','series']]"
        output = execute_isolated({"version": 1, "code": code, "chart": "line", "filters": {}}, records, IMAGE, DOCKER)
        self.assertEqual(output["rows"], [{"label": "2026-03 A", "value": 4, "period": "2026-03", "series": "A"}, {"label": "2026-02 B", "value": 3, "period": "2026-02", "series": "B"}, {"label": "2026-01 A", "value": 2, "period": "2026-01", "series": "A"}])
        self.assertTrue(base64.b64decode(output["png"]).startswith(b"\x89PNG"))

    def test_line_rifiuta_periodi_duplicati_e_troppe_serie(self):
        code = "result = df.rename(columns={'study_id':'series','month':'period'}).assign(label=df['month'])[['label','value','period','series']]"
        cases = [[{"study_id": "A", "month": "2026-01", "value": 1}] * 2,
                 [{"study_id": str(index), "month": "2026-01", "value": 1} for index in range(13)]]
        for records in cases:
            with self.subTest(rows=len(records)), self.assertRaises(ValueError):
                execute_isolated({"version": 1, "code": code, "chart": "line", "filters": {}}, records, IMAGE, DOCKER)

    def test_recruitment_lineare_mensile_portfolio_preserva_i_quattro_totali(self):
        from data_loader import load_analytic_dataset
        from pandas_executor import filtered_records
        frame, _ = load_analytic_dataset()
        code = """participants = df.loc[df['screening_failure'].eq(False)].drop_duplicates(subset=['study_id','participant_id']).dropna(subset=['enrollment_date']).copy()
participants['period'] = participants['enrollment_date'].dt.strftime('%Y-%m')
result = participants.groupby(['period','study_id'])['participant_id'].nunique().reset_index(name='value').rename(columns={'study_id':'series'})
result['label'] = result['period'] + ' ' + result['series']
result = result[['label','value','period','series']]"""
        output = execute_isolated({"version": 1, "code": code, "chart": "line", "filters": {}}, filtered_records(frame, {}), IMAGE, DOCKER)
        totals = {}
        for row in output["rows"]:
            totals[row["series"]] = totals.get(row["series"], 0) + row["value"]
        self.assertEqual(totals, {"NNR-DXB-03": 44, "NNR-ESK-02": 32, "NNR-PSI-01": 36, "NNR-SER-04": 42})
        self.assertEqual(len({(row["period"], row["series"]) for row in output["rows"]}), len(output["rows"]))

    def test_esempio_del_prompt_line_conta_partecipanti_e_ordina_quattro_serie(self):
        import re
        import httpx
        from dynamic_agent import generate_code
        from pandas_protocol import validate_code
        prompts = []
        def transport(request):
            prompts.append(json.loads(request.content)["messages"][0]["content"])
            return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": '{"code":"result = df"}'}}]})
        with httpx.Client(transport=httpx.MockTransport(transport)) as client:
            generate_code("Arruolamenti mensili per studio", "line", [], api_key="synthetic_qa_key", client=client)
        example = re.search(r"```python\n(.*?)\n```", prompts[0], re.DOTALL)
        self.assertIsNotNone(example, "Manca l'esempio line da eseguire in isolamento.")
        code = validate_code(example.group(1))
        records = [
            {"study_id": "STUDY_A", "participant_id": "A2", "screening_failure": False, "enrollment_date": "2026-03-10"},
            {"study_id": "STUDY_B", "participant_id": "B1", "screening_failure": False, "enrollment_date": "2026-01-20"},
            {"study_id": "STUDY_D", "participant_id": "D2", "screening_failure": False, "enrollment_date": "2026-03-01"},
            {"study_id": "STUDY_A", "participant_id": "A1", "screening_failure": False, "enrollment_date": "2026-01-15"},
            {"study_id": "STUDY_A", "participant_id": "A1", "screening_failure": False, "enrollment_date": "2026-01-15"},
            {"study_id": "STUDY_C", "participant_id": "C1", "screening_failure": False, "enrollment_date": "2026-03-01"},
            {"study_id": "STUDY_A", "participant_id": "A3", "screening_failure": False, "enrollment_date": None},
            {"study_id": "STUDY_C", "participant_id": "C2", "screening_failure": True, "enrollment_date": "2026-02-10"},
            {"study_id": "STUDY_B", "participant_id": "B2", "screening_failure": False, "enrollment_date": "2026-02-20"},
            {"study_id": "STUDY_D", "participant_id": "D1", "screening_failure": False, "enrollment_date": "2026-01-08"},
        ]
        output = execute_isolated({"version": 1, "code": code, "chart": "line", "filters": {}}, records, IMAGE, DOCKER)
        self.assertEqual(output["rows"], [
            {"label": "2026-01 STUDY_A", "value": 1, "period": "2026-01", "series": "STUDY_A"},
            {"label": "2026-01 STUDY_B", "value": 1, "period": "2026-01", "series": "STUDY_B"},
            {"label": "2026-01 STUDY_D", "value": 1, "period": "2026-01", "series": "STUDY_D"},
            {"label": "2026-02 STUDY_B", "value": 1, "period": "2026-02", "series": "STUDY_B"},
            {"label": "2026-03 STUDY_A", "value": 1, "period": "2026-03", "series": "STUDY_A"},
            {"label": "2026-03 STUDY_C", "value": 1, "period": "2026-03", "series": "STUDY_C"},
            {"label": "2026-03 STUDY_D", "value": 1, "period": "2026-03", "series": "STUDY_D"},
        ])

    def test_codice_errato_o_output_eccessivo_non_produce_risultati(self):
        for code in ("result = missing_variable", "result = df", "for i in range(1000000000):\n pass"):
            with self.subTest(code=code), self.assertRaises(ValueError):
                execute_isolated({"version": 1, "code": code, "chart": "bar", "filters": {}}, [{"other": "x"}], IMAGE, DOCKER, timeout=2 if code.startswith("for ") else 20)


if __name__ == "__main__":
    unittest.main()
