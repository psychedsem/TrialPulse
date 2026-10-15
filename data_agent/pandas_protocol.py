"""Contratto limitato condiviso, senza accesso al daemon o esecuzione Python."""
import ast
import base64
import math
import re
import struct

MAX_CODE = 12000
MAX_OUTPUT = 1500000
SAFE_METHODS = set("groupby size count nunique sum mean median min max std quantile agg transform reset_index rename sort_values sort_index drop_duplicates dropna fillna isna notna isin astype copy assign query loc iloc dt str strip lower upper to_datetime to_numeric to_period to_timestamp strftime cumsum cumcount rank value_counts pivot pivot_table melt head tail round abs clip between eq ne gt ge lt le unique nlargest nsmallest columns index values to_dict items get len".split())
SAFE_FUNCTIONS = {"len", "int", "float", "str", "round", "abs", "min", "max", "sum", "sorted", "list", "dict", "range"}


def validate_code(code):
    if not isinstance(code, str) or not code.strip() or len(code) > MAX_CODE:
        raise ValueError("Codice generato non valido.")
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        raise ValueError("Codice generato non valido.") from exc
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef,
                             ast.ClassDef, ast.With, ast.AsyncWith, ast.Try, ast.While,
                             ast.Global, ast.Nonlocal, ast.Lambda, ast.Delete)):
            raise ValueError("Operazione non consentita nel codice generato.")
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ValueError("Identificativo non consentito.")
        if isinstance(node, ast.Attribute) and node.attr not in SAFE_METHODS:
            raise ValueError("Metodo non consentito nel codice generato.")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id not in SAFE_FUNCTIONS:
            raise ValueError("Funzione non consentita nel codice generato.")
    return code


def validate_job(job):
    if not isinstance(job, dict) or set(job) != {"version", "code", "chart", "filters"} or type(job["version"]) is not int or job["version"] != 1:
        raise ValueError("Richiesta esecutore non valida.")
    validate_code(job["code"])
    if job["chart"] not in ("bar", "line"):
        raise ValueError("Tipo grafico non consentito.")
    filters = job["filters"]
    if not isinstance(filters, dict) or any(k not in ("study_id", "site_id") or not isinstance(v, str) or not re.fullmatch(r"[A-Z0-9_-]{1,32}", v) for k, v in filters.items()):
        raise ValueError("Filtri non validi.")
    return job


def validate_output(output):
    if not isinstance(output, dict) or set(output) != {"rows", "png"}:
        raise ValueError("Risultato isolato non valido.")
    rows = output["rows"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 120:
        raise ValueError("Tabella non valida o oltre il limite.")
    for row in rows:
        if not isinstance(row, dict) or set(row) not in ({"label", "value"}, {"label", "value", "period", "series"}) or not isinstance(row["label"], str) or not 1 <= len(row["label"]) <= 100:
            raise ValueError("Riga risultato non valida.")
        if "period" in row and (not isinstance(row["period"], str) or not re.fullmatch(r"\d{4}-\d{2}(?:-\d{2})?", row["period"]) or not isinstance(row["series"], str) or not 1 <= len(row["series"]) <= 80):
            raise ValueError("Serie temporale non valida.")
        if type(row["value"]) not in (int, float) or not math.isfinite(row["value"]) or abs(row["value"]) > 1e12:
            raise ValueError("Valore risultato non valido.")
    try:
        encoded = output["png"]
        if not isinstance(encoded, str) or len(encoded) > 1400000:
            raise ValueError("PNG oltre il limite.")
        png = base64.b64decode(encoded, validate=True)
        if len(png) > 1048576 or png[:8] != b"\x89PNG\r\n\x1a\n" or png[12:16] != b"IHDR" or len(png) < 33:
            raise ValueError("PNG non valido.")
        width, height = struct.unpack(">II", png[16:24])
        if not (1 <= width <= 1600 and 1 <= height <= 1200):
            raise ValueError("Dimensioni PNG non consentite.")
    except (TypeError, ValueError, struct.error) as exc:
        raise ValueError("PNG non valido.") from exc
    return output
