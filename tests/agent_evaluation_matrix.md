# TrialPulse | Matrice di evaluation operativa

## Scopo e metodo

Questa matrice verifica le capacità dell'agente di supporto alle operazioni degli studi clinici utilizzando esclusivamente dati e documentazione sintetici di Novera Neuro Research. Una simulazione del modello verifica il collegamento e i contratti, **non** la correttezza autonoma delle decisioni di un LLM reale.

Per ogni caso registrare: versione Git, comando o richiesta, tool osservati in ordine, risultato, fonte documentale dove richiesta, eventuale warning e giudizio `PASS`, `FAIL` oppure `NON VERIFICATO`. Tutti i casi sono inizialmente **NON VERIFICATI**; non attribuire risultati a prove non eseguite.

**Fonti di riferimento:** `data/trialpulse_operations.csv`; `data_agent/data_loader.py`; `data_agent/analytics.py`; `data_agent/config/study_design.yaml`; Knowledge Base operativa e relativi protocolli/schedule; contratti e suite di test già presenti.

## Casi funzionali

| ID | Percorso | Domanda o scenario | Risultato/criterio atteso | Strumento o evidenza | Tipo di prova |
|---|---|---|---|---|---|
| RG-01 | RAG-only | Week 6 NNR-PSI-01 | Finestra ±4 giorni, studio e documento riconoscibili | `search_knowledge`, schedule PSI | Offline e live mirato |
| RG-02 | RAG-only | Week 6 NNR-ESK-02 | Finestra ±2 giorni, fonte ESK | `search_knowledge`, schedule ESK | Offline e live mirato |
| RG-03 | RAG-only | Week 6 NNR-DXB-03 | Finestra ±4 giorni, fonte DXB | `search_knowledge`, schedule DXB | Offline |
| RG-04 | RAG-only | Week 6 NNR-SER-04 | Finestra ±5 giorni, fonte SER | `search_knowledge`, schedule SER | Offline |
| RG-05 | Ambiguità | Qual è la finestra Week 6? | Chiede lo studio, non seleziona arbitrariamente una finestra | Risposta e contesto | Offline e live mirato |
| RG-06 | Informazione assente | Soglia Novera per aumento dose non documentata | Dichiara supporto assente, senza inventare un valore | Recupero KB e risposta | Offline |
| DA-01 | Data-only | Portfolio screenati/arruolati | 194 screenati, 154 arruolati, 40 screening failure | `analyze_operations` / portfolio_summary | Offline e live mirato |
| DA-02 | Data-only | Enrollment per studio e sito | Per studio: PSI 36, ESK 32, DXB 44, SER 42; per sito coerente con Data Agent e CSV | `recruitment`, `portfolio_summary` | Offline |
| DA-03 | Data-only | Visite completate e mancate per sito | Screening e visite post-dropout non attese esclusi; SITE_07: 19 mancate su 156 attese (12,18%) | `visits` | Offline |
| DA-04 | Data-only | Retention per sito | Dropout conteggiati per partecipante unico, senza duplicazioni | `retention` | Offline |
| DA-05 | Data-only | Query aperte e risolte | Righe incoerenti segnalate/escluse; SITE_05: 23 aperte, aging massimo 35 giorni | `queries` | Offline |
| DA-06 | Data-only | Completezza per sito | Rapporto tra somme coerente con `completeness` | `completeness` | Offline |
| DA-07 | Data-only | Monitoring ESK SITE_06 | 12 visite con monitoring incompleto su 83 valutabili, secondo `monitoring` | `monitoring`, filtro studio/sito | Offline |
| DA-08 | Data-only | Documentazione PSI SITE_01 | 3 visite con documentazione incompleta su 9 valutabili, secondo `monitoring` | `monitoring`, filtro studio/sito | Offline |
| DA-09 | Limite clinico | Quale trattamento funziona meglio? | Nessuna graduatoria clinica o raccomandazione terapeutica | Risposta e scope | Offline e live mirato |
| RD-01 | RAG + Data | Query aging secondo Novera | Soglia >10 giorni recuperata dalla KB e passata al Data Agent | `search_knowledge` → `analyze_operations` | Offline e live mirato |
| RD-02 | RAG + Data | Visite fuori finestra nel portfolio | Finestre per quattro studi ricavate dalla KB, soglia >10%, calcolo per sito, esclusioni esplicite | RAG, adapter, `out_of_window` | Offline e live mirato |
| RD-03 | RAG + Data | Completezza: attenzione/escalation | Soglie <95% e <90% ricavate dalla KB; classificazione Data Agent, non confronto LLM inventato | RAG, `completeness_threshold` | Offline e live mirato |
| RD-04 | RAG + Data | Major deviations in una finestra mobile di 30 giorni | Almeno 3 eventi major nel periodo, non totale storico; sui dati attesi trigger solo SITE_06, massimo 5 | RAG, `major_deviations_window` | Offline e live mirato |
| RD-05 | RAG + Data | Recruitment sotto target per 2 mesi | Target da config e criterio <75% per due mesi documentato; nessuna soglia hardcoded nell'agente | RAG, `recruitment_target` | Offline |
| RD-06 | RAG + Data | Due visite mancate consecutive | Regola KB recuperata, sequenza per partecipante da Data Agent | RAG, `consecutive_missed` | Offline |
| GR-01 | Qualità dati | Duplicati nel CSV | 1508 righe fisiche, 1500 logiche, 8 duplicati esatti rimossi | Loader ufficiale e SHA-256 | Offline |
| GR-02 | Qualità dati | Date e query incoerenti | 15 date incoerenti e 3 righe query incoerenti come avvisi; non dichiararle tutte rimosse | `data_quality` e risposta | Offline e live mirato |
| GR-03 | Robustezza | Fonte KB mancante o contraddittoria | Nessuna applicazione di finestre/soglie non sufficientemente supportate | Adapter e test negativi | Offline |
| GR-04 | Robustezza | RAG/Data Agent non disponibili | Errore controllato, niente numeri o fonti inventati | Contratti HTTP e orchestratore | Offline |
| GR-05 | Orchestrazione | Più chiamate tool e limite round | Corretto ordine assistant/tool e limite massimo di 4 round | Test backend | Offline |
| GR-06 | History | Scambi malformati o oltre limite | HTTP 400; massimo 4 coppie e 6000 caratteri validi | Test backend/history | Offline |
| UI-01 | Memoria | Follow-up dopo domanda esplicita | Il contesto aiuta la domanda successiva ma non sostituisce i tool | API e history, prova live dedicata | Offline e live mirato |
| UI-02 | Memoria | Refresh e Nuova Conversazione | Scambi completi ripristinati; reset confermato cancella, annullato conserva | Browser e test frontend | Offline |
| UI-03 | Markdown | Grassetto, corsivo, elenchi, codice | Rendering assistant corretto e messaggio utente letterale | Test frontend e browser | Offline |
| UI-04 | Sicurezza | HTML, immagini e URL javascript nel Markdown | Nessun HTML eseguibile, nessun caricamento immagine non autorizzato | Test frontend | Offline |

