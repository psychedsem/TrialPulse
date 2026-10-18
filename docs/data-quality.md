# Analisi dati: test, cache e misure

## Verifiche riproducibili

I comandi Python seguenti presuppongono un ambiente virtuale attivo con le dipendenze di requirements-dev.txt. In alternativa usare il relativo interprete con percorso completo; `python scripts/dev.py test` lo seleziona automaticamente.

`python -m pytest tests/unit tests/test_data_agent.py tests/test_data_loader.py` esegue fixture piccole, test API con TestClient e invarianti sul CSV congelato. pytest raccoglie anche i test unittest preesistenti, che non sono stati rimossi. `python -m pytest tests --cov=data_agent --cov-report=term-missing` misura righe e rami dei moduli dati selezionati; i test Docker sono opt-in e i test RAG richiedono il modello locale. Una misura parziale non rappresenta la copertura dell'intero prodotto.

Le fixture verificano partecipanti unici rispetto alle visite, filtri intersecati, date nulle, somme dei denominatori, ponderazione delle query, rimozione duplicati nel loader, null JSON e inclusività temporale. La finestra mobile delle major deviations ricerca un massimo nella storia disponibile: non è il conteggio negli ultimi 30 giorni rispetto a una data di riferimento. Non viene introdotta una nuova regola o una nuova analisi temporale.

## Caricamento CSV

Il servizio HTTP mantiene il caricamento all'avvio già previsto: non rilegge il CSV per ogni richiesta. Per cambiare il dataset servito occorre riavviare quel processo in modo controllato. Non esiste un endpoint pubblico di refresh.

`load_analytic_dataset()` usa una cache locale con 4 snapshot e TTL di 300 secondi. Per ogni chiamata legge i byte e ne calcola SHA-256, ma evita il nuovo parsing pandas quando il contenuto è invariato; non promette zero I/O. Confronta i metadati prima/dopo la lettura e rifiuta un file instabile dopo 3 tentativi. `refresh=True` svuota gli snapshot; `use_cache=False` usa il caricamento originario senza memoizzazione. I file-like sono letti direttamente. Ogni chiamante riceve copie indipendenti del DataFrame e della qualità. I job dell'executor separato riutilizzano questo caricatore senza cambiare isolamento o protocollo.

## Report deterministici

La cache dei report HTTP riguarda recruitment_target e recruitment con raggruppamento mensile: il benchmark ha mostrato beneficio per questi calcoli, non per il portfolio semplice. Le altre analisi seguono il calcolo originale senza pagare il costo della chiave. Contiene al massimo 64 risultati per 60 secondi, con scadenza monotona e ordine LRU. La chiave comprende contenuto/indice/schema del DataFrame, richiesta completa normalizzata, qualità dei dati e contenuto della configurazione study_design. Filtri, parametri, raggruppamenti, warning o dati differenti non condividono una voce. Nessun errore viene memorizzato. L'output è copiato prima di consegnarlo; un chiamante non può modificare il valore degli altri.

La cache non riguarda risposte conversazionali, prompt, history, retrieval o generazioni probabilistiche. Le analisi dinamiche non passano da questa cache. I soli numeri sintetici deterministici identici possono essere riutilizzati tra richieste, senza contenuti privati di sessione. Le regole documentali rimangono responsabilità del percorso RAG e dei parametri ricevuti, non della cache.

Lock separati proteggono le due cache dentro il processo. Più worker hanno cache indipendenti e nessuno stato persistente condiviso. I calcoli simultanei della stessa cache sono serializzati per non duplicare lavoro; è una scelta semplice per questo dataset, non un sistema distribuito. Il DataFrame di origine del servizio è trattato come snapshot immutabile. La chiave completa ha un costo: per analisi brevissime la cache può risultare più lenta, da verificare con il benchmark.

## Benchmark

`python scripts/benchmark_data.py --multipliers 1 5 20 --repeats 3` crea soltanto CSV temporanei con partecipanti distinti per replica. Non cambia dataset, seed o generatori. Confronta parsing e tre analisi con/senza cache; verifica l'uguaglianza dei risultati. Riporta mediana temporale, dimensione DataFrame deep e picco dell'heap Python misurato con tracemalloc. Non sono RSS o memoria nativa totale; l'instrumentazione influenza i tempi. Non sono dati di un trial reale né un test del provider.

Una migrazione verso DuckDB o SQLite richiederebbe evidenze di memoria o latenza insufficienti, volumi stabilmente maggiori e una verifica dei 17 contratti. Non viene introdotta sulla sola base del numero di righe.

## Qualità progressiva

`python -m ruff check`, `python -m black --check .` e `python -m mypy` usano pyproject.toml. Lint e formato coprono i nuovi moduli cache, fixture/unit test, launcher e benchmark, senza riformattare generatori, configurazioni o gli altri moduli consolidati. mypy è rigoroso sul contenitore di cache parametrico e sul loader; le annotazioni sono presenti anche al confine dell'analisi memorizzata. Gli stub pandas non sono inclusi nelle dipendenze: l'eccezione per i soli import pandas è esplicita in pyproject.toml e le operazioni DataFrame non sono verificate staticamente. I tipi della cache e la struttura del ritorno del loader sono controllati, mentre il dizionario qualità contiene valori eterogenei. Questo non equivale a tipizzazione completa di pandas o di tutte le analisi.
