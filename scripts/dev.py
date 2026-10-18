"""Comandi locali portabili, senza dipendenze aggiuntive o arresti per PID."""

import argparse
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import venv

ROOT = Path(__file__).resolve().parents[1]
PORTS = (8000, 8001, 3001, 5173)


def python_path():
    return ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def executable(name):
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"Comando richiesto non trovato: {name}")
    return path


def run(args, cwd=ROOT):
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def assert_ports_free(ports=PORTS):
    for port in ports:
        with socket.socket() as probe:
            if os.name == "nt":
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError as exc:
                raise RuntimeError(
                    f"Porta {port} occupata: nessun servizio avviato o arrestato."
                ) from exc


def setup(full=False):
    if not python_path().exists():
        venv.create(ROOT / ".venv", with_pip=True)
    requirements = ["requirements-dev.txt"]
    if full:
        requirements.append("rag/requirements.txt")
    for requirement in requirements:
        run([python_path(), "-m", "pip", "install", "-r", requirement])
    npm = executable("npm")
    for directory in ("backend", "frontend"):
        run([npm, "ci"], ROOT / directory)
    print("Dipendenze installate. Configurazione: consultare docs/local-dev.md.")


def test(full=False):
    if not python_path().exists():
        raise RuntimeError("Eseguire prima setup; per il RAG usare setup --full.")
    npm = executable("npm")
    run([npm, "test"], ROOT / "backend")
    for script in ("test", "test:react", "build", "lint", "lint:strict", "format:check"):
        run([npm, "run", script], ROOT / "frontend")
    args = [python_path(), "-m", "pytest"]
    if not full:
        args += [
            "tests/unit",
            "tests/test_data_agent.py",
            "tests/test_data_loader.py",
            "tests/test_dynamic_agent.py",
            "tests/test_pandas_sandbox.py",
            "tests/test_validate_kb.py",
            "tests/test_python_bridge.py",
        ]
    run(args)


def stop_children(children):
    # Gli handle Popen appartengono esclusivamente a questa sessione.
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
    for child in reversed(children):
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)


def start():
    assert_ports_free()
    interpreter = python_path()
    if not interpreter.exists():
        raise RuntimeError("Eseguire prima setup --full.")
    if not (ROOT / "frontend/node_modules/vite/bin/vite.js").exists():
        raise RuntimeError("Dipendenze frontend assenti: eseguire setup --full.")
    node = executable("node")
    commands = [
        (
            "data_agent",
            [interpreter, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8000"],
        ),
        ("rag", [interpreter, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8001"]),
        ("backend", [node, "src/server.js"]),
        (
            "frontend",
            [
                node,
                "node_modules/vite/bin/vite.js",
                "--host",
                "127.0.0.1",
                "--port",
                "5173",
                "--strictPort",
            ],
        ),
    ]
    environment = {
        **os.environ,
        "TRIALPULSE_PANDAS_ENABLED": "0",
        "PYTHON_BRIDGE_ENABLED": "false",
        "PORT": "3001",
        "DATA_AGENT_URL": "http://127.0.0.1:8000",
        "RAG_API_URL": "http://127.0.0.1:8001",
        "BACKEND_PROXY_TARGET": "http://127.0.0.1:3001",
        "VITE_API_BASE_URL": "",
    }
    children = []
    try:
        for directory, command in commands:
            service_environment = environment.copy()
            if directory != "backend":
                service_environment.pop("GROQ_API_KEY", None)
                service_environment.pop("TRIALPULSE_QA_GROQ_API_KEY", None)
            children.append(
                subprocess.Popen(
                    [str(arg) for arg in command], cwd=ROOT / directory, env=service_environment
                )
            )
        print("Avvio in primo piano: http://127.0.0.1:5173 . Arresto: Ctrl+C.", flush=True)
        while True:
            for child in children:
                if child.poll() is not None:
                    raise RuntimeError(
                        "Un servizio è terminato; arresto dei soli processi avviati qui."
                    )
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("Arresto dei processi della sessione.")
    finally:
        stop_children(children)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=("setup", "install", "test", "start", "stop", "check-ports")
    )
    parser.add_argument(
        "--full", action="store_true", help="Installa o verifica anche il RAG con modello reale."
    )
    args = parser.parse_args()
    try:
        if args.command in ("setup", "install"):
            setup(args.full)
        elif args.command == "test":
            test(args.full)
        elif args.command == "start":
            start()
        elif args.command == "stop":
            print("Usare Ctrl+C nel terminale di start. Nessun processo esterno viene arrestato.")
        else:
            assert_ports_free()
            print("Porte disponibili.")
    except (RuntimeError, subprocess.CalledProcessError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
