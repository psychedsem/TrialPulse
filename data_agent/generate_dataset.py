# Generatore dataset sintetico TrialPulse
from pathlib import Path
import hashlib
import numpy as np
import pandas as pd
import yaml

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
CONFIG_DIR = BASE_DIR / "config"
DATA_DIR = PROJECT_ROOT / "data"

def load_yaml(name):
    with open(CONFIG_DIR / name, encoding="utf-8") as file:
        return yaml.safe_load(file)

study_design = load_yaml("study_design.yaml")
study_profiles = load_yaml("study_profiles.yaml")
generation_config = load_yaml("synthetic_generation.yaml")
plausibility_config = load_yaml("plausibility_ranges.yaml")
DEVELOPMENT_SEED = generation_config["generation"]["development_seed"]
REPRODUCIBILITY_FILE = CONFIG_DIR / "reproducibility.yaml"
MASTER_SEED = int(load_yaml("reproducibility.yaml")["master_seed"]) if REPRODUCIBILITY_FILE.exists() else DEVELOPMENT_SEED
PREFIXES = {"NNR-PSI-01": "PSI", "NNR-ESK-02": "ESK", "NNR-DXB-03": "DXB", "NNR-SER-04": "SER"}
SCHEMA = (
    "record_id study_id intervention intervention_class site_id city country participant_id screening_status screening_failure "
    "enrollment_date participant_status visit_name visit_sequence day0_date target_day target_date scheduled_date actual_date "
    "visit_status dropout dropout_reason required_assessments missing_assessments data_queries_opened data_queries_open "
    "oldest_open_query_days mean_query_resolution_days protocol_deviations deviation_type deviation_severity monitoring_minutes "
    "required_monitoring_complete session_documentation_complete depression_scale baseline_depression_score depression_score "
    "depression_change_from_baseline clinical_response clinical_remission adverse_event serious_adverse_event ae_leading_to_discontinuation"
).split()

def make_rng(study_id="", site_id="", participant_id="", visit_name="", component=""):
    key = "|".join(map(str, [MASTER_SEED, study_id, site_id, participant_id, visit_name, component]))
    return np.random.default_rng(int(hashlib.sha256(key.encode()).hexdigest()[:16], 16))

def row_rng(row, component):
    return make_rng(row["study_id"], row["site_id"], row["participant_id"], row.get("visit_name", ""), component)

def scores(frame, component):
    return [row_rng(row, component).random() for _, row in frame.iterrows()]

def pick(frame, component, n, ascending=True):
    ranked = frame.assign(_score=scores(frame, component)).sort_values("_score", ascending=ascending)
    return ranked.head(n).index

def random_date(rng, start, end):
    return start + pd.Timedelta(days=int(rng.integers(0, (end - start).days + 1)))

def site_setting(section, site_id):
    values = generation_config[section]
    return values.get(site_id, values["default"])

def validate_config():
    study_ids = set(study_design["studies"])
    assert study_ids == set(study_profiles["studies"]) == set(plausibility_config["efficacy"]) == set(plausibility_config["safety"])
    for section in ["dropout_probability", "missed_visit_probability", "missing_assessment_probability"]:
        assert study_ids == set(generation_config[section])
    for study_id, study in study_design["studies"].items():
        allocation, recruitment = study_design["site_allocation"][study_id], study_design["recruitment"][study_id]
        assert sum(x["screened"] for x in allocation.values()) == study["screened"]
        assert sum(x["enrolled"] for x in allocation.values()) == study["enrolled"]
        assert len(study_design["schedule"][study_id]) == study["visits"]
        assert all(sum(recruitment[site_id]) == site["enrolled"] for site_id, site in allocation.items())

def create_participants():
    rows = []
    for study_id, sites in study_design["site_allocation"].items():
        for site_id, allocation in sites.items():
            site_number = site_id.split("_")[1]
            rows.extend({"study_id": study_id, "site_id": site_id, "participant_id": f"{PREFIXES[study_id]}-S{site_number}-P{n:03d}"}
                        for n in range(1, allocation["screened"] + 1))
    participants = pd.DataFrame(rows)
    participants["screening_status"], participants["screening_failure"] = "failed", True
    for (study_id, site_id), group in participants.groupby(["study_id", "site_id"]):
        enrolled = study_design["site_allocation"][study_id][site_id]["enrolled"]
        rank = [make_rng(study_id, site_id, pid, component="screening_status").random() for pid in group["participant_id"]]
        selected = group.assign(score=rank).sort_values("score").head(enrolled).index
        participants.loc[selected, ["screening_status", "screening_failure"]] = ["passed", False]
    assert len(participants) == 194 and (~participants["screening_failure"]).sum() == 154 and participants["screening_failure"].sum() == 40
    return participants

