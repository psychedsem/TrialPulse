"""Versioni, mutazioni e richieste equivalenti nella cache deterministica."""

from unittest.mock import Mock

import pandas as pd
import pytest

from analysis_cache import cached_analysis
from data_loader import load_analytic_dataset
from models import AnalyzeRequest


def test_snapshot_csv_copie_invalidation_e_refresh(tmp_path, monkeypatch):
    path = tmp_path / "synthetic.csv"
    row = {
        "participant_status": " Active ",
        "target_day": 1,
        "enrollment_date": "2026-01-01",
        "day0_date": "2026-01-01",
        "target_date": "2026-01-02",
        "scheduled_date": "2026-01-02",
        "actual_date": "2026-01-02",
        "data_queries_open": 1,
        "data_queries_opened": 2,
    }
    pd.DataFrame([row, row]).to_csv(path, index=False)
    read_csv = Mock(wraps=pd.read_csv)
    monkeypatch.setattr(pd, "read_csv", read_csv)
    frame, quality = load_analytic_dataset(path)
    assert quality["duplicates_removed"] == 1
    frame.loc[0, "participant_status"] = "modificato"
    quality["warnings"].append("modificato")
    again, clean_quality = load_analytic_dataset(path)
    assert again.loc[0, "participant_status"] == "active"
    assert "modificato" not in clean_quality["warnings"]
    assert read_csv.call_count == 1
    pd.DataFrame([{**row, "participant_status": "completed"}]).to_csv(path, index=False)
    assert load_analytic_dataset(path)[0].loc[0, "participant_status"] == "completed"
    load_analytic_dataset(path, refresh=True)
    load_analytic_dataset(path, use_cache=False)
    assert read_csv.call_count == 4


def test_report_parametri_filtri_e_frame_invalidation(visits_frame, quality):
    request = AnalyzeRequest(
        analysis="recruitment", group_by=["month"], filters={"study_id": "PSI"}
    )
    first = cached_analysis(visits_frame, quality, request)
    first["results"][0]["enrolled_participants"] = 99
    assert (
        cached_analysis(visits_frame, quality, request)["results"][0]["enrolled_participants"] == 1
    )
    other = AnalyzeRequest(analysis="recruitment", group_by=["month"], filters={"study_id": "ESK"})
    assert cached_analysis(visits_frame, quality, other)["results"] == []
    visits_frame.loc[2, "screening_failure"] = True
    assert len(cached_analysis(visits_frame, quality, request)["results"]) == 1


def test_report_equivalente_calcola_una_volta_e_non_cache_errori(
    visits_frame, quality, monkeypatch
):
    import analysis_cache
    from analytics import analyze_dataset

    analysis_cache.REPORTS.clear()
    run = Mock(wraps=analyze_dataset)
    monkeypatch.setattr(analysis_cache, "analyze_dataset", run)
    first = AnalyzeRequest(
        analysis="recruitment", group_by=["month"], filters={"site_id": "S1", "study_id": "PSI"}
    )
    other = AnalyzeRequest(
        analysis="recruitment", group_by=["month"], filters={"study_id": "PSI", "site_id": "S1"}
    )
    assert cached_analysis(visits_frame, quality, first) == cached_analysis(
        visits_frame, quality, other
    )
    assert run.call_count == 1
    quality["warnings"].append("Un avviso differente")
    assert cached_analysis(visits_frame, quality, first)["data_quality"]["warnings"] == [
        "Un avviso differente"
    ]
    assert run.call_count == 2
    bad = AnalyzeRequest(analysis="visits", filters={"site_id": "ASSENTE"})
    for _ in range(2):
        with pytest.raises(ValueError, match="inesistenti o incompatibili"):
            cached_analysis(visits_frame, quality, bad)
    assert run.call_count == 4


def test_configurazione_diversa_invalida_report(visits_frame, quality, tmp_path, monkeypatch):
    import analysis_cache

    path = tmp_path / "design.yaml"
    path.write_text("prima", encoding="utf-8")
    monkeypatch.setattr(analysis_cache, "DESIGN_PATH", path)
    run = Mock(side_effect=[{"value": 1}, {"value": 2}])
    monkeypatch.setattr(analysis_cache, "analyze_dataset", run)
    request = AnalyzeRequest(
        analysis="recruitment_target", parameters={"threshold_percent": 75, "consecutive_months": 2}
    )
    assert cached_analysis(visits_frame, quality, request) == {"value": 1}
    path.write_text("dopo", encoding="utf-8")
    assert cached_analysis(visits_frame, quality, request) == {"value": 2}


def test_analisi_rapide_non_usano_cache_costosa(visits_frame, quality, monkeypatch):
    import analysis_cache

    def forbidden(*args):
        pytest.fail("Una semplice aggregazione non deve calcolare una chiave di cache costosa")

    monkeypatch.setattr(analysis_cache.REPORTS, "get_or_create", forbidden)
    report = cached_analysis(visits_frame, quality, AnalyzeRequest(analysis="portfolio_summary"))
    assert report["results"][0]["enrolled_participants"] == 3
