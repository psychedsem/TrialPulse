# Plausibilità documentale

Questo file è materiale di progetto e **non deve essere ingerito nella Knowledge Base RAG**.

La documentazione Novera è fittizia. Non riproduce un protocollo clinico reale specifico: usa una struttura sintetica coerente con gli studi del progetto e con scenari plausibili di Clinical Research Operations.

## Livelli di importanza

**HIGH**  
Elementi centrali per TrialPulse: struttura delle visite, caratteristiche operative study-specific, scale di outcome e attività di monitoring/documentazione. Questi elementi devono restare vicini a quanto è plausibile osservare negli studi reali usati come riferimento.

**MEDIUM**  
Procedure interne come visit windows, escalation, completeness e monitoring operativo. Devono essere credibili e coerenti, ma sono regole Novera sintetiche e possono essere adattate al progetto.

**LOW**  
Naming interno, organizzazione dei documenti, FAQ e passaggi tra ruoli. Possono essere definiti liberamente purché siano realistici e coerenti.

## Quattro riferimenti principali

- Psilocibina: Goodwin et al., NEJM 2022 - https://doi.org/10.1056/NEJMoa2206443
- Esketamina: Reif et al., NEJM 2023 / ESCAPE-TRD - https://pubmed.ncbi.nlm.nih.gov/37792613/
- Dextrometorfano + bupropione: GEMINI - https://pubmed.ncbi.nlm.nih.gov/35649167/
- Sertralina: PANDA - https://pubmed.ncbi.nlm.nih.gov/31543474/

Le fonti servono come controllo di plausibilità generale. Non sono fonti operative di TrialPulse e non devono comparire nei documenti indicizzati dal RAG.

## QA mirato - 2026-10-06

HIGH: struttura PSI con singola sessione e supporto, MADRS e follow-up a Week 3/12 coerenti come scenario generale con [Goodwin](https://pubmed.ncbi.nlm.nih.gov/36322843/). Per ESK, visite bisettimanali iniziali e settimanali nelle settimane 5–8 sono plausibili rispetto al percorso [ESCAPE-TRD](https://pmc.ncbi.nlm.nih.gov/articles/PMC13064706/). MADRS e osservazione a Week 6 per DXB sono coerenti con [GEMINI](https://pubmed.ncbi.nlm.nih.gov/35649167/). PHQ-9 e follow-up a 6/12 settimane per SER sono coerenti come struttura generale con [PANDA](https://pubmed.ncbi.nlm.nih.gov/31543474/).

PANDA include una popolazione più ampia per età e severità: non giustifica come replica i criteri sintetici Novera 18–65 anni e severità almeno moderata. I giorni esatti, le visite aggiuntive, le finestre e i flag documentali restano scelte del progetto; questa verifica non certifica un protocollo clinico completo.

MEDIUM: soglie e procedure sono regole interne sintetiche, coerenti con le decisioni congelate. LOW: ruoli, naming e FAQ sono brevi e credibili. Nessuna nuova regola clinica o durata obbligatoria del monitoring è stata introdotta.