def add_participant_dates(participants):
    participants = participants.copy()
    participants[["screening_date", "enrollment_date", "day0_date"]] = pd.NaT
    for study_id, recruitment in study_design["recruitment"].items():
        study = study_design["studies"][study_id]
        day0_start, day0_end = pd.to_datetime([study["day0_start"], study["day0_end"]])
        for site_id in study_design["site_allocation"][study_id]:
            mask = participants["study_id"].eq(study_id) & participants["site_id"].eq(site_id) & ~participants["screening_failure"]
            selected = participants[mask].copy()
            selected["score"] = [make_rng(study_id, site_id, pid, component="recruitment_order").random() for pid in selected["participant_id"]]
            selected, position = selected.sort_values("score"), 0
            for month, count in zip(recruitment["months"], recruitment[site_id]):
                month_start = pd.to_datetime(month + "-01")
                start, end = max(month_start, day0_start), min(month_start + pd.offsets.MonthEnd(0), day0_end)
                for index, participant in selected.iloc[position:position + count].iterrows():
                    pid = participant["participant_id"]
                    day0 = random_date(make_rng(study_id, site_id, pid, component="day0_date"), start, end)
                    rng = make_rng(study_id, site_id, pid, component="screening_date")
                    offset = int(rng.integers(study["screening_min_day"], study["screening_max_day"] + 1))
                    participants.loc[index, "screening_date"] = day0 + pd.Timedelta(days=offset)
                    participants.loc[index, ["enrollment_date", "day0_date"]] = [day0, day0]
                position += count
    for index, row in participants[participants["screening_failure"]].iterrows():
        study = study_design["studies"][row["study_id"]]
        start = pd.to_datetime(study["day0_start"]) + pd.Timedelta(days=study["screening_min_day"])
        end = pd.to_datetime(study["day0_end"]) + pd.Timedelta(days=study["screening_max_day"])
        participants.loc[index, "screening_date"] = random_date(row_rng(row, "failed_screening_date"), start, end)
    failed = participants["screening_failure"]
    assert participants.loc[~failed, ["screening_date", "enrollment_date", "day0_date"]].notna().all().all()
    assert participants.loc[failed, ["enrollment_date", "day0_date"]].isna().all().all()
    return participants

def create_visit_scaffold(participants):
    rows = []
    for _, p in participants.iterrows():
        study_id, site_id, pid = p["study_id"], p["site_id"], p["participant_id"]
        study, site = study_design["studies"][study_id], study_design["sites"][site_id]
        schedule = study_design["schedule"][study_id][:1] if p["screening_failure"] else study_design["schedule"][study_id]
        for visit in schedule:
            name, sequence, target_day = visit["name"], visit["sequence"], visit["target_day"]
            if name == "Screening":
                target = scheduled = actual = p["screening_date"]
            else:
                target, actual = p["day0_date"] + pd.Timedelta(days=target_day), pd.NaT
                scheduled = target
                if target_day != 0:
                    jitter = generation_config["scheduling_jitter_days"][study_id]
                    offset = int(make_rng(study_id, site_id, pid, name, "scheduled_date").integers(-jitter, jitter + 1))
                    scheduled += pd.Timedelta(days=offset)
            status = "screen_failed" if p["screening_failure"] else "screening" if name == "Screening" else "active"
            rows.append({"record_id": f"{pid}-V{sequence:02d}", "study_id": study_id, "intervention": study["intervention"],
                         "intervention_class": study["intervention_class"], "site_id": site_id, "city": site["city"], "country": site["country"],
                         "participant_id": pid, "screening_status": p["screening_status"], "screening_failure": bool(p["screening_failure"]),
                         "enrollment_date": p["enrollment_date"], "participant_status": status, "visit_name": name, "visit_sequence": sequence,
                         "day0_date": p["day0_date"], "target_day": target_day, "target_date": target, "scheduled_date": scheduled,
                         "actual_date": actual, "visit_status": "completed", "dropout": False, "dropout_reason": None})
    data = pd.DataFrame(rows)
    assert len(data) == 1500 and data["record_id"].is_unique
    return data

