from pathlib import Path
from numbers import Real

import pandas as pd
import yaml

from models import validate_parameters


DESIGN_PATH = Path(__file__).resolve().parent / "config/study_design.yaml"
STUDY_SITE = {"study_id", "site_id"}
VISIT_GROUPS = STUDY_SITE | {"visit_name"}
GROUPS = {
    "portfolio_summary": STUDY_SITE, "recruitment": STUDY_SITE | {"month"},
    "screening_failure": STUDY_SITE, "retention": STUDY_SITE,
    "visits": VISIT_GROUPS, "completeness": VISIT_GROUPS, "queries": VISIT_GROUPS,
    "deviations": VISIT_GROUPS | {"month"}, "monitoring": VISIT_GROUPS,
    "efficacy": {"visit_name", "site_id"}, "safety": STUDY_SITE,
    "out_of_window": VISIT_GROUPS, "major_deviations_window": set(),
    "consecutive_missed": set(), "recruitment_target": set(),
    "query_aging_threshold": STUDY_SITE, "completeness_threshold": VISIT_GROUPS,
}

DETAIL_FILTERS = STUDY_SITE | {"participant_id", "visit_name"}
PARTICIPANT_FILTERS = STUDY_SITE | {"participant_id"}
FILTERS = {
    "portfolio_summary": STUDY_SITE, "recruitment": STUDY_SITE,
    "screening_failure": STUDY_SITE, "retention": STUDY_SITE,
    "visits": DETAIL_FILTERS, "completeness": DETAIL_FILTERS,
    "queries": DETAIL_FILTERS, "deviations": DETAIL_FILTERS,
    "monitoring": DETAIL_FILTERS, "efficacy": DETAIL_FILTERS,
    "safety": STUDY_SITE, "out_of_window": DETAIL_FILTERS,
    "major_deviations_window": STUDY_SITE,
    "consecutive_missed": PARTICIPANT_FILTERS,
    "recruitment_target": STUDY_SITE,
    "query_aging_threshold": DETAIL_FILTERS,
    "completeness_threshold": DETAIL_FILTERS,
}


def ratio(numerator, denominator):
    return numerator / denominator * 100 if denominator else None


def clean_json(value):
    if isinstance(value, dict):
        return {key: clean_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean_json(item) for item in value]
    if value is None or pd.isna(value):
        return None
    if hasattr(value, "item"):
        value = value.item()
    return round(float(value), 2) if isinstance(value, Real) and not isinstance(value, (int, bool)) else value


def portfolio_summary(df, parameters):
    screened = df.participant_id.nunique()
    enrolled = df.loc[df.screening_failure.eq(False), "participant_id"].nunique()
    return {"screened_participants": screened, "enrolled_participants": enrolled,
            "screening_failures": df.loc[df.screening_failure.eq(True), "participant_id"].nunique(),
            "enrollment_rate": ratio(enrolled, screened), "studies": df.study_id.nunique(),
            "sites": df.site_id.nunique()}


def recruitment(df, parameters):
    return {"enrolled_participants": df.participant_id.nunique()}


def screening_failure(df, parameters):
    result = portfolio_summary(df, parameters)
    return {"screened": result["screened_participants"], "passed": result["enrolled_participants"],
            "failed": result["screening_failures"],
            "failure_rate": ratio(result["screening_failures"], result["screened_participants"])}


def retention(df, parameters):
    enrolled = df.participant_id.nunique()
    dropout = df.loc[df.dropout.eq(True)].drop_duplicates("participant_id")
    count = dropout.participant_id.nunique()
    return {"enrolled": enrolled, "dropouts": count, "retained": enrolled-count,
            "dropout_rate": ratio(count, enrolled), "retention_rate": ratio(enrolled-count, enrolled),
            "dropout_reasons": dropout.dropout_reason.value_counts().to_dict()}


def visits(df, parameters):
    completed, missed = int(df.visit_status.eq("completed").sum()), int(df.visit_status.eq("missed").sum())
    return {"expected_visits": len(df), "completed_visits": completed, "missed_visits": missed,
            "completion_rate": ratio(completed, len(df)), "missed_rate": ratio(missed, len(df))}


def completeness(df, parameters):
    required, missing = df.required_assessments.sum(), df.missing_assessments.sum()
    return {"required_assessments_total": required, "missing_assessments_total": missing,
            "completed_assessments_total": required-missing, "completeness_rate": ratio(required-missing, required)}


