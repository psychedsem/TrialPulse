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
              "completeness: solo percentuali descrittive, nessuna classificazione. completeness_threshold: classifica attenzione/escalation/nessuna azione; per regole Novera esplicite usa rule_source novera_kb, per soglie personalizzate fornisci entrambe le soglie. Non sostituirla con completeness e un confronto manuale. Per le altre soglie documentali usa l'analisi parametrica dedicata.",
          },
          rule_source: {
            type: "string",
            enum: ["novera_kb"],
            description: "Solo per completeness_threshold: usa novera_kb quando l'utente richiede esplicitamente le regole Novera. Il backend recupera e verifica le soglie mancanti tramite RAG; i valori presenti devono essere coerenti con tale regola. Per soglie personalizzate ometti rule_source e fornisci entrambe le soglie.",
          },
          filters: {
            type: "object",
            description:
              "Filtri scalari opzionali: una stringa per campo, mai array. Per confrontare studi usa il perimetro più ampio o richieste separate. recruitment_target ammette solo study_id e site_id.",
            properties: Object.fromEntries(["study_id", "site_id", "participant_id", "visit_name"]
              .map(key => [key, { type: "string" }])),
            additionalProperties: false,
          },
          group_by: {
            type: "array",
            description:
              "Obbligatorio per completeness_threshold: [] aggrega il perimetro selezionato, [site_id] valuta i siti, [study_id] gli studi, entrambi le coppie studio/sito. Per le altre analisi è opzionale, se supportato. recruitment_target restituisce gia risultati mensili per studio e sito: ometti group_by. major_deviations_window produce già risultati per sito: ometti group_by.",
            items: {
              type: "string",
              enum: ["site_id", "study_id", "visit_name", "month"],
            },
          },
          parameters: {
            type: "object",
            properties: {
              threshold_percent: {
                type: "number",
                description: "Per recruitment_target: soglia percentuale di raggiungimento del target mensile recuperata dalla KB. Obbligatoria insieme a consecutive_months.",
              },
              consecutive_months: {
                type: "integer",
                minimum: 1,
                description: "Per recruitment_target: numero di mesi consecutivi sotto soglia richiesto dalla regola documentale. Obbligatorio insieme a threshold_percent.",
              },
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