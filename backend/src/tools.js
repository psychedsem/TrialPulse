const ANALYSES = [
  "portfolio_summary",
  "recruitment",
  "screening_failure",
  "retention",
  "visits",
  "completeness",
  "queries",
  "deviations",
  "monitoring",
  "efficacy",
  "safety",
  "out_of_window",
  "major_deviations_window",
  "consecutive_missed",
  "recruitment_target",
  "query_aging_threshold",
  "completeness_threshold",
];

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description:
        "Cerca nella Knowledge Base Novera regole, protocolli, schedule, finestre, SOP, escalation, FAQ e linee guida.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Query documentale autosufficiente.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_operations",
      description:
        "Analizza deterministicamente i dati sintetici. Usa le analisi base per descrivere KPI e le analisi parametriche per regole documentali. Per out_of_window scegli solo filters e group_by: il servizio recupera e verifica autonomamente tutte le finestre e la soglia dalla KB. Non ricopiare visit_windows. Senza study_id il perimetro è l'intero portfolio, non richiede chiarimenti.",
      parameters: {
        type: "object",
        properties: {
          analysis: {
            type: "string",
            enum: ANALYSES,
            description:
              "completeness: solo percentuali descrittive, nessuna classificazione. completeness_threshold: classifica attenzione/escalation/nessuna azione con le due soglie recuperate tramite search_knowledge; obbligatoria per valutare i siti secondo le regole Novera di completeness. Non sostituirla con completeness e un confronto manuale. Per le altre soglie documentali usa l'analisi parametrica dedicata.",
          },
          filters: {
            type: "object",
            description:
              "Filtri opzionali: study_id, site_id, participant_id, visit_name.",
            additionalProperties: true,
          },
          group_by: {
            type: "array",
            description:
              "Raggruppamento opzionale: site_id per siti o study_id per studi, se supportato. major_deviations_window produce già risultati per sito: ometti group_by.",
            items: {
              type: "string",
              enum: ["site_id", "study_id"],
            },
          },
          parameters: {
            type: "object",
            properties: {
              attention_threshold_percent: {
                type: "number",
                description: "Per completeness_threshold: soglia percentuale documentale sotto cui è richiesta attenzione. Recuperala dalla KB; deve essere maggiore della soglia di escalation.",
              },
              escalation_threshold_percent: {
                type: "number",
                description: "Per completeness_threshold: soglia percentuale documentale sotto cui è richiesta escalation. Recuperala dalla KB; deve essere minore della soglia di attenzione.",
              },
            },
            description:
              "Parametri recuperati dalla Knowledge Base. threshold_days è la soglia oltre cui scatta il criterio. attention_threshold_percent è il limite superiore della fascia di attenzione e escalation_threshold_percent è la soglia sotto cui scatta escalation. Per completeness deve valere escalation_threshold_percent < attention_threshold_percent. Altri parametri supportati: visit_windows, window_days, min_count, min_consecutive, threshold_percent, consecutive_months.",
            additionalProperties: true,
          },
        },
        required: ["analysis"],
        additionalProperties: false,
      },
    },
  },
];