def apply_retention(data, participants):
    cfg = generation_config
    reasons = ["withdrew_consent", "lost_to_follow_up", "scheduling_burden", "relocation", "other"]
    forced = {}
    for study_id in ["NNR-PSI-01", "NNR-SER-04"]:
        mask = participants["study_id"].eq(study_id) & participants["site_id"].eq("SITE_07") & ~participants["screening_failure"]
        forced[study_id] = participants.loc[mask, "participant_id"].sort_values().iloc[0]
    for pid, group in data[~data["screening_failure"]].groupby("participant_id"):
        group = group.sort_values("visit_sequence")
        study_id, site_id = group.iloc[0][["study_id", "site_id"]]
        rng = make_rng(study_id, site_id, pid, component="dropout_decision")
        if (site_id == "SITE_07" and pid == forced.get(study_id)) or rng.random() >= cfg["dropout_probability"][study_id]:
            continue
        minimum = 4 if study_id in ["NNR-PSI-01", "NNR-ESK-02"] else 3
        candidates = group[(group["visit_sequence"] >= minimum) & (group["visit_sequence"] < group["visit_sequence"].max())]
        rng = make_rng(study_id, site_id, pid, component="dropout_visit")
        index = candidates.index[int(rng.integers(0, len(candidates)))]
        rng = make_rng(study_id, site_id, pid, component="dropout_reason")
        reason, sequence = reasons[int(rng.integers(0, len(reasons)))], int(data.loc[index, "visit_sequence"])
        data.loc[index, ["dropout", "dropout_reason"]] = [True, reason]
        after = data["participant_id"].eq(pid) & (data["visit_sequence"] > sequence)
        data.loc[after, "visit_status"], data.loc[after, "scheduled_date"] = "not_expected_after_dropout", pd.NaT
    protected_visits = ["Screening", "Baseline", "Preparazione 2 / Baseline"]
    for index, row in data.iterrows():
        if row["visit_name"] in protected_visits or row["visit_status"] == "not_expected_after_dropout" or row["dropout"]: continue
        probability = cfg["missed_visit_probability"][row["study_id"]] * cfg["site_missed_modifier"][row["site_id"]]
        if row_rng(row, "missed_visit").random() < min(probability, 0.35): data.loc[index, "visit_status"] = "missed"
    for study_id, sequences in {"NNR-PSI-01": [6, 7], "NNR-SER-04": [4, 5]}.items():
        mask = data["study_id"].eq(study_id) & data["participant_id"].eq(forced[study_id]) & data["visit_sequence"].isin(sequences)
        data.loc[mask, "visit_status"] = "missed"
    eligible = data["site_id"].eq("SITE_07") & ~data["screening_failure"] & ~data["visit_name"].eq("Screening") & ~data["visit_status"].eq("not_expected_after_dropout")
    minimum = int(np.ceil(eligible.sum() * cfg["ground_truth"]["SITE_07"]["minimum_missed_visit_rate"]))
    needed = max(0, minimum - int((eligible & data["visit_status"].eq("missed")).sum()))
    if needed:
        candidates = data[eligible & data["visit_status"].eq("completed") & ~data["dropout"]]
        data.loc[pick(candidates, "site07_ground_truth_missed", needed), "visit_status"] = "missed"
    for index, row in data.iterrows():
        if row["visit_name"] == "Screening" or row["visit_status"] != "completed": continue
        if row["target_day"] == 0:
            data.loc[index, "actual_date"] = row["target_date"]; continue
        rng, jitter = row_rng(row, "actual_date"), cfg["attendance_jitter_days"][row["study_id"]]
        offset = int(rng.integers(-jitter, jitter + 1))
        if rng.random() < cfg["disruption_probability"][row["study_id"]]: offset += (-1 if rng.random() < 0.25 else 1) * int(rng.integers(5, 13))
        actual = row["scheduled_date"] + pd.Timedelta(days=offset)
        data.loc[index, "actual_date"] = row["day0_date"] if row["target_day"] > 0 and actual < row["day0_date"] else actual
    data.loc[data["visit_status"] != "completed", "actual_date"] = pd.NaT
    for pid, group in data.groupby("participant_id"):
        if bool(group["screening_failure"].iloc[0]): continue
        dropout = group[group["dropout"]]
        if dropout.empty:
            final = group.sort_values("visit_sequence").index[-1]
            if data.loc[final, "visit_status"] == "completed": data.loc[final, "participant_status"] = "completed"
        else:
            sequence = int(dropout.iloc[0]["visit_sequence"])
            data.loc[data["participant_id"].eq(pid) & (data["visit_sequence"] >= sequence), "participant_status"] = "withdrawn"
    return data

