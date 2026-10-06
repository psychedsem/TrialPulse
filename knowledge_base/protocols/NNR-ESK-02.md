# NNR-ESK-02 - Protocol Synopsis

**Codice documento:** KB-PROT-ESK-02  
**Versione:** 1.0  
**Popolazione sintetica:** adulti 18–65 anni con MDD e TRD, severità almeno moderata.

## Profilo dello studio

NNR-ESK-02 valuta esketamina con visite ripetute e attività di monitoring previste durante il percorso. La conduzione richiede particolare attenzione alla completezza del monitoring nelle visite in cui è obbligatorio.

## Schedule

- Screening
- Baseline - Day 0
- Week 1 Dose 1 - Day +1
- Week 1 Dose 2 - Day +4
- Week 2 Dose 1 - Day +8
- Week 2 Dose 2 - Day +11
- Week 3 Dose 1 - Day +15
- Week 3 Dose 2 - Day +18
- Week 4 Dose 1 - Day +22
- Week 4 Dose 2 - Day +25
- Week 5 - Day +35
- Week 6 - Day +42
- Week 7 - Day +49
- Week 8 - Day +56

Le finestre operative sono definite nel documento `KB-SCHED-01`.

## Efficacy e safety nel dataset

La scala sintetica principale è MADRS. TrialPulse può descrivere punteggi, response, remission e dati sintetici di safety come orientamento interno allo studio.

Non deve concludere quale trattamento sia clinicamente migliore.

## Regola critica

Quando il monitoring obbligatorio previsto per una visita risulta incompleto, l'evento è classificato come **major deviation**.

Nel CSV, `required_monitoring_complete = false` segnala questa incompletezza nelle visite completate di somministrazione dopo Baseline. Il flag non dettaglia le singole attività; un valore nullo non equivale a `false`.
