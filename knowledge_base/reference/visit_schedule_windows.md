# Schedule e visit windows

**Codice documento:** KB-SCHED-01  
**Versione:** 1.0  
**Uso:** riferimento operativo Novera

Le finestre sono espresse come tolleranza rispetto al target day. Lo Screening non entra nel KPI out-of-window; deve comunque precedere le visite di trattamento previste dal protocollo.

## NNR-PSI-01

| Visita | Target day | Finestra |
|---|---:|---:|
| Preparazione 1 | -7 | ±2 giorni |
| Preparazione 2 / Baseline | -3 | ±1 giorno |
| Dosing Day | 0 | stesso giorno |
| Integrazione 1 | +1 | ±1 giorno |
| Integrazione 2 / Week 1 | +7 | ±2 giorni |
| Week 3 | +21 | ±3 giorni |
| Week 6 | +42 | **±4 giorni** |
| Week 12 | +84 | ±7 giorni |

## NNR-ESK-02

| Visita | Target day | Finestra |
|---|---:|---:|
| Baseline | 0 | stesso giorno |
| Week 1 Dose 1 | +1 | ±1 giorno |
| Week 1 Dose 2 | +4 | ±1 giorno |
| Week 2 Dose 1 | +8 | ±1 giorno |
| Week 2 Dose 2 | +11 | ±1 giorno |
| Week 3 Dose 1 | +15 | ±1 giorno |
| Week 3 Dose 2 | +18 | ±1 giorno |
| Week 4 Dose 1 | +22 | ±1 giorno |
| Week 4 Dose 2 | +25 | ±1 giorno |
| Week 5 | +35 | ±2 giorni |
| Week 6 | +42 | **±2 giorni** |
| Week 7 | +49 | ±2 giorni |
| Week 8 | +56 | ±3 giorni |

## NNR-DXB-03

| Visita | Target day | Finestra |
|---|---:|---:|
| Baseline | 0 | stesso giorno |
| Week 1 | +7 | ±2 giorni |
| Week 2 | +14 | ±2 giorni |
| Week 3 | +21 | ±3 giorni |
| Week 4 | +28 | ±3 giorni |
| Week 6 | +42 | **±4 giorni** |
| Follow-up Week 8 | +56 | ±5 giorni |

## NNR-SER-04

| Visita | Target day | Finestra |
|---|---:|---:|
| Baseline | 0 | stesso giorno |
| Week 2 | +14 | ±3 giorni |
| Week 4 | +28 | ±4 giorni |
| Week 6 | +42 | **±5 giorni** |
| Week 8 | +56 | ±5 giorni |
| Week 10 | +70 | ±5 giorni |
| Week 12 | +84 | ±7 giorni |

## Regola di calcolo

Una visita completata è out-of-window quando `actual_date` cade fuori dalla finestra dello studio e della visita.

La finestra si applica a `target_date` (data Day 0 + `target_day`), non a `scheduled_date`. I limiti sono inclusivi; “stesso giorno” indica tolleranza zero. Le date incoerenti o mancanti devono essere segnalate prima del calcolo.

Per il tasso di sito:
- numeratore: visite completate out-of-window;
- denominatore: visite completate con `actual_date` e finestra definita;
- Screening escluso.

Se il tasso out-of-window di un sito supera il 10%, è richiesta una review di Clinical Operations.

La domanda “Qual è la finestra Week 6?” è ambigua senza lo study ID: TrialPulse deve chiedere quale studio.
