# Query QA - Knowledge Base e analisi operative

Questo file raccoglie scenari di verifica documentale e di applicazione delle regole ai dati sintetici. I verbali datati sotto attestano soltanto le verifiche allora eseguite, non il successo autonomo dell'agente per ogni domanda.

## RAG-only

1. Qual è la finestra della Week 6 nello studio NNR-ESK-02?
2. Quando una query aperta deve essere escalata a Data Management?
3. Qual è la soglia Novera per la data completeness?
4. Cosa succede se un partecipante ha due visite missed consecutive?
5. Quando tre major deviations richiedono escalation?
6. Quale problema documentale è critico nel Dosing Day di NNR-PSI-01?
7. Qual è il requisito operativo specifico di NNR-ESK-02 sul monitoring?

## Ambiguità

8. Qual è la finestra della Week 6?

Atteso: richiesta di specificare lo studio.

## Informazione assente

9. Qual è la soglia Novera per approvare un aumento di dose?

Atteso: dichiarare che la KB non supporta questa informazione.

## Casi RAG → Data e limiti temporali

10. Quali siti superano il 10% di visite out-of-window?
11. Quali siti hanno query aging oltre la soglia Novera?
12. Ci sono siti con almeno 3 major deviations in una finestra mobile di 30 giorni?
13. Ci sono siti con almeno 3 major deviations negli ultimi 30 giorni rispetto a una data di riferimento?

Le query 10 e 11 richiedono il recupero della regola e il calcolo del Data Agent. La query 12 è rappresentabile da `major_deviations_window`: rileva finestre mobili nella storia disponibile, usando le date operative valide. Il totale storico delle deviations non sostituisce questo controllo.

La query 13 richiede invece un intervallo recente rispetto a una data esplicita. Il contratto attuale non offre questo filtro temporale: dichiarare il limite, senza presentare il calcolo mobile come risposta agli ultimi 30 giorni e senza attribuire un PASS a tale capacità. Le soglie Novera restano invariate.

## Esito QA documentale - 2026-10-06

Verifica manuale delle risposte supportate dai documenti; non è un test dell'LLM o del retrieval.

| Query | Risposta attesa verificata | Fonte interna |
|---|---|---|
| 1 | NNR-ESK-02, Week 6: Day +42, ±2 giorni. | KB-SCHED-01 |
| 2 | Query aperta con aging >10 giorni: escalation Data Management. | KB-SOP-CLINOPS-01, KB-ROLES-01 |
| 3 | <95% attenzione; <90% escalation. Rapporto tra somme degli assessment sulle sole righe con `required_assessments > 0`, incluso Screening completato; non media delle percentuali. | KB-SOP-CLINOPS-01 |
| 4 | Due missed consecutive dello stesso partecipante: site follow-up. | KB-SOP-CLINOPS-01 |
| 5 | Almeno 3 major deviations nello stesso sito in una finestra mobile di 30 giorni, usando solo `actual_date` valide e utilizzabili. Nessun fallback per date inutilizzabili. | KB-RULES-01 |
| 6 | Documentazione critica incompleta al Dosing Day: major deviation; flag sintetico `session_documentation_complete`. | KB-PROT-PSI-01, KB-RULES-01 |
| 7 | Monitoring obbligatorio incompleto: major deviation; flag `required_monitoring_complete`. | KB-PROT-ESK-02, KB-RULES-01 |
| 8 | «Per quale studio?» La finestra Week 6 varia tra i quattro studi. | KB-FAQ-01, KB-SCHED-01 |
| 9 | Informazione non supportata dalla KB: nessuna soglia per aumento di dose disponibile. | KB-SCOPE-01, KB-FAQ-01 |

Esito alla data del verbale: 9/9 casi documentali supportano il comportamento atteso; nessun risultato di sito calcolato per le query 10–12. `actual_date` è la data operativa dell'evento secondo la convenzione documentata in KB-RULES-01. Questa evidenza documentale non verifica la capacità di calcolare un intervallo recente della query 13.

## Ricontrollo delle convenzioni operative - 2026-10-06

Query 3, 5 e regola temporale ricontrollate sui documenti aggiornati. Esempi manuali di interpretazione, non esecuzioni del Data Agent:

- Completeness: Screening completato con 4 assessment richiesti e 1 mancante, più una visita con 8 richiesti e 0 mancanti → `(12 - 1) / 12 × 100 = 91,67%`, attenzione. Una visita non completed con 0 richiesti è esclusa. La media delle percentuali sarebbe 87,5% e non va usata.
- Soglie: 95% non richiede attenzione; 90% richiede attenzione, ma non escalation; 89% richiede escalation.
- Major deviations: tre eventi dello stesso sito con date valide 1, 10 e 20 giugno ricadono in una finestra di 30 giorni → escalation. Tre eventi distribuiti tra gennaio, marzo e giugno non soddisfano da soli la regola temporale.
- Un evento con `actual_date` mancante o inutilizzabile va segnalato ed escluso dal calcolo temporale anche se `scheduled_date` o `target_date` sono presenti.

Esito documentale: convenzioni approvate supportate, nessuna decisione sostanziale aperta. Query 8 e 9 ricontrollate: continuano a richiedere chiarimento e a dichiarare informazione non supportata, rispettivamente.
