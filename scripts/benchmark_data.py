"""Benchmark locale riproducibile: file sintetici temporanei, nessuna scrittura al CSV."""

import argparse
import json
import platform
import statistics
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "data_agent"))
from analysis_cache import REPORTS, cached_analysis
from analytics import analyze_dataset
from data_loader import load_analytic_dataset
from models import AnalyzeRequest


def measure(run, repeats):
    times, peaks = [], []
    for _ in range(repeats):
        tracemalloc.start()
        start = time.perf_counter()
        run()
        times.append((time.perf_counter() - start) * 1000)
        peaks.append(tracemalloc.get_traced_memory()[1])
        tracemalloc.stop()
    return {"median_ms": round(statistics.median(times), 3), "peak_python_bytes": max(peaks)}


def benchmark(multipliers, repeats):
    original, _ = load_analytic_dataset(use_cache=False)
    rows = []
    with tempfile.TemporaryDirectory(prefix="trialpulse-benchmark-") as directory:
        for multiplier in multipliers:
            parts = []
            for replica in range(multiplier):
                part = original.copy()
                part["participant_id"] = part.participant_id.astype(str) + f"_replica_{replica}"
                parts.append(part)
            expanded = pd.concat(parts, ignore_index=True)
            expanded = expanded.drop(columns=["_actual_date_usable", "_query_consistent"])
            path = Path(directory) / f"synthetic-{multiplier}.csv"
            expanded.to_csv(path, index=False)
            frame, quality = load_analytic_dataset(path, refresh=True)
            item = {
                "rows": len(frame),
                "csv_bytes": path.stat().st_size,
                "dataframe_bytes": int(frame.memory_usage(index=True, deep=True).sum()),
                "csv_uncached": measure(
                    lambda: load_analytic_dataset(path, use_cache=False), repeats
                ),
                "csv_cached": measure(lambda: load_analytic_dataset(path), repeats),
                "analyses": {},
            }
            for name, args in {
                "portfolio_summary": {},
                "recruitment": {"group_by": ["study_id", "month"]},
                "recruitment_target": {
                    "parameters": {"threshold_percent": 75, "consecutive_months": 2}
                },
            }.items():
                request = AnalyzeRequest(analysis=name, **args)
                REPORTS.clear()
                expected = analyze_dataset(frame, quality, request)
                assert cached_analysis(frame, quality, request) == expected
                item["analyses"][name] = {
                    "policy": (
                        "cache" if name != "portfolio_summary" else "esclusa dal costo della chiave"
                    ),
                    "uncached": measure(lambda: analyze_dataset(frame, quality, request), repeats),
                    "cached": measure(lambda: cached_analysis(frame, quality, request), repeats),
                }
            rows.append(item)
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "pandas": pd.__version__,
        "repeats": repeats,
        "multipliers": multipliers,
        "memory_method": "DataFrame deep e picco heap Python tracemalloc, non RSS o memoria nativa completa",
        "results": rows,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--multipliers", type=int, nargs="+", default=[1, 5, 20])
    parser.add_argument("--repeats", type=int, default=3)
    options = parser.parse_args()
    if options.repeats < 1 or any(value < 1 or value > 100 for value in options.multipliers):
        parser.error("Ripetizioni positive e moltiplicatori tra 1 e 100 richiesti.")
    print(json.dumps(benchmark(options.multipliers, options.repeats), indent=2))
