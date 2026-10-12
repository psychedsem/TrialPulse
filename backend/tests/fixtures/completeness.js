export function completenessFixture(parameters, group_by = ["site_id"], results = [{
  site_id: "SITE_01", required_assessments_total: 807, missing_assessments_total: 26,
  completed_assessments_total: 781, completeness_rate: 96.78, classification: "no_action",
}]) {
  return { analysis: "completeness_threshold",
    scope: { study_id: null, site_id: null, participant_id: null, visit_name: null, group_by },
    parameters_applied: parameters, results,
    data_quality: { duplicates_removed: 8, inconsistent_actual_dates: 15, inconsistent_query_rows: 3,
      excluded_records: 0, exclusions_by_reason: {}, warnings: [] },
  };
}