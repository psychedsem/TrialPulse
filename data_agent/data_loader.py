from pathlib import Path
from hashlib import sha256
from io import BytesIO
from typing import Any

import pandas as pd
from result_cache import ResultCache


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATASET_PATH = PROJECT_ROOT / "data" / "trialpulse_operations.csv"
DATE_COLUMNS = [
    "enrollment_date",
    "day0_date",
    "target_date",
    "scheduled_date",
    "actual_date",
]


SNAPSHOTS: ResultCache[tuple[pd.DataFrame, dict[str, Any]]] = ResultCache(maxsize=4, ttl=300)


def load_analytic_dataset(
    path: Any = DATASET_PATH, *, refresh: bool = False, use_cache: bool = True
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Restituisce copie isolate; il digest invalida anche modifiche di pari dimensione."""
    if not use_cache or hasattr(path, "read"):
        return _read_analytic_dataset(path)
    path = Path(path).resolve()
    if refresh:
        SNAPSHOTS.clear()
    for _ in range(3):
        before = path.stat()
        content = path.read_bytes()
        after = path.stat()
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            key = (str(path), sha256(content).hexdigest())
            return SNAPSHOTS.get_or_create(key, lambda: _read_analytic_dataset(BytesIO(content)))
    raise OSError("Dataset modificato durante la lettura: riprovare su un file stabile.")


def _read_analytic_dataset(path: Any) -> tuple[pd.DataFrame, dict[str, Any]]:
    raw = pd.read_csv(path)
    df = raw.drop_duplicates().copy()

    status = df["participant_status"].astype("string")
    normalized = status.str.strip().str.lower()
    normalized_count = int((status.fillna("") != normalized.fillna("")).sum())
    df["participant_status"] = normalized

    unparseable = {}
    for column in DATE_COLUMNS:
        non_null = df[column].notna()
        parsed = pd.to_datetime(df[column], errors="coerce")
        unparseable[column] = int((non_null & parsed.isna()).sum())
        df[column] = parsed

    bad_actual_date = (
        df["target_day"].fillna(0).gt(0)
        & df["actual_date"].notna()
        & df["day0_date"].notna()
        & df["actual_date"].lt(df["day0_date"])
    )
    bad_query = df["data_queries_open"].gt(df["data_queries_opened"])

    df["_actual_date_usable"] = df["actual_date"].notna() & ~bad_actual_date
    df["_query_consistent"] = ~bad_query

    quality: dict[str, Any] = {
        "physical_rows": len(raw),
        "logical_rows": len(df),
        "duplicates_removed": len(raw) - len(df),
        "normalized_values": normalized_count,
        "unparseable_dates": unparseable,
        "inconsistent_actual_dates": int(bad_actual_date.sum()),
        "inconsistent_query_rows": int(bad_query.sum()),
        "warnings": [],
    }

    for key, label in (
        ("duplicates_removed", "duplicati esatti rimossi dalla vista analitica"),
        ("inconsistent_actual_dates", "actual_date incoerenti"),
        ("inconsistent_query_rows", "righe query incoerenti"),
    ):
        if quality[key]:
            quality["warnings"].append(f"{quality[key]} {label}.")

    return df, quality
