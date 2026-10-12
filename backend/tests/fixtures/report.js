export function dataReport(analysis, fields = {}) {
  return { analysis, scope: { study_id: null, site_id: null, participant_id: null,
    visit_name: null, group_by: [] }, parameters_applied: {}, results: [],
    data_quality: { duplicates_removed: 0, inconsistent_actual_dates: 0, inconsistent_query_rows: 0,
      excluded_records: 0, warnings: [], exclusions_by_reason: {} }, ...fields };
}