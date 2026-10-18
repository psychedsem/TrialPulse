"""Unit test con attese calcolate manualmente, senza server o provider."""

import numpy as np
import pandas as pd
import pytest
from pandas.testing import assert_frame_equal

from analytics import (
    analyze_dataset,
    clean_json,
    completeness,
    major_deviations_window,
    portfolio_summary,
    queries,
    ratio,
    retention,
)
from models import AnalyzeRequest


@pytest.mark.parametrize("numerator,denominator,expected", [(0, 0, None), (0, 4, 0), (3, 4, 75)])
def test_percentuale_denominatore_nullo(numerator, denominator, expected):
    assert ratio(numerator, denominator) == expected


def test_portfolio_conta_partecipanti_non_visite(visits_frame):
    assert portfolio_summary(visits_frame, {}) == {
        "screened_participants": 4,
        "enrolled_participants": 3,
        "screening_failures": 1,
        "enrollment_rate": 75,
        "studies": 2,
        "sites": 2,
    }


def test_recruitment_deduplica_prima_del_mese_escludendo_date_nulle(visits_frame, quality):
    before = visits_frame.copy(deep=True)
    request = AnalyzeRequest(analysis="recruitment", group_by=["month", "study_id"])
    report = analyze_dataset(visits_frame, quality, request)
    assert report["results"] == [
        {
            "month": "2026-01",
            "study_id": "PSI",
            "enrolled_participants": 1,
            "enrolled": 1,
            "cumulative_enrolled": 1,
        },
        {
            "month": "2026-02",
            "study_id": "PSI",
            "enrolled_participants": 1,
            "enrolled": 1,
            "cumulative_enrolled": 2,
        },
    ]
    assert report["data_quality"]["excluded_records"] == 1
    assert_frame_equal(visits_frame, before)
    assert quality["warnings"] == []


def test_filtri_intersecano_studio_e_sito(visits_frame, quality):
    request = AnalyzeRequest(
        analysis="portfolio_summary", filters={"study_id": "PSI", "site_id": "S1"}
    )
    report = analyze_dataset(visits_frame, quality, request)
    assert report["results"][0]["enrolled_participants"] == 1
    assert report["scope"]["study_id"] == "PSI"
    with pytest.raises(ValueError, match="inesistenti o incompatibili"):
        analyze_dataset(
            visits_frame, quality, AnalyzeRequest(analysis="visits", filters={"site_id": "ASSENTE"})
        )


def test_completeness_somma_denominatori_non_media_percentuali():
    result = completeness(
        pd.DataFrame({"required_assessments": [1, 9], "missing_assessments": [1, 0]}), {}
    )
    assert result["completeness_rate"] == 90
    assert (
        completeness(pd.DataFrame({"required_assessments": [0], "missing_assessments": [0]}), {})[
            "completeness_rate"
        ]
        is None
    )


def test_dropout_unico_e_motivi_nulli(visits_frame):
    frame = visits_frame.iloc[:3].assign(
        dropout=[True, True, False], dropout_reason=[None, None, None]
    )
    result = retention(frame, {})
    assert result["enrolled"] == 2
    assert result["dropouts"] == 1
    assert result["retention_rate"] == 50
    assert result["dropout_reasons"] == {}


def test_query_media_ponderata_esclude_solo_media_mancante():
    frame = pd.DataFrame(
        {
            "data_queries_opened": [4, 2, 8],
            "data_queries_open": [1, 1, 0],
            "mean_query_resolution_days": [2.0, 10.0, np.nan],
            "oldest_open_query_days": [9.0, 11.0, np.nan],
        }
    )
    result = queries(frame, {})
    assert result["queries_resolved_total"] == 12
    assert result["mean_query_resolution_days_weighted"] == 4
    assert result["oldest_open_query_days_max"] == 11


def test_finestra_mobile_inclusiva_pondera_eventi_e_separa_siti():
    frame = pd.DataFrame(
        {
            "site_id": ["S1", "S1", "S1", "S2"],
            "actual_date": pd.to_datetime(["2026-01-01", "2026-01-30", "2026-01-31", "2026-01-30"]),
            "protocol_deviations": [2, 1, 2, 8],
            "_actual_date_usable": [True, True, True, False],
        }
    )
    assert major_deviations_window(frame, {"window_days": 30, "min_count": 3}) == [
        {
            "site_id": "S1",
            "major_deviations_evaluable": 5,
            "excluded_invalid_dates": 0,
            "max_count_in_window": 3,
            "threshold_met": True,
            "first_trigger_date": "2026-01-30",
        },
        {
            "site_id": "S2",
            "major_deviations_evaluable": 0,
            "excluded_invalid_dates": 1,
            "max_count_in_window": 0,
            "threshold_met": False,
            "first_trigger_date": None,
        },
    ]


def test_finestra_mobile_storica_non_equivale_agli_ultimi_trenta_giorni():
    frame = pd.DataFrame(
        {
            "site_id": ["S1", "S1"],
            "actual_date": pd.to_datetime(["2025-01-01", "2026-06-01"]),
            "protocol_deviations": [3, 1],
            "_actual_date_usable": [True, True],
        }
    )
    result = major_deviations_window(frame, {"window_days": 30, "min_count": 3})[0]
    assert result["max_count_in_window"] == 3
    assert result["major_deviations_evaluable"] == 4
    assert result["first_trigger_date"] == "2025-01-01"


def test_json_annidato_normalizza_null_e_scalari_numpy():
    assert clean_json({"rows": [np.float64(1.236), np.nan, pd.NaT], "count": np.int64(2)}) == {
        "rows": [1.24, None, None],
        "count": 2,
    }
