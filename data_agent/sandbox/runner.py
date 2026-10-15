"""Wrapper eseguito esclusivamente nel container effimero."""
import base64
import io
import json
import sys

sys.path.insert(0, "/app")

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

from pandas_protocol import SAFE_FUNCTIONS, validate_job, validate_output


def main():
    payload = json.loads(sys.stdin.buffer.read(3000001))
    job = validate_job(payload["job"])
    df = pd.DataFrame(payload["records"])
    for name in ("enrollment_date", "day0_date", "target_date", "scheduled_date", "actual_date"):
        if name in df:
            df[name] = pd.to_datetime(df[name], errors="coerce")
    import builtins
    scope = {"df": df, "pd": pd, "__builtins__": {name: getattr(builtins, name) for name in SAFE_FUNCTIONS}}
    exec(compile(job["code"], "<analisi>", "exec"), scope)
    result = scope.get("result")
    columns = ["label", "value"] if job["chart"] == "bar" else ["label", "value", "period", "series"]
    if not isinstance(result, pd.DataFrame) or list(result.columns) != columns:
        raise ValueError("Colonne risultato non valide per il tipo di grafico.")
    rows = json.loads(result.to_json(orient="records"))
    fig, ax = plt.subplots(figsize=(10, 5), layout="constrained")
    if job["chart"] == "bar":
        ax.bar(result["label"], result["value"])
    else:
        if result["series"].nunique() > 12 or result.duplicated(subset=["period", "series"]).any():
            raise ValueError("Serie duplicate o oltre il limite grafico.")
        for name, group in result.groupby("series", sort=True):
            group = group.sort_values("period")
            dates = pd.to_datetime(group["period"], errors="raise", format="mixed")
            ax.plot(dates, group["value"], marker="o", label=name)
        ax.legend()
    ax.set_ylabel("Valore calcolato sui dati sintetici")
    ax.tick_params(axis="x", labelrotation=45)
    ax.grid(axis="y", alpha=0.2)
    stream = io.BytesIO()
    fig.savefig(stream, format="png", dpi=100, metadata={"Software": "TrialPulse"})
    plt.close(fig)
    output = validate_output({"rows": rows, "png": base64.b64encode(stream.getvalue()).decode("ascii")})
    print(json.dumps(output, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"error":"execution_invalid"}')
        sys.exit(1)
