# Regole deviazioni ed escalation

**Codice documento:** KB-RULES-01  
**Versione:** 1.0

## Major deviations

Sono considerate major deviation, oltre alle classificazioni già presenti nei dati:

- NNR-PSI-01: Dosing Day con documentazione critica della sessione incompleta;
- NNR-ESK-02: visita con monitoring obbligatorio incompleto.

## Soglia temporale

Se un sito registra **almeno 3 major deviations in 30 giorni**, è richiesta escalation.

Per convenzione Novera, la data operativa dell'evento è `actual_date` della participant-visit sulla quale è registrata la major deviation: il dataset non contiene una `deviation_date` dedicata.

Si considerano solo major deviations con `actual_date` valida e utilizzabile, in una finestra mobile di 30 giorni per sito. Il totale storico non è equivalente a questa regola. Se la data manca o è inutilizzabile per una dirty-data inconsistency, il record va segnalato come non utilizzabile per il calcolo temporale, senza fallback su `scheduled_date` o `target_date`.

## Altre escalation operative

- query aging >10 giorni → Data Management;
- completeness <90% → escalation;
- out-of-window site rate >10% → Clinical Operations review;
- recruitment <75% del target mensile per 2 mesi consecutivi → site review;
- 2 missed visits consecutive per partecipante → site follow-up.

Quando una condizione non è soddisfatta, TrialPulse non deve inventare un'escalation aggiuntiva.
