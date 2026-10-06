from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class AnalysisType(str, Enum):
    portfolio_summary = "portfolio_summary"
    recruitment = "recruitment"
    screening_failure = "screening_failure"
    retention = "retention"
    visits = "visits"
    completeness = "completeness"
    queries = "queries"
    deviations = "deviations"
    monitoring = "monitoring"
    efficacy = "efficacy"
    safety = "safety"
    out_of_window = "out_of_window"
    major_deviations_window = "major_deviations_window"
    consecutive_missed = "consecutive_missed"
    recruitment_target = "recruitment_target"
    query_aging_threshold = "query_aging_threshold"
    completeness_threshold = "completeness_threshold"


class GroupBy(str, Enum):
    study_id = "study_id"
    site_id = "site_id"
    visit_name = "visit_name"
    month = "month"


class AnalysisFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    study_id: str | None = None
    site_id: str | None = None
    participant_id: str | None = None
    visit_name: str | None = None


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    analysis: AnalysisType
    filters: AnalysisFilters = Field(default_factory=AnalysisFilters)
    group_by: list[GroupBy] = Field(default_factory=list)
    parameters: dict[str, Any] = Field(default_factory=dict)


class VisitWindow(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    study_id: str
    visit_name: str
    window_days: int = Field(ge=0)


class AnalysisParameters(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    visit_windows: list[VisitWindow] | None = Field(default=None, min_length=1)
    rate_threshold_percent: float | None = Field(default=None, ge=0, le=100)
    window_days: int | None = Field(default=None, gt=0)
    min_count: int | None = Field(default=None, gt=0)
    min_consecutive: int | None = Field(default=None, gt=0)
    threshold_percent: float | None = Field(default=None, ge=0, le=100)
    consecutive_months: int | None = Field(default=None, gt=0)
    threshold_days: float | None = Field(default=None, ge=0)
    attention_threshold_percent: float | None = Field(default=None, ge=0, le=100)
    escalation_threshold_percent: float | None = Field(default=None, ge=0, le=100)


REQUIRED_PARAMETERS = {
    "out_of_window": {"visit_windows"},
    "major_deviations_window": {"window_days", "min_count"},
    "consecutive_missed": {"min_consecutive"},
    "recruitment_target": {"threshold_percent", "consecutive_months"},
    "query_aging_threshold": {"threshold_days"},
    "completeness_threshold": {"attention_threshold_percent", "escalation_threshold_percent"},
}


def validate_parameters(analysis, parameters):
    required = REQUIRED_PARAMETERS.get(analysis, set())
    optional = {"rate_threshold_percent"} if analysis == "out_of_window" else set()
    if set(parameters) - required - optional:
        raise ValueError("Parametri non supportati per questa analisi.")
    if any(parameters.get(key) is None for key in required):
        raise ValueError("Parametri obbligatori: " + ", ".join(sorted(required)))
    try:
        values = AnalysisParameters.model_validate(parameters).model_dump(exclude_none=True)
    except ValidationError as exc:
        fields = ", ".join(".".join(map(str, item["loc"])) for item in exc.errors())
        raise ValueError("Parametri fuori dominio o di tipo errato: " + fields) from exc
    if analysis == "completeness_threshold" and values["escalation_threshold_percent"] > values["attention_threshold_percent"]:
        raise ValueError("La soglia di escalation non può superare la soglia di attenzione.")
    return values