def required_assessments(row):
    if row["visit_status"] != "completed": return 0
    if row["visit_name"] == "Screening": return 4
    if row["study_id"] == "NNR-PSI-01": return 8 if row["visit_name"] == "Dosing Day" else 4 if "Preparazione" in row["visit_name"] else 5
    if row["study_id"] == "NNR-ESK-02": return 6
    return 5 if row["visit_name"] == "Baseline" else 4

def apply_completeness_and_queries(data):
    cfg = generation_config
    data["required_assessments"] = data.apply(required_assessments, axis=1); data["missing_assessments"] = 0
    data[["data_queries_opened", "data_queries_open"]] = 0; data[["oldest_open_query_days", "mean_query_resolution_days"]] = np.nan
    for index, row in data.iterrows():
        required = int(row["required_assessments"])
        if required:
            probability = cfg["missing_assessment_probability"][row["study_id"]] * cfg["site_completeness_modifier"][row["site_id"]]
            data.loc[index, "missing_assessments"] = int(row_rng(row, "missing_assessments").binomial(required, probability))
        if row["visit_status"] != "completed": continue
        lam = (0.03 + 0.035 * required + 0.55 * int(data.loc[index, "missing_assessments"])) * cfg["study_query_modifier"][row["study_id"]]
        rng, opened = row_rng(row, "data_queries"), 0
        opened = int(rng.poisson(lam)); open_count = int(rng.binomial(opened, site_setting("query_open_probability", row["site_id"]))) if opened else 0
        data.loc[index, ["data_queries_opened", "data_queries_open"]] = [opened, open_count]
        if open_count:
            limits = site_setting("query_aging_days", row["site_id"]); data.loc[index, "oldest_open_query_days"] = int(rng.integers(limits["min"], limits["max"] + 1))
        if opened > open_count:
            limits = site_setting("query_resolution_days", row["site_id"]); data.loc[index, "mean_query_resolution_days"] = round(float(rng.uniform(limits["min"], limits["max"])), 1)
    candidates = data[data["site_id"].eq("SITE_05") & data["visit_status"].eq("completed")].copy()
    for index in pick(candidates, "site05_ground_truth_query", 8):
        row = data.loc[index]; opened, open_count = max(1, int(row["data_queries_opened"])), max(1, int(row["data_queries_open"]))
        data.loc[index, ["data_queries_opened", "data_queries_open"]] = [opened, open_count]
        data.loc[index, "oldest_open_query_days"] = int(row_rng(row, "site05_ground_truth_age").integers(18, 31))
        if opened == open_count: data.loc[index, "mean_query_resolution_days"] = np.nan
    mask = data["site_id"].eq("SITE_05") & (data["data_queries_open"] > 0); minimum = cfg["ground_truth"]["SITE_05"]["minimum_open_query_age_days"]
    data.loc[mask & (data["oldest_open_query_days"].isna() | (data["oldest_open_query_days"] < minimum)), "oldest_open_query_days"] = minimum
    return data