def queries(df, parameters):
    opened, still_open = df.data_queries_opened.sum(), df.data_queries_open.sum()
    resolved = df.data_queries_opened - df.data_queries_open
    usable = resolved.gt(0) & df.mean_query_resolution_days.notna()
    weight = resolved[usable].sum()
    mean = (df.loc[usable, "mean_query_resolution_days"] * resolved[usable]).sum() / weight if weight else None
    return {"queries_opened_total": opened, "queries_open_total": still_open,
            "queries_resolved_total": resolved.sum(), "open_rate": ratio(still_open, opened),
            "oldest_open_query_days_max": df.loc[df.data_queries_open.gt(0), "oldest_open_query_days"].max(),
            "mean_query_resolution_days_weighted": mean}


def deviations(df, parameters):
    return {"deviations_total": df.protocol_deviations.sum(),
            "major_deviations": df.loc[df.deviation_severity.eq("major"), "protocol_deviations"].sum(),
            "minor_deviations": df.loc[df.deviation_severity.eq("minor"), "protocol_deviations"].sum(),
            "deviation_types": df.groupby("deviation_type").protocol_deviations.sum().to_dict()}


def monitoring(df, parameters):
    result = {}
    for prefix, column in [("monitoring", "required_monitoring_complete"), ("documentation", "session_documentation_complete")]:
        eligible = df[column].notna().sum()
        complete = df[column].eq(True).sum()
        result.update({f"{prefix}_required_visits": eligible, f"{prefix}_complete_visits": complete,
                       f"{prefix}_incomplete_visits": df[column].eq(False).sum(),
                       f"{prefix}_completion_rate": ratio(complete, eligible)})
    minutes = df.monitoring_minutes.dropna()
    result.update({f"monitoring_minutes_{key}": getattr(minutes, key)() for key in ["count", "mean", "median", "min", "max"]})
    return result


def efficacy(df, parameters):
    scales = df.depression_scale.dropna().unique()
    result = {"synthetic_data": True, "depression_scale": scales[0] if len(scales) else None,
              "evaluable_scores": df.depression_score.notna().sum(), "mean_depression_score": df.depression_score.mean(),
              "mean_change_from_baseline": df.depression_change_from_baseline.mean()}
    for metric in ["response", "remission"]:
        values = df[f"clinical_{metric}"].dropna()
        result.update({f"{metric}_evaluable": len(values), f"{metric}_count": values.eq(True).sum(),
                       f"{metric}_rate": ratio(values.eq(True).sum(), len(values))})
    return result


def safety(df, parameters):
    count = df.participant_id.nunique()
    result = {"synthetic_data": True, "enrolled_participants": count}
    for metric, column in [("ae", "adverse_event"), ("sae", "serious_adverse_event"),
                           ("ae_discontinuation", "ae_leading_to_discontinuation")]:
        positive = df.loc[df[column].eq(True)]
        participants = positive.participant_id.nunique()
        result.update({f"participants_with_{metric}": participants,
                       f"participants_with_{metric}_rate": ratio(participants, count),
                       f"{metric}_positive_visit_records" if metric != "ae_discontinuation" else "ae_discontinuation_visit_records": len(positive)})
    return result


def out_of_window(df, parameters):
    count = df._out_of_window.sum()
    rate = ratio(count, len(df))
    result = {"evaluable_visits": len(df), "out_of_window_visits": count, "out_of_window_rate": rate}
    if "rate_threshold_percent" in parameters:
        result["threshold_exceeded"] = rate > parameters["rate_threshold_percent"] if rate is not None else None
    return result


def query_aging_threshold(df, parameters):
    return {"open_query_rows_evaluable": len(df),
            "rows_above_threshold": df.oldest_open_query_days.gt(parameters["threshold_days"]).sum(),
            "max_oldest_open_query_days": df.oldest_open_query_days.max()}


def completeness_threshold(df, parameters):
    result = completeness(df, parameters)
    rate = result["completeness_rate"]
    action = None if rate is None else "no_action"
    if rate is not None:
        if rate < parameters["escalation_threshold_percent"]:
            action = "escalation"
        elif rate < parameters["attention_threshold_percent"]:
            action = "attention"
    return {**result, "classification": action}


METRICS = {function.__name__: function for function in [portfolio_summary, recruitment, screening_failure,
           retention, visits, completeness, queries, deviations, monitoring, efficacy, safety,
           out_of_window, query_aging_threshold, completeness_threshold]}


