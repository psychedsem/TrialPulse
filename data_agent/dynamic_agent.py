"""Generazione di codice e invio alla coda, senza accesso a Docker o exec locale."""
import hashlib
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from pandas_protocol import validate_code, validate_job, validate_output

QUEUE = Path(os.environ.get("TRIALPULSE_PANDAS_QUEUE", str(Path(__file__).parent / ".pandas_queue")))
BUSY = threading.BoundedSemaphore(1)
PROMPT = """Genera solo un oggetto JSON con la chiave code, contenente codice pandas per dati operativi completamente sintetici. Non prendere decisioni cliniche o inventare regole Novera. df è la vista già deduplicata e filtrata; pd è pandas. Non importare moduli, leggere file, accedere alla rete o eseguire comandi. Non usare print, funzioni definite, attributi privati, casualità o ora corrente. Per bar produci result come DataFrame con colonne label (stringa) e value (numero finito), massimo 120 righe. Il wrapper crea il grafico da questi stessi valori. Conta partecipanti unici, non righe visita, per recruitment/enrollment. La colonna booleana screening_failure identifica gli arruolati con False e gli screening failure con True: non dedurre l'arruolamento da participant_status. Per il recruitment usa enrollment_date ed escludi date mancanti senza inventare periodi non presenti. Non inferire regole, soglie o finestre di visita dal CSV. Usa solo operazioni pandas descrittive pertinenti alla richiesta. Non includere testo fuori dal JSON."""


class GenerationError(ValueError):
    def __init__(self, message, quota):
        super().__init__(message)
        self.quota = quota


def generation_quota(response, model):
    remaining = response.headers.get("x-ratelimit-remaining-tokens", "")
    reset = response.headers.get("x-ratelimit-reset-tokens", "")
    if not re.fullmatch(r"\d{1,12}", remaining) or not re.fullmatch(r"\d{1,5}(?:\.\d{1,6})?s", reset):
        return {}
    return {"model": model, "remaining": int(remaining), "reset_seconds": float(reset[:-1])}


class DynamicFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    study_id: str | None = Field(default=None, pattern=r"^[A-Z0-9_-]{1,32}$")
    site_id: str | None = Field(default=None, pattern=r"^[A-Z0-9_-]{1,32}$")


class DynamicRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    analysis: Literal["dynamic"]
    question: str = Field(min_length=3, max_length=1000)
    chart: Literal["bar", "line"]
    filters: DynamicFilters = Field(default_factory=DynamicFilters)


