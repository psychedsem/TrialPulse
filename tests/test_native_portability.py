"""Collaudo nativo opt-in e controlli offline sulla proprietà delle risorse QA."""

import os
import json
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from unittest.mock import Mock

import pytest

from scripts import dev

ROOT = Path(__file__).resolve().parents[1]


def link_new_index(path, target):
    if path.exists() or path.is_symlink():
        raise FileExistsError("Indice già presente: il collaudo non lo modifica.")
    path.symlink_to(target, target_is_directory=True)


def stop_launcher(process):
    """Riceve soltanto il Popen creato qui con start_new_session=True, su POSIX."""
    if process.poll() is None:
        try:
            process.send_signal(signal.SIGINT)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=35)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)
        raise AssertionError("Arresto del launcher in timeout; gruppo QA terminato.")
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        pass
    else:
        os.killpg(process.pid, signal.SIGKILL)
        raise AssertionError("Processi residui nel gruppo QA; cleanup forzato, non PASS.")
    assert process.returncode == 0, "Il launcher non è terminato correttamente."


def request_json(port, path, payload=None, timeout=5):
    data = None if payload is None else json.dumps(payload).encode()
    request = Request(
        f"http://127.0.0.1:{port}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


@pytest.mark.skipif(
    os.environ.get("TRIALPULSE_NATIVE_RUNTIME") != "1",
    reason="Collaudo nativo completo non abilitato: nessun servizio avviato.",
)
def test_stack_nativo_health_dati_retrieval_e_arresto(tmp_path):
    """Solo checkout effimera GitHub Ubuntu/macOS, mai l'installazione operativa."""
    assert os.environ.get("GITHUB_ACTIONS") == "true", "Richiesto un runner GitHub effimero."
    assert sys.platform in ("linux", "darwin"), "Runtime previsto solo su Ubuntu/macOS."
    assert ROOT == Path(os.environ["GITHUB_WORKSPACE"]).resolve()
    private_files = [
        path
        for directory in (ROOT, ROOT / "backend", ROOT / "frontend", ROOT / "data_agent")
        for path in directory.glob(".env*")
        if path.name != ".env.example"
    ]
    assert not private_files, "Usare una checkout nuova, senza configurazioni private."
    dev.assert_ports_free()
    index = ROOT / "rag" / "chroma_db"
    target = tmp_path / "indice_qa"
    target.mkdir()
    logs = ROOT / ".tmp" / "native-portability"
    logs.mkdir(parents=True, exist_ok=True)
    environment = {key: value for key, value in os.environ.items() if "GROQ" not in key}
    environment.update(
        {
            "GROQ_API_KEY": "",
            "DOTENV_CONFIG_PATH": os.devnull,
            "TRIALPULSE_PANDAS_ENABLED": "0",
            "PYTHON_BRIDGE_ENABLED": "false",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "ANONYMIZED_TELEMETRY": "False",
        }
    )
    result = {"checks": [], "cleanup": "NOT RUN"}
    process = None
    link_new_index(index, target)
    try:
        with (logs / "index.log").open("w", encoding="utf-8") as output:
            subprocess.run(
                [sys.executable, "rag/build_index.py"],
                cwd=ROOT,
                env=environment,
                stdout=output,
                stderr=subprocess.STDOUT,
                check=True,
                timeout=600,
            )
        result["checks"].append("indice temporaneo costruito")
        environment.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
        with (logs / "services.log").open("w", encoding="utf-8") as output:
            process = subprocess.Popen(
                [sys.executable, "scripts/dev.py", "start"],
                cwd=ROOT,
                env=environment,
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            deadline = time.monotonic() + 120
            while True:
                assert (
                    process.poll() is None
                ), "Launcher terminato durante l'avvio: vedere services.log."
                try:
                    for port in (8000, 8001, 3001):
                        assert request_json(port, "/health")["status"] == "ok"
                    with urlopen("http://127.0.0.1:5173/", timeout=5) as response:
                        assert "/src/main.jsx" in response.read().decode()
                    break
                except URLError, TimeoutError, ConnectionError, AssertionError:
                    if time.monotonic() >= deadline:
                        raise AssertionError("Health non raggiunto entro 120 secondi.")
                    time.sleep(0.5)
            result["checks"].append("quattro servizi raggiungibili")
            report = request_json(8000, "/analyze", {"analysis": "portfolio_summary"})
            summary = report["results"][0]
            assert summary["screened_participants"] == 194
            assert summary["enrolled_participants"] == 154
            assert summary["screening_failures"] == 40
            result["checks"].append("Data Agent 194/154/40")
            rows = request_json(
                8001,
                "/retrieve",
                {"query": "Schedule visit windows NNR-PSI-01 Week 6"},
                timeout=120,
            )["results"]
            assert rows and any(row["section"] == "NNR-PSI-01" for row in rows)
            for rank, row in enumerate(rows, 1):
                assert row["rank"] == rank and row["id"] and row["text"]
                assert row["source"].startswith("knowledge_base/")
                assert row["source"] == row["metadata"]["source"]
            result["checks"].append("retrieval autentico con provenienza")
            with pytest.raises(HTTPError) as refused:
                request_json(5173, "/api/chat", {"message": ""})
            assert refused.value.code == 400
            assert json.load(refused.value) == {"error": "Il campo message è obbligatorio."}
            result["checks"].append("proxy frontend/backend senza LLM")
    finally:
        try:
            if process is not None:
                stop_launcher(process)
            dev.assert_ports_free()
            result["cleanup"] = "PASS"
        finally:
            if index.is_symlink() and index.resolve() == target.resolve():
                index.unlink()
            else:
                raise AssertionError("Collegamento indice QA cambiato: nessuna rimozione eseguita.")
            (logs / "results.json").write_text(json.dumps(result, indent=2), encoding="utf-8")


@pytest.mark.parametrize("kind", ["file", "directory"])
def test_indice_esistente_rifiutato_senza_sovrascrittura(tmp_path, kind):
    index = tmp_path / "chroma_db"
    if kind == "file":
        index.write_text("da preservare", encoding="utf-8")
    else:
        index.mkdir()
        (index / "sentinel").write_text("da preservare", encoding="utf-8")
    with pytest.raises(FileExistsError):
        link_new_index(index, tmp_path / "indice_temporaneo")
    assert index.is_file() if kind == "file" else index.is_dir()
    preserved = index if kind == "file" else index / "sentinel"
    assert preserved.read_text(encoding="utf-8") == "da preservare"


def test_collegamento_indice_interrotto_non_viene_sostituito():
    path = Mock()
    path.exists.return_value = False
    path.is_symlink.return_value = True
    with pytest.raises(FileExistsError):
        link_new_index(path, Path("indice_temporaneo"))
    path.symlink_to.assert_not_called()


def test_runtime_fuori_runner_rifiutato_prima_di_accedere_alle_porte(monkeypatch, tmp_path):
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    probe = Mock()
    monkeypatch.setattr(dev, "assert_ports_free", probe)
    with pytest.raises(AssertionError, match="runner GitHub effimero"):
        test_stack_nativo_health_dati_retrieval_e_arresto(tmp_path)
    probe.assert_not_called()


def test_cleanup_normale_segnala_solo_launcher_di_proprieta(monkeypatch):
    process = Mock(pid=12345, returncode=0)
    process.poll.return_value = None
    probe = Mock(side_effect=ProcessLookupError)
    monkeypatch.setattr(os, "killpg", probe, raising=False)
    stop_launcher(process)
    process.send_signal.assert_called_once_with(signal.SIGINT)
    probe.assert_called_once_with(12345, 0)


def test_cleanup_timeout_non_maschera_il_fallimento(monkeypatch):
    process = Mock(pid=12345)
    process.poll.return_value = None
    process.wait.side_effect = [subprocess.TimeoutExpired("launcher", 35), 0]
    kill = Mock()
    monkeypatch.setattr(os, "killpg", kill, raising=False)
    monkeypatch.setattr(signal, "SIGKILL", 9, raising=False)
    with pytest.raises(AssertionError, match="timeout"):
        stop_launcher(process)
    kill.assert_called_once_with(12345, 9)


def test_cleanup_rileva_discendenti_anche_se_launcher_terminato(monkeypatch):
    process = Mock(pid=12345, returncode=0)
    process.poll.return_value = 0
    kill = Mock()
    monkeypatch.setattr(os, "killpg", kill, raising=False)
    monkeypatch.setattr(signal, "SIGKILL", 9, raising=False)
    with pytest.raises(AssertionError, match="residui"):
        stop_launcher(process)
    assert [call.args for call in kill.call_args_list] == [(12345, 0), (12345, 9)]
