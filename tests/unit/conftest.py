"""Dati minimi indipendenti dal CSV ufficiale."""

import pandas as pd
import pytest


@pytest.fixture
def visits_frame():
    return pd.DataFrame(
        {
            "participant_id": ["A", "A", "B", "C", "D"],
            "study_id": ["PSI", "PSI", "PSI", "ESK", "ESK"],
            "site_id": ["S1", "S1", "S2", "S1", "S1"],
            "screening_failure": [False, False, False, False, True],
            "enrollment_date": pd.to_datetime(
                ["2026-01-01", "2026-01-01", "2026-02-01", None, None]
            ),
            "visit_name": ["Week 1", "Week 2", "Week 1", "Week 1", "Screening"],
            "visit_status": ["completed", "missed", "completed", "completed", "completed"],
        }
    )


@pytest.fixture
def quality():
    return {
        "duplicates_removed": 0,
        "inconsistent_actual_dates": 0,
        "inconsistent_query_rows": 0,
        "warnings": [],
    }
