"""Memoizzazione esatta delle sole analisi deterministiche, senza contesto LLM."""

import hashlib
import json
from typing import Any

import pandas as pd

from analytics import DESIGN_PATH, analyze_dataset
from result_cache import ResultCache
from models import AnalyzeRequest

REPORTS = ResultCache(maxsize=64, ttl=60)


def cached_analysis(
    source: pd.DataFrame, quality: dict[str, Any], request: AnalyzeRequest
) -> dict[str, Any]:
    if request.analysis.value != "recruitment_target" and not (
        request.analysis.value == "recruitment" and "month" in request.group_by
    ):
        return analyze_dataset(source, quality, request)
    try:
        frame = pd.util.hash_pandas_object(source, index=True).values.tobytes()
        schema = repr((list(source.columns), list(map(str, source.dtypes)), source.index.names))
        context = json.dumps(
            {"request": request.model_dump(mode="json"), "quality": quality},
            sort_keys=True,
        )
        key = hashlib.sha256(
            frame + schema.encode() + context.encode() + DESIGN_PATH.read_bytes()
        ).hexdigest()
    except OSError, TypeError, ValueError:
        # Un input non memorizzabile conserva gli errori e la semantica dell'analisi.
        return analyze_dataset(source, quality, request)
    return REPORTS.get_or_create(key, lambda: analyze_dataset(source, quality, request))