def apply_monitoring_and_deviations(data):
    cfg = generation_config
    data["monitoring_minutes"] = np.nan; data["required_monitoring_complete"] = pd.NA; data["session_documentation_complete"] = pd.NA
    for index, row in data[data["visit_status"].eq("completed")].iterrows():
        limits = cfg["monitoring"]["NNR-PSI-01"]["dosing_day_minutes"] if row["study_id"] == "NNR-PSI-01" and row["visit_name"] == "Dosing Day" else None
        if row["study_id"] == "NNR-ESK-02" and row["visit_name"] not in ["Screening", "Baseline"]: limits = cfg["monitoring"]["NNR-ESK-02"]["visit_minutes"]
        if limits:
            data.loc[index, "monitoring_minutes"] = int(row_rng(row, "monitoring").integers(limits["min"], limits["max"] + 1))
            key = "SITE_06_ESK" if row["study_id"] == "NNR-ESK-02" and row["site_id"] == "SITE_06" else "default"
            data.loc[index, "required_monitoring_complete"] = bool(row_rng(row, "monitoring_complete").random() < cfg["monitoring_complete_probability"][key])
        if row["study_id"] == "NNR-PSI-01" and row["visit_name"] == "Dosing Day":
            key = "SITE_01_PSI" if row["site_id"] == "SITE_01" else "default"
            data.loc[index, "session_documentation_complete"] = bool(row_rng(row, "session_documentation").random() < cfg["session_documentation_complete_probability"][key])
    psi = data[data["study_id"].eq("NNR-PSI-01") & data["site_id"].eq("SITE_01") & data["visit_name"].eq("Dosing Day") & data["visit_status"].eq("completed")]
    missing = cfg["ground_truth"]["SITE_01"]["minimum_incomplete_dosing_records"] - int(psi["session_documentation_complete"].eq(False).sum())
    if missing > 0: data.loc[pick(psi, "site01_ground_truth_documentation", missing), "session_documentation_complete"] = False
    esk = data[data["study_id"].eq("NNR-ESK-02") & data["site_id"].eq("SITE_06") & data["required_monitoring_complete"].notna()]
    minimum = int(np.ceil(len(esk) * cfg["ground_truth"]["SITE_06"]["minimum_monitoring_incomplete_rate"])); missing = minimum - int(esk["required_monitoring_complete"].eq(False).sum())
    if missing > 0:
        candidates = esk[esk["required_monitoring_complete"].eq(True)]; data.loc[pick(candidates, "site06_ground_truth_monitoring", missing), "required_monitoring_complete"] = False
    data["protocol_deviations"] = 0; data[["deviation_type", "deviation_severity"]] = None
    types = ["procedure", "consent_process", "documentation", "other"]
    for index, row in data[data["visit_status"].eq("completed")].iterrows():
        psi_major = row["study_id"] == "NNR-PSI-01" and row["visit_name"] == "Dosing Day" and pd.notna(row["session_documentation_complete"]) and not bool(row["session_documentation_complete"])
        esk_major = row["study_id"] == "NNR-ESK-02" and pd.notna(row["required_monitoring_complete"]) and not bool(row["required_monitoring_complete"])
        if psi_major or esk_major:
            data.loc[index, ["protocol_deviations", "deviation_type", "deviation_severity"]] = [1, "documentation" if psi_major else "monitoring", "major"]; continue
        rng = row_rng(row, "random_deviation")
        if rng.random() < cfg["random_deviation_probability"][row["study_id"]]:
            data.loc[index, ["protocol_deviations", "deviation_type", "deviation_severity"]] = [1, types[int(rng.integers(0, len(types)))], "major" if rng.random() < cfg["major_random_deviation_probability"] else "minor"]
    return data

def endpoint_score(row, baseline, cfg, remission_ids, response_ids):
    rng, threshold = row_rng(row, "clinical_endpoint_score"), cfg["remission_threshold"]
    if row["participant_id"] in remission_ids: return int(rng.integers(3 if cfg["scale"] == "MADRS" else 2, threshold + 1))
    if row["participant_id"] in response_ids:
        low = threshold + 1; return int(rng.integers(low, max(low, int(np.floor(baseline * 0.5))) + 1))
    low = max(threshold + 1, int(np.floor(baseline * 0.5)) + 1)
    if row["study_id"] == "NNR-SER-04": high = min(cfg["score_range"]["max"], 14)
    else: low, high = max(low, int(np.floor(baseline * cfg.get("nonresponse_min_fraction", 0.55)))), min(cfg["score_range"]["max"], baseline)
    return int(rng.integers(low, high + 1))