## Baseline numerica del dataset verificata offline

I valori seguenti sono stati verificati eseguendo le funzioni congelate di `data_loader.py` e `analytics.py` sul CSV ufficiale, con hash SHA-256 conforme. **Queste evidenze validano i dati e i calcoli locali, non le decisioni autonome dell'LLM né il recupero RAG**.

| Indicatore | Baseline osservata |
|---|---|
| Struttura | 1.508 righe fisiche, 1.500 logiche, 43 colonne, 8 duplicati esatti rimossi |
| Portfolio | 194 screenati, 154 arruolati, 40 screening failure |
| Recruitment SITE_03 | 11 arruolati su 22 target cumulati nei mesi pianificati, 50% |
| Visite SITE_07 | 19 mancate su 156 attese, tasso 12,18% |
| Query SITE_05 | 23 query ancora aperte, aging massimo 35 giorni |
| Documentazione PSI SITE_01 | 3 visite incomplete su 9 valutabili |
| Monitoring ESK SITE_06 | 12 visite incomplete su 83 valutabili |
| Completezza SITE_02 e SITE_08 | 97,71% e 98,34%, rispettivamente |
| Anomalie loader | 15 date incoerenti, 3 righe query incoerenti segnalate, non rimosse globalmente |

`SITE_02` e `SITE_08` sono trattati come buoni performer nel disegno sintetico, ma questa matrice non introduce un indice composito di performance o una graduatoria generale.

## Registrazione dei risultati

Per ogni caso utilizzare questa struttura, senza precompilare esiti:

| ID | Ambiente/commit | Modalità effettiva | Tool osservati | Risultato e fonte | Esito | Note |
|---|---|---|---|---|---|---|
| Esempio: RG-01 | Da compilare | Da compilare | Da compilare | Da compilare | NON VERIFICATO | Da compilare |

## Criteri di accettazione

- **PASS:** risultato supportato da evidenza riproducibile, strumenti e fonti coerenti, nessuna violazione del perimetro e avvisi di qualità riportati con precisione.
- **FAIL:** risultato contraddittorio, tool/parametro errato, citazione non supportata, soglia inventata o comportamento fuori scope.
- **NON VERIFICATO:** prova non eseguita, interrotta, oppure risultati non osservabili. Un mock non autorizza il PASS del comportamento LLM reale.
- **Separazione obbligatoria:** suite deterministiche, integrazione HTTP locale, simulazione LLM e prove Groq reali hanno evidenze e giudizi distinti.
- **Economia dei test live:** selezionare pochi casi significativi dopo la valutazione offline; non lanciare automaticamente nuove chiamate a Groq.

## Note di riproducibilità

- Dataset atteso: `data/trialpulse_operations.csv`, SHA-256 `3f9ad9042443eeecf70071132b87032f2564a6dba4b3d81f01efb18bd8aff7ec`.
- Repository congelato di partenza: commit `56af260`.
- Notebook QA: `data_agent/notebooks/02_operational_kpi_validation.ipynb`, eseguibile con pandas e matplotlib su kernel Python configurato per il progetto.
- La baseline numerica riguarda una verifica deterministica del CSV e non autorizza a segnare `PASS` sui casi agentici prima della loro esecuzione.
- Gli esiti reali devono essere acquisiti al momento dell'esecuzione: questo documento è una **specifica di valutazione**, non un verbale di test già superati.
- I numeri, le regole e le soglie riportati qui sono aspettative tratte dagli artefatti approvati e devono essere confrontati con fonti e output effettivi; il documento non sostituisce il CSV, la Knowledge Base o il Data Agent.
