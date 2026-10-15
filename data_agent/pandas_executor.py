"""Esecutore avviato manualmente, senza listener o API Docker pubblica."""
import argparse
import base64
import hashlib
import json
import os
import re
import time
from pathlib import Path

from data_loader import DATASET_PATH, load_analytic_dataset
from pandas_protocol import validate_job
from pandas_sandbox import container_command, execute_isolated

ERROR = "Analisi dinamica non completata in sicurezza."


def filtered_records(df, filters):
    for key, value in filters.items():
        if value not in set(df[key].dropna().astype(str)):
            raise ValueError("Filtro sconosciuto.")
        df = df.loc[df[key] == value]
    if df.empty:
        raise ValueError("Perimetro senza dati.")
    return json.loads(df.to_json(orient="records", date_format="iso"))


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, allow_nan=False, separators=(",", ":"))
    os.replace(temporary, path)


def process_request(path, image, docker="docker"):
    if path.is_symlink() or not re.fullmatch(r"[a-f0-9]{32}\.request\.json", path.name):
        raise ValueError("Percorso richiesta non valido.")
    response = path.with_name(path.name.replace(".request.", ".response."))
    try:
        if path.stat().st_size > 16000 or time.time() - path.stat().st_mtime > 45:
            raise ValueError("Richiesta oltre i limiti.")
        job = validate_job(json.loads(path.read_text(encoding="utf-8")))
        df, quality = load_analytic_dataset()
        records = filtered_records(df, job["filters"])
        output = execute_isolated(job, records, image, docker)
        chart_dir = Path(__file__).parent / "generated_charts"
        if chart_dir.is_symlink():
            raise ValueError("Directory grafici non valida.")
        chart_dir.mkdir(exist_ok=True)
        for old in chart_dir.glob("*.png"):
            if re.fullmatch(r"[a-f0-9]{32}\.png", old.name) and not old.is_symlink() and time.time() - old.stat().st_mtime > 86400:
                old.unlink()
        chart_id = path.name.split(".")[0]
        with (chart_dir / f"{chart_id}.png").open("xb") as stream:
            stream.write(base64.b64decode(output["png"], validate=True))
        result = {"analysis": "dynamic", "scope": {"filters": job["filters"], "row_count": len(records)},
                  "parameters_applied": {"chart": job["chart"]}, "data_quality": quality,
                  "results": output["rows"], "artifacts": [{"type": "image", "mime_type": "image/png", "data": output["png"], "alt": "Grafico calcolato sui dati sintetici TrialPulse"}],
                  "execution": {"code_sha256": hashlib.sha256(job["code"].encode()).hexdigest(),
                                "dataset_sha256": hashlib.sha256(DATASET_PATH.read_bytes()).hexdigest(), "image": image}}
    except (ValueError, OSError, json.JSONDecodeError):
        result = {"error": ERROR}
    if path.exists():
        atomic_json(response, result)


def main():
    parser = argparse.ArgumentParser(description="Esecutore locale limitato per analisi pandas isolate.")
    parser.add_argument("--queue", required=True, type=Path)
    parser.add_argument("--image", required=True)
    parser.add_argument("--docker", default="docker")
    args = parser.parse_args()
    container_command(args.docker, args.image, "trialpulse-pandas-precondition")
    queue = args.queue.resolve()
    if args.queue.is_symlink():
        raise ValueError("Coda non valida.")
    queue.mkdir(parents=True, exist_ok=True)
    lock = queue / "executor.lock"
    # Una sola istanza. Un lock residuo richiede verifica manuale, non viene aggirato.
    with lock.open("x", encoding="ascii") as stream:
        stream.write(str(os.getpid()))
    heartbeat = queue / "executor.ready"
    try:
        while True:
            heartbeat.touch()
            pending = sorted(queue.glob("*.request.json"))
            for request in pending[:8]:
                process_request(request, args.image, args.docker)
                request.unlink(missing_ok=True)
            for response in queue.glob("*.response.json"):
                if re.fullmatch(r"[a-f0-9]{32}\.response\.json", response.name) and not response.is_symlink() and time.time() - response.stat().st_mtime > 60:
                    response.unlink(missing_ok=True)
            time.sleep(0.1)
    finally:
        heartbeat.unlink(missing_ok=True)
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