def apply_clinical_outcomes(data):
    data = data.copy(); data["depression_scale"] = None
    data[["baseline_depression_score", "depression_score", "depression_change_from_baseline"]] = np.nan; data[["clinical_response", "clinical_remission"]] = pd.NA
    for study_id, cfg in plausibility_config["efficacy"].items():
        baseline_visit, endpoint_visit = cfg["baseline_visit"], cfg["endpoint_visit"]
        enrolled = data["study_id"].eq(study_id) & ~data["screening_failure"]; data.loc[enrolled, "depression_scale"] = cfg["scale"]
        baseline_rows = data[enrolled & data["visit_name"].eq(baseline_visit) & data["visit_status"].eq("completed")]; baseline = {}
        for index, row in baseline_rows.iterrows():
            limits = cfg["baseline_score"]; score = int(row_rng(row, "baseline_depression_score").integers(limits["min"], limits["max"] + 1))
            baseline[row["participant_id"]] = score; data.loc[index, "depression_score"] = score
        for pid, score in baseline.items(): data.loc[data["participant_id"].eq(pid), "baseline_depression_score"] = score
        endpoint = data[enrolled & data["visit_name"].eq(endpoint_visit) & data["visit_status"].eq("completed") & data["participant_id"].isin(baseline)]
        if endpoint.empty: continue
        endpoint = endpoint.assign(_score=scores(endpoint, "clinical_endpoint_rank")).sort_values("_score")
        n_remission = int(round(len(endpoint) * cfg["remission_rate"]["target"])); rate = cfg.get("response_rate", cfg["remission_rate"])["target"]
        n_response = max(n_remission, int(round(len(endpoint) * rate))); remission_ids = set(endpoint.head(n_remission)["participant_id"]); response_ids = set(endpoint.head(n_response)["participant_id"])
        for index, row in endpoint.iterrows():
            base = baseline[row["participant_id"]]; score = endpoint_score(row, base, cfg, remission_ids, response_ids); change = score - base
            data.loc[index, ["depression_score", "depression_change_from_baseline", "clinical_response", "clinical_remission"]] = [score, change, bool(change <= -(base * cfg["response_reduction"])), bool(score <= cfg["remission_threshold"])]
        endpoint_day = int(data[data["study_id"].eq(study_id) & data["visit_name"].eq(endpoint_visit)]["target_day"].dropna().iloc[0])
        intermediate = data[enrolled & data["visit_status"].eq("completed") & data["participant_id"].isin(baseline) & ~data["visit_name"].isin(["Screening", baseline_visit, endpoint_visit]) & data["target_day"].notna()]
        for index, row in intermediate.iterrows():
            pid, base = row["participant_id"], baseline[row["participant_id"]]; endpoint_row = data[data["participant_id"].eq(pid) & data["visit_name"].eq(endpoint_visit)]
            if endpoint_row.empty or pd.isna(endpoint_row.iloc[0]["depression_score"]): continue
            final = int(endpoint_row.iloc[0]["depression_score"]); progress = min(1.0, max(0.0, int(row["target_day"]) / endpoint_day)) if endpoint_day else 1.0
            expected = base + (final - base) * progress; score = int(round(expected + row_rng(row, "clinical_intermediate_score").normal(0, 2)))
            score = int(np.clip(score, cfg["score_range"]["min"], cfg["score_range"]["max"])); data.loc[index, ["depression_score", "depression_change_from_baseline"]] = [score, score - base]
    return data

def apply_safety_events(data):
    data = data.copy(); data[["adverse_event", "serious_adverse_event", "ae_leading_to_discontinuation"]] = False
    for study_id, cfg in plausibility_config["safety"].items():
        enrolled = data[data["study_id"].eq(study_id) & ~data["screening_failure"]]["participant_id"].drop_duplicates().sort_values()
        rank = lambda pid, component: make_rng(study_id=study_id, participant_id=pid, component=component).random()
        ranked_ids = sorted(enrolled, key=lambda pid: rank(pid, "safety_participant_rank")); n = len(ranked_ids)
        n_ae = int(round(n * cfg["any_adverse_event_rate"]["target"])); n_sae = int(round(n * cfg["serious_adverse_event_rate"]["target"])); n_disc = int(round(n * cfg["ae_discontinuation_rate"]["target"]))
        ae_ids = set(ranked_ids[:n_ae]); sae_ids = set(sorted(ae_ids, key=lambda pid: rank(pid, "serious_ae_rank"))[:min(n_sae, len(ae_ids))])
        dropout_ids = [pid for pid in data[data["study_id"].eq(study_id) & data["dropout"]]["participant_id"].drop_duplicates() if pid in ae_ids]
        dropout_ids.sort(key=lambda pid: rank(pid, "ae_discontinuation_rank")); disc_ids = set(dropout_ids[:min(n_disc, len(dropout_ids))])
        for pid in ae_ids:
            visits = data[data["participant_id"].eq(pid) & data["visit_status"].eq("completed") & ~data["visit_name"].eq("Screening")]
            if visits.empty: continue
            if pid in disc_ids:
                dropout = visits[visits["dropout"]]; index = dropout.index[0] if not dropout.empty else visits.sort_values("visit_sequence").index[-1]
                data.loc[index, ["ae_leading_to_discontinuation", "dropout_reason"]] = [True, "adverse_event"]
            else:
                rng = make_rng(study_id=study_id, participant_id=pid, component="adverse_event_visit"); index = visits.index[int(rng.integers(0, len(visits)))]
            data.loc[index, "adverse_event"] = True
            if pid in sae_ids: data.loc[index, "serious_adverse_event"] = True
    return data

