"""KPI, contratto HTTP e regressioni sui dati sintetici TrialPulse."""

from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import pandas as pd
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data_agent"))
import app as service


class DataAgentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(service.app)

    def analyze(self, analysis, **kwargs):
        response = self.client.post("/analyze", json={"analysis": analysis, **kwargs})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def fixture(self, **columns):
        size = len(next(iter(columns.values())))
        frame = service.DATAFRAME.iloc[:size].copy()
        for column, values in columns.items():
            frame[column] = values
        return patch.object(service, "DATAFRAME", frame)

    def assert_bad_requests(self, cases):
        for payload in cases:
            with self.subTest(payload=payload):
                response = self.client.post("/analyze", json=payload)
                self.assertEqual(response.status_code, 400, response.text)

    def test_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["logical_rows"], 1500)
        self.assertTrue(response.json()["dataset_loaded"])

    def test_portfolio_and_quality(self):
        result = self.analyze("portfolio_summary")
        summary = result["results"][0]
        for key, expected in {"screened_participants": 194, "enrolled_participants": 154,
                              "screening_failures": 40, "studies": 4, "sites": 8}.items():
            self.assertEqual(summary[key], expected)
        self.assertEqual(result["data_quality"]["duplicates_removed"], 8)

    def test_all_17_analysis(self):
        cases = {
            "portfolio_summary": {}, "recruitment": {}, "screening_failure": {},
            "retention": {}, "visits": {}, "completeness": {}, "queries": {},
            "deviations": {}, "monitoring": {}, "safety": {},
            "efficacy": {"filters": {"study_id": "NNR-ESK-02"}},
            "out_of_window": {"parameters": {"visit_windows": [
                {"study_id": "NNR-PSI-01", "visit_name": "Week 6", "window_days": 4}]}},
            "major_deviations_window": {"parameters": {"window_days": 30, "min_count": 3}},
            "consecutive_missed": {"parameters": {"min_consecutive": 2}},
            "recruitment_target": {"parameters": {"threshold_percent": 75, "consecutive_months": 2}},
            "query_aging_threshold": {"parameters": {"threshold_days": 10}},
            "completeness_threshold": {"parameters": {
                "attention_threshold_percent": 95, "escalation_threshold_percent": 90}},
        }
        for analysis, arguments in cases.items():
            with self.subTest(analysis=analysis):
                result = self.analyze(analysis, **arguments)
                self.assertIsInstance(result["results"], list)
                self.assertIn("parameters_applied", result)
                self.assertIn("excluded_records", result["data_quality"])

    def test_completeness_ratio_of_sums(self):
        with self.fixture(required_assessments=[4, 8, 0], missing_assessments=[1, 0, 0],
                          visit_name=["Screening", "Baseline", "Week 6"]):
            result = self.analyze("completeness")["results"][0]
        self.assertEqual(result["required_assessments_total"], 12)
        self.assertEqual(result["completed_assessments_total"], 11)
        self.assertEqual(result["completeness_rate"], 91.67)

    def test_completeness_thresholds_and_zero_denominator(self):
        parameters = {"attention_threshold_percent": 95, "escalation_threshold_percent": 90}
        for missing, action in [(5, "no_action"), (10, "attention"), (11, "escalation")]:
            with self.subTest(missing=missing), self.fixture(required_assessments=[100], missing_assessments=[missing]):
                self.assertEqual(self.analyze("completeness_threshold", parameters=parameters)
                                 ["results"][0]["classification"], action)
        with self.fixture(required_assessments=[0], missing_assessments=[0]):
            self.assertIsNone(self.analyze("completeness")["results"][0]["completeness_rate"])

    def test_visits_eligibility(self):
        with self.fixture(screening_failure=[False]*4, visit_name=["Screening", "Week 1", "Week 2", "Week 3"],
                          visit_status=["completed", "completed", "missed", "not_expected_after_dropout"]):
            result = self.analyze("visits")["results"][0]
        self.assertEqual(result["expected_visits"], 2)
        self.assertEqual(result["completed_visits"], 1)
        self.assertEqual(result["missed_rate"], 50)

    def test_retention_unique_participants(self):
        with self.fixture(participant_id=["A", "A", "B"], screening_failure=[False]*3,
                          dropout=[True, True, False], dropout_reason=["withdrawal", "withdrawal", None]):
            result = self.analyze("retention")["results"][0]
        self.assertEqual(result["enrolled"], 2)
        self.assertEqual(result["dropouts"], 1)
        self.assertEqual(result["dropout_reasons"], {"withdrawal": 1})

    def test_queries_weighted_and_dirty(self):
        with self.fixture(data_queries_opened=[4, 1, 1, 2], data_queries_open=[1, 0, 2, 0],
                          mean_query_resolution_days=[2, 10, 3, None],
                          oldest_open_query_days=[10, None, 10, None],
                          _query_consistent=[True, True, False, True]):
            result = self.analyze("queries")
        self.assertEqual(result["results"][0]["queries_resolved_total"], 6)
        self.assertEqual(result["results"][0]["mean_query_resolution_days_weighted"], 4)
        self.assertEqual(result["data_quality"]["excluded_records"], 2)

    def test_query_aging_external_threshold(self):
        with self.fixture(data_queries_open=[1, 1, 0], oldest_open_query_days=[10, 11, None],
                          _query_consistent=[True]*3):
            result = self.analyze("query_aging_threshold", parameters={"threshold_days": 10})
            higher = self.analyze("query_aging_threshold", parameters={"threshold_days": 11})
        self.assertEqual(result["results"][0]["rows_above_threshold"], 1)
        self.assertEqual(higher["results"][0]["rows_above_threshold"], 0)

    def test_out_of_window_parameter_and_dates(self):
        with self.fixture(study_id=["NNR-PSI-01"]*4, visit_name=["Week 6"]*3+["Week 3"],
                          visit_status=["completed"]*4,
                          target_date=pd.to_datetime(["2026-06-01"]*4),
                          actual_date=pd.to_datetime(["2026-06-05", "2026-06-06", "2026-05-01", "2026-07-01"]),
                          _actual_date_usable=[True, True, False, True]):
            parameters = {"visit_windows": [{"study_id": "NNR-PSI-01", "visit_name": "Week 6", "window_days": 4}]}
            result = self.analyze("out_of_window", parameters=parameters)
            parameters["visit_windows"][0]["window_days"] = 5
            relaxed = self.analyze("out_of_window", parameters=parameters)
        self.assertEqual(result["results"][0]["evaluable_visits"], 2)
        self.assertEqual(result["results"][0]["out_of_window_visits"], 1)
        self.assertEqual(result["data_quality"]["excluded_records"], 1)
        self.assertEqual(relaxed["results"][0]["out_of_window_visits"], 0)

    def test_major_window_inclusive_without_fallback(self):
        with self.fixture(site_id=["SITE_01"]*4, protocol_deviations=[1]*4, deviation_severity=["major"]*4,
                          actual_date=pd.to_datetime(["2026-06-01", "2026-06-02", "2026-07-01", None]),
                          target_date=pd.to_datetime(["2026-06-01"]*4), _actual_date_usable=[True, True, True, False]):
            result = self.analyze("major_deviations_window", parameters={"window_days": 30, "min_count": 3})
            wide = self.analyze("major_deviations_window", parameters={"window_days": 31, "min_count": 3})
        item = result["results"][0]
        self.assertEqual(item["max_count_in_window"], 2)
        self.assertFalse(item["threshold_met"])
        self.assertEqual(item["excluded_invalid_dates"], 1)
        self.assertEqual(wide["results"][0]["first_trigger_date"], "2026-07-01")

    def test_consecutive_missed_visit_order(self):
        with self.fixture(participant_id=["A"]*5, screening_failure=[False]*5,
                          visit_sequence=[4, 2, 1, 3, 5], visit_name=["Week 3", "Week 1", "Screening", "Week 2", "Week 6"],
                          visit_status=["completed", "missed", "missed", "missed", "not_expected_after_dropout"]):
            result = self.analyze("consecutive_missed", parameters={"min_consecutive": 2})
        self.assertEqual(result["results"][0]["max_consecutive_missed"], 2)
        self.assertEqual(result["participants_with_trigger"], 1)

    def test_recruitment_target_uses_monthly_target(self):
        result = self.analyze("recruitment_target", filters={"study_id": "NNR-SER-04", "site_id": "SITE_03"},
                              parameters={"threshold_percent": 75, "consecutive_months": 2})["results"][0]
        self.assertEqual([row["actual_enrolled"] for row in result["monthly"]], [3, 1, 1, 1])
        self.assertEqual([row["target_enrolled"] for row in result["monthly"]], [3]*4)
        self.assertTrue(result["trigger_met"])
        self.assertEqual(result["first_trigger_months"], ["2026-03", "2026-04"])

    def test_recruitment_counts_remain_separate_after_participant_deduplication(self):
        with self.fixture(study_id=["NNR-PSI-01"]*3+["NNR-SER-04"]*2,
                          site_id=["SITE_03"]*5, participant_id=["P1", "P1", "P2", "S1", "S2"],
                          screening_failure=[False]*5,
                          enrollment_date=pd.to_datetime(["2026-02-01", "2026-03-01", "2026-03-02", "2026-02-03", "2026-02-04"])):
            result = self.analyze("recruitment_target", filters={"site_id": "SITE_03"},
                                  parameters={"threshold_percent": 75, "consecutive_months": 2})
        groups = {row["study_id"]: row["monthly"] for row in result["results"]}
        self.assertEqual([row["actual_enrolled"] for row in groups["NNR-PSI-01"]], [1, 1, 0, 0, 0])
        self.assertEqual([row["actual_enrolled"] for row in groups["NNR-SER-04"]], [2, 0, 0, 0])
        self.assertEqual([row["achievement_percent"] for row in groups["NNR-PSI-01"][:2]], [50, 50])
        self.assertEqual(groups["NNR-SER-04"][0]["achievement_percent"], 66.67)

    def test_monthly_recruitment_cumulative(self):
        result = self.analyze("recruitment", filters={"study_id": "NNR-SER-04", "site_id": "SITE_03"}, group_by=["month"])
        self.assertEqual([row["cumulative_enrolled"] for row in result["results"]], [3, 4, 5, 6])

    def test_efficacy_scale_guard(self):
        with self.fixture(study_id=["NNR-PSI-01"]*2, depression_scale=["MADRS", "PHQ-9"]):
            response = self.client.post("/analyze", json={"analysis": "efficacy", "filters": {"study_id": "NNR-PSI-01"}})
        self.assertEqual(response.status_code, 400)

    def test_safety_participant_level(self):
        with self.fixture(participant_id=["A", "A", "B"], screening_failure=[False]*3,
                          adverse_event=[True, True, False], serious_adverse_event=[False]*3,
                          ae_leading_to_discontinuation=[False]*3):
            result = self.analyze("safety")["results"][0]
        self.assertEqual(result["participants_with_ae"], 1)
        self.assertEqual(result["participants_with_ae_rate"], 50)
        self.assertEqual(result["ae_positive_visit_records"], 2)

    def test_monitoring_outliers_do_not_override_flag(self):
        with self.fixture(required_monitoring_complete=[True, False], session_documentation_complete=[None, False],
                          monitoring_minutes=[5, 999]):
            result = self.analyze("monitoring")
        self.assertEqual(result["results"][0]["monitoring_completion_rate"], 50)
        self.assertEqual(result["results"][0]["monitoring_minutes_max"], 999)
        self.assertEqual(result["data_quality"]["monitoring_outlier_records"], 2)

    def test_screening_failure_unique(self):
        with self.fixture(participant_id=["A", "A", "B"], screening_failure=[False, False, True]):
            result = self.analyze("screening_failure")["results"][0]
        self.assertEqual((result["screened"], result["passed"], result["failed"]), (2, 1, 1))
        self.assertEqual(result["failure_rate"], 50)

    def test_deviations_temporal_exclusion_only(self):
        with self.fixture(protocol_deviations=[1, 1, 0], deviation_severity=["major", "minor", "major"],
                          deviation_type=["documentation", "monitoring", "documentation"],
                          actual_date=pd.to_datetime(["2026-06-01", "2026-01-01", "2026-06-01"]),
                          _actual_date_usable=[True, False, True]):
            plain = self.analyze("deviations")["results"][0]
            monthly = self.analyze("deviations", group_by=["month"])
        self.assertEqual(plain["deviations_total"], 2)
        self.assertEqual(plain["major_deviations"], 1)
        self.assertEqual(plain["deviation_types"], {"documentation": 1, "monitoring": 1})
        self.assertEqual(monthly["results"][0]["deviations_total"], 1)
        self.assertEqual(monthly["data_quality"]["excluded_records"], 1)

    def test_efficacy_separate_denominators(self):
        with self.fixture(study_id=["NNR-PSI-01"]*3, depression_scale=["MADRS"]*3,
                          depression_score=[10, 20, None], depression_change_from_baseline=[-10, None, None],
                          clinical_response=[True, False, None], clinical_remission=[None, True, None]):
            result = self.analyze("efficacy", filters={"study_id": "NNR-PSI-01"})["results"][0]
        self.assertTrue(result["synthetic_data"])
        self.assertEqual(result["mean_depression_score"], 15)
        self.assertEqual(result["mean_change_from_baseline"], -10)
        self.assertEqual(result["response_rate"], 50)
        self.assertEqual(result["remission_evaluable"], 1)

    def test_parameters_change_triggers(self):
        for threshold, months in [(30, 2), (75, 4)]:
            result = self.analyze("recruitment_target", filters={"study_id": "NNR-SER-04", "site_id": "SITE_03"},
                                  parameters={"threshold_percent": threshold, "consecutive_months": months})
            self.assertFalse(result["results"][0]["trigger_met"])
        with self.fixture(required_assessments=[100], missing_assessments=[8]):
            result = self.analyze("completeness_threshold", parameters={
                "attention_threshold_percent": 93, "escalation_threshold_percent": 92})
            self.assertEqual(result["results"][0]["classification"], "attention")

    def test_group_filters_and_no_source_mutation(self):
        original = service.DATAFRAME.copy(deep=True)
        result = self.analyze("portfolio_summary", filters={"study_id": "NNR-ESK-02", "site_id": "SITE_02"}, group_by=["site_id"])
        self.assertEqual(result["results"][0]["enrolled_participants"], 8)
        self.assertEqual(result["results"][0]["site_id"], "SITE_02")
        self.analyze("out_of_window", parameters={"visit_windows": [
            {"study_id": "NNR-PSI-01", "visit_name": "Week 6", "window_days": 4}]})
        pd.testing.assert_frame_equal(service.DATAFRAME, original)

    def test_dataset_unavailable(self):
        with patch.object(service, "LOAD_ERROR", "Errore simulato"):
            self.assertEqual(self.client.get("/health").json()["status"], "error")
            self.assertEqual(self.client.post("/analyze", json={"analysis": "visits"}).status_code, 503)

    def test_domain_validation(self):
        cases = [
            {"analysis": "efficacy"},
            {"analysis": "visits", "filters": {"site_id": "SITE_99"}},
            {"analysis": "visits", "filters": {"study_id": "NNR-PSI-01", "site_id": "SITE_02"}},
            {"analysis": "screening_failure", "group_by": ["month"]},
            {"analysis": "visits", "group_by": ["site_id", "site_id"]},
            {"analysis": "query_aging_threshold"},
            {"analysis": "query_aging_threshold", "parameters": {"threshold_days": -1}},
            {"analysis": "major_deviations_window", "parameters": {"window_days": 1.5, "min_count": 2}},
            {"analysis": "completeness_threshold", "parameters": {"attention_threshold_percent": 90, "escalation_threshold_percent": 95}},
            {"analysis": "visits", "parameters": {"threshold": 10}},
            {"analysis": "out_of_window", "parameters": {"visit_windows": []}},
            {"analysis": "out_of_window", "parameters": {"visit_windows": [
                {"study_id": "NNR-PSI-01", "visit_name": "Screening", "window_days": 2}]}},
        ]
        self.assert_bad_requests(cases)
        self.assertEqual(
            self.client.post("/analyze", json={"analysis": "unknown"}).status_code,
            422,
        )

    def test_filter_and_group_scope_guards(self):
        cases = [
            {"analysis": "recruitment", "filters": {"visit_name": "Week 6"}},
            {"analysis": "screening_failure", "filters": {"visit_name": "Week 6"}},
            {"analysis": "retention", "filters": {"visit_name": "Week 6"}},
            {"analysis": "safety", "filters": {"visit_name": "Week 6"}},
            {"analysis": "major_deviations_window", "filters": {"participant_id": "X"},
             "parameters": {"window_days": 30, "min_count": 3}},
            {"analysis": "consecutive_missed", "filters": {"visit_name": "Week 6"},
             "parameters": {"min_consecutive": 2}},
            {"analysis": "recruitment_target", "filters": {"participant_id": "X"},
             "parameters": {"threshold_percent": 75, "consecutive_months": 2}},
            {"analysis": "recruitment_target", "group_by": ["study_id"],
             "parameters": {"threshold_percent": 75, "consecutive_months": 2}},
        ]
        self.assert_bad_requests(cases)

        participant = service.DATAFRAME.loc[
            service.DATAFRAME.screening_failure.eq(False), "participant_id"
        ].iloc[0]
        response = self.client.post(
            "/analyze",
            json={"analysis": "visits", "filters": {"participant_id": participant}},
        )
        self.assertEqual(response.status_code, 200, response.text)

    def test_ground_truth(self):
        aging = {row["site_id"]: row for row in self.analyze("queries", group_by=["site_id"])["results"]}
        self.assertGreater(aging["SITE_05"]["oldest_open_query_days_max"], 10)
        visits = {row["site_id"]: row for row in self.analyze("visits", group_by=["site_id"])["results"]}
        self.assertGreater(visits["SITE_07"]["missed_rate"], visits["SITE_02"]["missed_rate"])
        monitoring = {row["site_id"]: row for row in self.analyze("monitoring", filters={"study_id": "NNR-ESK-02"}, group_by=["site_id"])["results"]}
        self.assertGreater(monitoring["SITE_06"]["monitoring_incomplete_visits"], 0)
        psi = self.analyze("monitoring", filters={"study_id": "NNR-PSI-01", "site_id": "SITE_01"})["results"][0]
        self.assertGreater(psi["documentation_incomplete_visits"], 0)
        self.assertGreater(monitoring["SITE_02"]["monitoring_completion_rate"], monitoring["SITE_06"]["monitoring_completion_rate"])
        self.assertGreater(monitoring["SITE_08"]["monitoring_completion_rate"], monitoring["SITE_06"]["monitoring_completion_rate"])


if __name__ == "__main__":
    unittest.main()