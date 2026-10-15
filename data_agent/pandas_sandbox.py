"""Controllo Docker riservato all'esecutore locale separato, non a FastAPI."""
import json
import os
import re
import subprocess
import threading
import uuid
from pathlib import Path

from pandas_protocol import MAX_OUTPUT, validate_code, validate_job, validate_output

SECCOMP = Path(__file__).parent / "sandbox" / "seccomp.json"


class SandboxCleanupError(RuntimeError):
    """Il controllore deve fermarsi se non può confermare la terminazione."""


def container_command(docker, image, name, seccomp=SECCOMP):
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("Serve un identificativo immutabile dell'immagine.")
    if not re.fullmatch(r"[a-z0-9-]{1,64}", name):
        raise ValueError("Identificativo container non valido.")
    return [docker, "run", "--pull=never", "--name", name, "--network=none", "--read-only",
            "--user=65532:65532", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
            f"--security-opt=seccomp={seccomp}", "--memory=512m", "--memory-swap=512m",
            "--cpus=1", "--pids-limit=32", "--ulimit=cpu=10:10", "--ulimit=nofile=64:64",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=64m,mode=1777", "--log-driver=none", "-i", image]


def docker_environment():
    return {key: value for key, value in os.environ.items() if key.upper() in
            {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOME", "LOCALAPPDATA"}}


def execute_isolated(job, records, image, docker="docker", timeout=20):
    validate_job(job)
    payload = json.dumps({"job": job, "records": records}, allow_nan=False).encode()
    if len(payload) > 3000000:
        raise ValueError("Dati oltre il limite dell'esecutore.")
    name = "trialpulse-pandas-" + uuid.uuid4().hex
    command = container_command(docker, image, name)
    env = docker_environment()
    output = bytearray()
    exceeded = threading.Event()
    process = None
    watchdog = None
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env=env, shell=False)
        def drain():
            while chunk := process.stdout.read(8192):
                if len(output) + len(chunk) > MAX_OUTPUT:
                    exceeded.set()
                    process.kill()
                    return
                output.extend(chunk)
        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        watchdog = threading.Timer(timeout, process.kill)
        watchdog.start()
        process.stdin.write(payload)
        process.stdin.close()
        process.wait(timeout=timeout)
        reader.join(timeout=2)
        if exceeded.is_set() or reader.is_alive() or process.returncode:
            raise ValueError("Esecuzione isolata fallita o oltre i limiti.")
        return validate_output(json.loads(output))
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        raise ValueError("Esecutore isolato non disponibile o scaduto.") from exc
    finally:
        if watchdog:
            watchdog.cancel()
        if process and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        if process:
            process.stdout.close()
            if not process.stdin.closed:
                process.stdin.close()
        # La terminazione del client non è sufficiente: rimuove l'intero job.
        try:
            cleanup = subprocess.run([docker, "rm", "-f", name], stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, env=env, timeout=10, check=False)
            check = subprocess.run([docker, "ps", "-aq", "--filter", f"name=^/{name}$"],
                                   capture_output=True, env=env, timeout=10, check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            raise SandboxCleanupError("Cleanup isolato non verificato: esecutore da arrestare.") from exc
        if cleanup.returncode or check.returncode or check.stdout.strip():
            raise SandboxCleanupError("Cleanup isolato non verificato: esecutore da arrestare.")
