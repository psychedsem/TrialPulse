import json
from fastapi import FastAPI, HTTPException

from data_loader import load_analytic_dataset
from models import AnalyzeRequest
from analytics import analyze_dataset
from dynamic_agent import DynamicRequest, analyze_dynamic


app = FastAPI(title="TrialPulse Data Agent")

try:
    DATAFRAME, DATA_QUALITY = load_analytic_dataset()
    LOAD_ERROR = None
except Exception as exc:
    DATAFRAME = DATA_QUALITY = None
    LOAD_ERROR = str(exc)


@app.get("/health")
def health():
    return {
        "status": "ok" if LOAD_ERROR is None else "error",
        "dataset_loaded": LOAD_ERROR is None,
        "physical_rows": DATA_QUALITY["physical_rows"] if DATA_QUALITY else None,
        "logical_rows": DATA_QUALITY["logical_rows"] if DATA_QUALITY else None,
        "error": LOAD_ERROR,
    }


@app.post("/analyze")
def analyze(request: AnalyzeRequest | DynamicRequest):
    if LOAD_ERROR:
        raise HTTPException(503, "Dataset TrialPulse non disponibile.")

    try:
        if isinstance(request, DynamicRequest):
            return analyze_dynamic(request, DATAFRAME)
        return analyze_dataset(DATAFRAME, DATA_QUALITY, request)
    except ValueError as exc:
        headers = {"X-TrialPulse-Generation-Quota": json.dumps(exc.quota)} if getattr(exc, "quota", None) else None
        raise HTTPException(400, str(exc), headers=headers) from exc
