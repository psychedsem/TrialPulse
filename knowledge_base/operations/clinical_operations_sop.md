# SOP sintetica - Clinical Operations

**Codice documento:** KB-SOP-CLINOPS-01  
**Versione:** 1.0

Questa SOP raccoglie le regole operative comuni ai quattro studi Novera.

## Visite e follow-up

- Una visita `missed` richiede tracciamento nel flusso operativo del sito.
- Due visite missed consecutive per lo stesso partecipante richiedono **site follow-up**.
- Il controllo di consecutività segue l'ordine delle visite previste dal protocollo.
- Screening non viene usato per determinare due missed consecutive.

## Data completeness

Sul perimetro richiesto dall'utente (ad esempio sito o studio), sono eleggibili tutte e sole le righe con `required_assessments > 0`.

`completeness = (Σ required_assessments - Σ missing_assessments) / Σ required_assessments × 100`

Si aggregano prima i conteggi degli assessment, senza usare la media delle percentuali delle singole visite. Lo Screening completato con assessment richiesti entra nel calcolo; le visite non completed sono escluse perché nel dataset hanno `required_assessments = 0`.

- completeness ≥95%: nessuna azione;
- completeness 90%-<95%: **attenzione operativa**;
- completeness <90%: **escalation**.

Quando si analizza un sito o uno studio, TrialPulse deve dichiarare il livello di aggregazione usato.

## Query

Una query aperta con `oldest_open_query_days > 10` richiede **escalation a Data Management**.

Query volume, query aperte, aging e tempi di risoluzione vanno letti separatamente: un volume elevato non implica automaticamente aging elevato.

## Recruitment

Se un sito raggiunge meno del 75% del target mensile per **due mesi consecutivi**, è richiesta una **site review**.

La regola va applicata mese per mese. Non è corretto confrontare il totale storico con il target di un singolo mese.

Il target mensile è quello della coppia studio/sito in `data_agent/config/study_design.yaml`. `enrollment_date` permette di assegnare l'arruolamento al mese; lo stesso partecipante non va contato nuovamente per ogni visita.

## Out-of-window

Le finestre non sono memorizzate come verità pronta nel dataset. Devono essere recuperate da `KB-SCHED-01` e applicate alle date operative.

Un site out-of-window rate >10% richiede **Clinical Operations review**.