def generate_code(question, chart, columns, api_key=None, client=None):
    key = api_key if api_key is not None else os.environ.get("GROQ_API_KEY", "")
    if not key:
        raise ValueError("Generazione del codice non configurata.")
    payload = {"model": os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b"), "temperature": 0,
               "include_reasoning": False, "reasoning_effort": "low",
               "max_completion_tokens": 1500, "response_format": {"type": "json_object"},
               "messages": [{"role": "system", "content": PROMPT},
                            {"role": "user", "content": json.dumps({"question": question, "chart": chart, "columns": columns}, ensure_ascii=False)}]}
    if chart == "line":
        payload["messages"][0]["content"] += """ Per line il contratto è result con colonne label,value,period,series, in questo ordine: label e series sono stringhe, value un numero finito, period una stringa YYYY-MM o YYYY-MM-DD. Massimo 12 serie e 120 righe, una per periodo/serie; series distingue studio/sito. Includi solo periodi osservati, senza inventare mesi o zeri; ordina con sort_values per period e series.
Usa assegnazioni e operazioni vettoriali, senza import, def/async def, class, lambda, with/async with, try, while, global, nonlocal o del. Accedi alle colonne con ['nome'], non come attributi. Sono ammesse operazioni come loc, eq, drop_duplicates, dropna, copy, dt.strftime, groupby, nunique, reset_index, rename, sort_values; non usare apply/map o pd.DataFrame.
Per gli arruolamenti mensili conta participant_id unici per studio e mese, non righe visita. Esempio conforme per questa aggregazione, da adattare alla richiesta senza inventare colonne o regole:
```python
participants = df.loc[df['screening_failure'].eq(False)].drop_duplicates(subset=['study_id','participant_id']).dropna(subset=['enrollment_date']).copy()
participants['period'] = participants['enrollment_date'].dt.strftime('%Y-%m')
result = participants.groupby(['period','study_id'])['participant_id'].nunique().reset_index(name='value').rename(columns={'study_id':'series'})
result['label'] = result['period'] + ' ' + result['series']
result = result.sort_values(['period','series'])[['label','value','period','series']]
```
Restituisci sempre solo l'oggetto JSON con code, senza Markdown nella risposta."""
    owned = client is None
    client = client or httpx.Client(timeout=30)
    try:
        response = client.post("https://api.groq.com/openai/v1/chat/completions", headers={"Authorization": "Bearer " + key}, json=payload)
        quota = generation_quota(response, payload["model"])
        if response.status_code != 200 or len(response.content) > 64000:
            raise GenerationError("Generazione del codice non disponibile.", quota)
        packet = response.json()
        choice = packet["choices"][0]
        if choice.get("finish_reason") != "stop":
            raise ValueError("Generazione del codice incompleta.")
        result = json.loads(choice["message"]["content"])
        if not isinstance(result, dict) or set(result) != {"code"}:
            raise ValueError("Contratto del codice non valido.")
        usage = {k: v for k, v in packet.get("usage", {}).items() if k in ("prompt_tokens", "completion_tokens", "total_tokens") and type(v) is int and v >= 0}
        if quota:
            usage["quota"] = quota
        return validate_code(result["code"]), usage
    except (httpx.HTTPError, KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError("Generazione del codice non disponibile o non valida.") from exc
    finally:
        if owned:
            client.close()


def require_executor(queue):
    ready = queue / "executor.ready"
    if queue.is_symlink() or not ready.is_file() or ready.is_symlink() or time.time() - ready.stat().st_mtime > 5:
        raise ValueError("Esecutore isolato non disponibile.")


def submit_job(job, queue=QUEUE, timeout=45):
    validate_job(job)
    require_executor(queue)
    identifier = uuid.uuid4().hex
    request = queue / f"{identifier}.request.json"
    response = queue / f"{identifier}.response.json"
    temporary = queue / f"{identifier}.tmp"
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(job, stream, allow_nan=False)
    os.replace(temporary, request)
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            if not response.exists():
                time.sleep(0.05)
                continue
            if response.is_symlink() or response.stat().st_size > 1600000:
                raise ValueError("Risposta esecutore non valida.")
            value = json.loads(response.read_text(encoding="utf-8"))
            if not isinstance(value, dict) or "error" in value:
                raise ValueError("Analisi dinamica non completata in sicurezza.")
            if value["analysis"] != "dynamic" or value["parameters_applied"]["chart"] != job["chart"] or value["scope"]["filters"] != job["filters"]:
                raise ValueError("Risultato non correlato al perimetro richiesto.")
            validate_output({"rows": value["results"], "png": value["artifacts"][0]["data"]})
            return value
        raise ValueError("Tempo limite dell'analisi dinamica superato.")
    except (OSError, KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError("Risposta dell'esecutore non disponibile o non valida.") from exc
    finally:
        request.unlink(missing_ok=True)
        response.unlink(missing_ok=True)


def analyze_dynamic(request, dataframe):
    if os.environ.get("TRIALPULSE_PANDAS_ENABLED") != "1":
        raise ValueError("Analisi dinamica non abilitata.")
    require_executor(QUEUE)
    if not BUSY.acquire(blocking=False):
        raise ValueError("Un'analisi dinamica è già in corso.")
    try:
        code, usage = generate_code(request.question.strip(), request.chart, list(dataframe.columns))
        result = submit_job({"version": 1, "code": code, "chart": request.chart,
                             "filters": request.filters.model_dump(exclude_none=True)})
        if result["execution"]["code_sha256"] != hashlib.sha256(code.encode()).hexdigest():
            raise ValueError("Risultato non correlato alla richiesta.")
        result["generation_usage"] = usage
        return result
    finally:
        BUSY.release()