def inject_dirty_data(clean):
    cfg, dirty = generation_config["dirty_data"], clean.copy(); dirty["_score"] = scores(dirty, "dirty_row_selection")
    null_n = round(len(dirty) * cfg["null_noncritical_rate"]); date_n = round(len(dirty) * cfg["inconsistent_date_rate"]); casing_n = round(len(dirty) * cfg["casing_spacing_rate"]); duplicate_n = round(len(dirty) * cfg["duplicate_rate"])
    null_columns = ["intervention_class", "city", "country"]
    for position, index in enumerate(dirty.sort_values("_score").head(null_n).index): dirty.loc[index, null_columns[position % 3]] = np.nan
    date_rows = dirty[dirty["visit_status"].eq("completed") & (dirty["target_day"] > 0) & dirty["day0_date"].notna()].sort_values("_score").head(date_n)
    for index, row in date_rows.iterrows(): dirty.loc[index, "actual_date"] = row["day0_date"] - pd.Timedelta(days=int(row_rng(row, "dirty_date_inconsistency").integers(1, 8)))
    for position, index in enumerate(dirty.sort_values("_score", ascending=False).head(casing_n).index):
        value = str(dirty.loc[index, "participant_status"]); dirty.loc[index, "participant_status"] = value.upper() if position % 3 == 0 else " " + value if position % 3 == 1 else value + " "
    monitoring = dirty[dirty["monitoring_minutes"].notna()].sort_values("_score").head(len(cfg["monitoring_outliers"])).index
    for index, value in zip(monitoring, cfg["monitoring_outliers"]): dirty.loc[index, "monitoring_minutes"] = value
    queries = dirty[dirty["data_queries_opened"] > 0].sort_values("_score", ascending=False).head(cfg["query_inconsistencies"]).index
    for index in queries: dirty.loc[index, "data_queries_open"] = dirty.loc[index, "data_queries_opened"] + 1
    if len(queries): dirty.loc[queries[0], "oldest_open_query_days"] = 365
    duplicates = dirty.sort_values("_score").iloc[40:40 + duplicate_n].copy(); dirty = pd.concat([dirty, duplicates], ignore_index=True)
    return dirty.drop(columns="_score").reset_index(drop=True)

def generate_dataset():
    validate_config(); participants = add_participant_dates(create_participants()); data = create_visit_scaffold(participants)
    data = apply_retention(data, participants); data = apply_completeness_and_queries(data); data = apply_monitoring_and_deviations(data)
    data = apply_clinical_outcomes(data); data = apply_safety_events(data); clean = data[SCHEMA].copy(); dirty = inject_dirty_data(clean)
    assert len(clean) == 1500 and len(dirty) == 1508 and clean["record_id"].is_unique and dirty.duplicated().sum() == 8
    return clean, dirty

def save_dataset(data):
    DATA_DIR.mkdir(parents=True, exist_ok=True); name = "trialpulse_operations.csv" if REPRODUCIBILITY_FILE.exists() else "trialpulse_operations_clean_candidate.csv"
    output = DATA_DIR / name; data.to_csv(output, index=False, date_format="%Y-%m-%d"); return output

if __name__ == "__main__":
    clean_data, dirty_data = generate_dataset(); saved = dirty_data if REPRODUCIBILITY_FILE.exists() else clean_data; output = save_dataset(saved)
    print("Generazione completata."); print("Seed utilizzato:", MASTER_SEED); print("Righe clean:", len(clean_data), "| Righe dirty:", len(dirty_data)); print("Righe salvate:", len(saved)); print("File:", output)