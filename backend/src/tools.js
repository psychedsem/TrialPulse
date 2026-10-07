const text = { type: "string" };
const positiveInteger = { type: "integer", minimum: 1 };
const percent = { type: "number", minimum: 0, maximum: 100 };

// Contratto AnalyzeRequest e AnalysisParameters del servizio operativo.
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description: "Recupera documentazione Novera: protocolli, schedule, finestre, SOP, regole, escalation, FAQ, ruoli e monitoring. Restituisce chunk e fonti, non una risposta finale.",
      parameters: {
        type: "object", properties: { query: { type: "string", minLength: 1 } },
        required: ["query"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_operations",
      description: `Analizza il CSV sintetico tramite il Data Agent. Ometti filtri e parametri inutili.
efficacy richiede filters.study_id e non confronta trattamenti.
portfolio_summary, recruitment, screening_failure, retention, safety, major_deviations_window e recruitment_target ammettono soltanto filtri study_id/site_id; consecutive_missed anche participant_id; le altre analisi ammettono tutti i filtri.
group_by: portfolio_summary, screening_failure, retention, safety e query_aging_threshold ammettono study_id/site_id; recruitment anche month; deviations anche visit_name/month; efficacy soltanto visit_name/site_id; major_deviations_window, consecutive_missed e recruitment_target non ammettono raggruppamenti; le altre analisi ammettono study_id/site_id/visit_name.
Parametri obbligatori: out_of_window: visit_windows (rate_threshold_percent opzionale); major_deviations_window: window_days/min_count; consecutive_missed: min_consecutive; recruitment_target: threshold_percent/consecutive_months; query_aging_threshold: threshold_days; completeness_threshold: attention_threshold_percent/escalation_threshold_percent. Le altre analisi non ammettono parametri. Non inventare soglie: recupera le regole documentali quando necessarie.`,
      parameters: {
        type: "object", additionalProperties: false, required: ["analysis"],
        properties: {
          analysis: {
            type: "string",
            enum: ["portfolio_summary", "recruitment", "screening_failure", "retention", "visits",
              "completeness", "queries", "deviations", "monitoring", "efficacy", "safety",
              "out_of_window", "major_deviations_window", "consecutive_missed", "recruitment_target",
              "query_aging_threshold", "completeness_threshold"],
          },
          filters: {
            type: "object", additionalProperties: false,
            properties: { study_id: text, site_id: text, participant_id: text, visit_name: text },
          },
          group_by: {
            type: "array", uniqueItems: true,
            items: { type: "string", enum: ["study_id", "site_id", "visit_name", "month"] },
          },
          parameters: {
            type: "object", additionalProperties: false,
            properties: {
              visit_windows: {
                type: "array", minItems: 1,
                items: {
                  type: "object", additionalProperties: false,
                  required: ["study_id", "visit_name", "window_days"],
                  properties: { study_id: text, visit_name: text, window_days: { type: "integer", minimum: 0 } },
                },
              },
              rate_threshold_percent: percent, window_days: positiveInteger, min_count: positiveInteger,
              min_consecutive: positiveInteger, threshold_percent: percent, consecutive_months: positiveInteger,
              threshold_days: { type: "number", minimum: 0 },
              attention_threshold_percent: percent, escalation_threshold_percent: percent,
            },
          },
        },
      },
    },
  },
];