def major_deviations_window(df, parameters):
    results = []
    for site, rows in df.groupby("site_id", sort=True):
        valid = rows.loc[rows._actual_date_usable].sort_values("actual_date")
        left, maximum, trigger = 0, 0, None
        dates = valid.actual_date.tolist()
        counts = valid.protocol_deviations.tolist()
        current = 0
        for right, date in enumerate(dates):
            current += counts[right]
            start = date - pd.Timedelta(days=parameters["window_days"]-1)
            while dates[left] < start:
                current -= counts[left]
                left += 1
            maximum = max(maximum, current)
            if trigger is None and current >= parameters["min_count"]:
                trigger = date.strftime("%Y-%m-%d")
        results.append({"site_id": site, "major_deviations_evaluable": valid.protocol_deviations.sum(),
                        "excluded_invalid_dates": len(rows)-len(valid), "max_count_in_window": maximum,
                        "threshold_met": maximum >= parameters["min_count"], "first_trigger_date": trigger})
    return results


def consecutive_missed(df, parameters):
    results = []
    for participant, rows in df.groupby("participant_id", sort=True):
        maximum, current = 0, 0
        for status in rows.sort_values("visit_sequence").visit_status:
            current = current+1 if status == "missed" else 0
            maximum = max(maximum, current)
        if maximum >= parameters["min_consecutive"]:
            first = rows.iloc[0]
            results.append({"participant_id": participant, "study_id": first.study_id, "site_id": first.site_id,
                            "max_consecutive_missed": maximum})
    return results


def recruitment_target(df, parameters, filters):
    design = yaml.safe_load(DESIGN_PATH.read_text(encoding="utf-8"))
    results = []
    for study, calendar in design["recruitment"].items():
        if filters.get("study_id") and filters["study_id"] != study:
            continue
        for site, allocation in design["site_allocation"][study].items():
            if filters.get("site_id") and filters["site_id"] != site:
                continue
            subset = df.loc[df.study_id.eq(study) & df.site_id.eq(site)]
            actual = subset.groupby(subset.enrollment_date.dt.strftime("%Y-%m")).participant_id.nunique()
            monthly, streak, trigger, previous = [], [], None, None
            for month in calendar["months"]:
                target = allocation["monthly_target"]
                count = int(actual.get(month, 0))
                achievement = ratio(count, target)
                below = achievement < parameters["threshold_percent"] if achievement is not None else None
                period = pd.Period(month, freq="M")
                if below:
                    streak = streak+[month] if previous is not None and period == previous+1 else [month]
                else:
                    streak = []
                if trigger is None and len(streak) >= parameters["consecutive_months"]:
                    trigger = streak.copy()
                previous = period
                monthly.append({"month": month, "actual_enrolled": count, "target_enrolled": target,
                                "achievement_percent": achievement, "below_threshold": below})
            results.append({"study_id": study, "site_id": site, "monthly": monthly,
                            "trigger_met": trigger is not None, "first_trigger_months": trigger})
    return results


