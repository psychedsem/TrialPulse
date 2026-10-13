# NNR-PSI-01 - Protocol Synopsis

**Codice documento:** KB-PROT-PSI-01  
**Versione:** 1.0  
**Popolazione sintetica:** adulti 18–65 anni con MDD e TRD, severità almeno moderata.

## Profilo dello studio

NNR-PSI-01 valuta un percorso con psilocibina in setting controllato. La conduzione comprende visite di preparazione, un Dosing Day supervisionato e visite di integrazione/follow-up.

Per TrialPulse, gli elementi operativi più importanti sono la corretta esecuzione del Dosing Day, la documentazione della sessione e il rispetto delle visite successive.

## Schedule

- Screening
- Preparazione 1 - Day -7
- Preparazione 2 / Baseline - Day -3
- Dosing Day - Day 0
- Integrazione 1 - Day +1
- Integrazione 2 / Week 1 - Day +7
- Week 3 - Day +21
- Week 6 - Day +42
- Week 12 - Day +84

Le finestre operative sono definite nel documento `KB-SCHED-01`.

## Efficacy e safety nel dataset

La scala sintetica principale è MADRS. TrialPulse può descrivere l'andamento dei punteggi, response e remission presenti nel dataset come orientamento interno allo studio.

Questi dati non devono essere trasformati in raccomandazioni terapeutiche o confronti di superiorità con altri studi.

## Regola critica

Se al Dosing Day la documentazione critica della sessione è incompleta, l'evento è classificato come **major deviation** e richiede gestione secondo le regole Novera.

Nel CSV, `session_documentation_complete = false` segnala questa incompletezza. Il flag è sintetico e non dettaglia i singoli documenti; un valore nullo non equivale a `false`.