def analyze_dataset(source, quality, request):
    analysis = request.analysis.value
    groups = [item.value for item in request.group_by]
    if len(set(groups)) != len(groups) or set(groups) - GROUPS[analysis]:
        raise ValueError("Raggruppamento duplicato o non supportato per questa analisi.")
    filters = request.filters.model_dump(exclude_none=True)
    unsupported_filters = set(filters) - FILTERS[analysis]
    if unsupported_filters:
        raise ValueError(
            "Filtri non supportati per questa analisi: "
            + ", ".join(sorted(unsupported_filters))
        )
    df = source.copy()
    for column, value in filters.items():
        df = df.loc[df[column].eq(value)]
    if filters and df.empty:
        raise ValueError("Filtri inesistenti o incompatibili nel perimetro richiesto.")
    parameters = validate_parameters(analysis, request.parameters)
    if analysis == "efficacy":
        if not filters.get("study_id"):
            raise ValueError("efficacy richiede un singolo study_id.")
        if df.depression_scale.dropna().nunique() > 1:
            raise ValueError("efficacy non può combinare scale diverse.")
    info = {**quality, "warnings": list(quality["warnings"]), "scope_rows": len(df),
            "excluded_records": 0, "exclusions_by_reason": {}}
    excluded = set()

    def report(rows, reason):
        if len(rows):
            excluded.update(rows.index)
            info["exclusions_by_reason"][reason] = len(rows)
            info["warnings"].append(f"{len(rows)} righe escluse dal calcolo pertinente: {reason}.")

    if analysis in {"retention", "safety", "visits", "consecutive_missed", "recruitment", "recruitment_target"}:
        df = df.loc[df.screening_failure.eq(False)]
    if analysis in {"visits", "consecutive_missed"}:
        df = df.loc[df.visit_name.ne("Screening") & df.visit_status.ne("not_expected_after_dropout")]
    if analysis in {"completeness", "completeness_threshold"}:
        df = df.loc[df.required_assessments.gt(0)]
    if analysis in {"recruitment", "recruitment_target"}:
        df = df.drop_duplicates("participant_id")
        report(df.loc[df.enrollment_date.isna()], "enrollment_date mancante o non valida")
        df = df.loc[df.enrollment_date.notna()]
        if "month" in groups:
            df["month"] = df.enrollment_date.dt.strftime("%Y-%m")
    if analysis in {"queries", "query_aging_threshold"}:
        report(df.loc[~df._query_consistent], "query incoerenti")
        df = df.loc[df._query_consistent]
        if analysis == "queries":
            report(df.loc[(df.data_queries_opened-df.data_queries_open).gt(0) & df.mean_query_resolution_days.isna()],
                   "resolution mancante (solo media)")
            report(df.loc[df.data_queries_open.gt(0) & df.oldest_open_query_days.isna()], "aging mancante (solo aging)")
        else:
            df = df.loc[df.data_queries_open.gt(0)]
            report(df.loc[df.oldest_open_query_days.isna()], "aging mancante")
            df = df.loc[df.oldest_open_query_days.notna()]
    if analysis in {"deviations", "major_deviations_window"}:
        df = df.loc[df.protocol_deviations.gt(0)]
        if analysis == "major_deviations_window":
            df = df.loc[df.deviation_severity.eq("major")]
        if "month" in groups or analysis == "major_deviations_window":
            report(df.loc[~df._actual_date_usable], "actual_date inutilizzabile")
        if "month" in groups:
            df = df.loc[df._actual_date_usable].copy()
            df["month"] = df.actual_date.dt.strftime("%Y-%m")
    if analysis == "out_of_window":
        windows = pd.DataFrame(parameters["visit_windows"])
        for row in windows.itertuples():
            match = source.loc[source.study_id.eq(row.study_id) & source.visit_name.eq(row.visit_name)]
            if match.empty or row.visit_name == "Screening":
                raise ValueError("Finestra per studio/visita inesistente o Screening non ammesso.")
        if windows.duplicated(["study_id", "visit_name"]).any():
            raise ValueError("Finestre duplicate per la stessa coppia studio/visita.")
        lookup = windows.set_index(["study_id", "visit_name"]).window_days.to_dict()
        df["_window_days"] = [lookup.get((study, visit)) for study, visit in zip(df.study_id, df.visit_name)]
        df = df.loc[df._window_days.notna() & df.visit_status.eq("completed")]
        usable = df._actual_date_usable & df.target_date.notna()
        report(df.loc[~usable], "date visita inutilizzabili")
        df = df.loc[usable].copy()
        df["_out_of_window"] = (df.actual_date-df.target_date).dt.days.abs().gt(df._window_days)
    if analysis == "monitoring":
        outliers = df.monitoring_minutes.le(10) | df.monitoring_minutes.ge(500)
        info["monitoring_outlier_records"] = int(outliers.sum())
        if outliers.any():
            info["warnings"].append(f"{int(outliers.sum())} valori estremi di monitoring_minutes, mantenuti senza correzione.")
    if analysis == "major_deviations_window":
        results = major_deviations_window(df, parameters)
    elif analysis == "consecutive_missed":
        results = consecutive_missed(df, parameters)
    elif analysis == "recruitment_target":
        results = recruitment_target(df, parameters, filters)
    else:
        results = []
        grouped = df.groupby(groups, sort=True, dropna=False) if groups else [((), df)]
        for keys, rows in grouped:
            keys = keys if isinstance(keys, tuple) else (keys,)
            results.append({**dict(zip(groups, keys)), **METRICS[analysis](rows, parameters)})
        if analysis == "recruitment" and "month" in groups:
            totals = {}
            for row in results:
                key = tuple(row[column] for column in groups if column != "month")
                totals[key] = totals.get(key, 0)+row["enrolled_participants"]
                row.update(enrolled=row["enrolled_participants"], cumulative_enrolled=totals[key])
    info["excluded_records"] = len(excluded)
    response = {"analysis": analysis, "scope": {**request.filters.model_dump(), "group_by": groups},
                "parameters_applied": parameters, "results": results, "data_quality": info}
    if analysis == "consecutive_missed":
        response["participants_with_trigger"] = len(results)
    return clean_json(response)