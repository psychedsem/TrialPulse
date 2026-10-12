# TrialPulse

TrialPulse è un prototipo locale per il Clinical Operations Manager / Study Operations Lead. Consulta documentazione e dati operativi per confrontare studi e siti, individuare criticità e supportare decisioni sulla conduzione degli studi.

Novera Neuro Research, gli studi, i siti, i partecipanti e i dati sono completamente sintetici. Il portfolio comprende NNR-PSI-01, NNR-ESK-02, NNR-DXB-03 e NNR-SER-04. I risultati non rappresentano evidenze cliniche reali.

## Architettura e prerequisiti

- Frontend React/Vite: interfaccia conversazionale, normalmente sulla porta 5173.
- Backend Node/Express: `POST /api/chat`, porta 3001, SDK Groq nativo e due strumenti scelti autonomamente dal modello.
- Data Agent Python/FastAPI+pandas: analisi del CSV, porta 8000.
- RAG Python/FastAPI: retrieval dalla Knowledge Base Novera con ChromaDB locale, porta 8001.

Ambiente verificato: Windows/PowerShell, Node.js 24.19.0 (versione principale indicata in [.nvmrc](.nvmrc)), npm 11.17.0 e Python 3.14.2. Le dipendenze sono descritte nei manifest e requirements del repository. Occorrono una chiave Groq personale e accesso Internet per il provider; il primo caricamento del modello di embedding può richiedere un download. I font dell'interfaccia sono caricati da Google Fonts, con fallback locale.

## Installazione e configurazione

Eseguire i comandi dalla radice di TrialPulse. Su una nuova copia sorgente:

```powershell
npm --prefix backend ci
npm --prefix frontend ci
python -m venv data_agent/.venv
& .\data_agent\.venv\Scripts\python.exe -m pip install -r .\data_agent\requirements.txt -r .\rag\requirements.txt
```

Non ricreare un ambiente virtuale già configurato. I comandi di installazione servono alla preparazione di una nuova copia, non ai normali avvii successivi.

Copiare i template soltanto se i file di destinazione non esistono:

```powershell
if (!(Test-Path backend/.env)) { Copy-Item backend/.env.example backend/.env }
if (!(Test-Path frontend/.env.local)) { Copy-Item frontend/.env.example frontend/.env.local }
```

In `backend/.env` impostare personalmente `GROQ_API_KEY`. Il [template backend](backend/.env.example) documenta anche `GROQ_MODEL`, `GROQ_FALLBACK_MODEL`, `PORT`, `DATA_AGENT_URL` e `RAG_API_URL`, con i valori locali configurati dal progetto. Il [template frontend](frontend/.env.example) contiene soltanto `BACKEND_PROXY_TARGET`. Non inserire chiavi o token nel frontend; non distribuire file `.env` reali. Non è necessario un template nella radice.

## Indice documentale

Il [manifest](knowledge_base/manifest.yaml) seleziona i documenti Novera da ingerire. Il modello è `intfloat/multilingual-e5-small`; la configurazione si trova in [rag/config.py](rag/config.py).

Prima del primo avvio del RAG, se l'indice non è già disponibile:

```powershell
& .\data_agent\.venv\Scripts\python.exe .\rag\build_index.py
```

Questo comando crea l'indice operativo in `rag/chroma_db/` e **sostituisce la collezione `trialpulse_kb` se esiste**. Non eseguirlo ad ogni avvio né durante l'utilizzo del servizio. L'indice è un artefatto locale, escluso da Git; non contiene le fonti scientifiche di plausibilità.

I test RAG di retrieval costruiscono invece indici in directory temporanee e li rimuovono al termine. Non ricostruiscono l'indice operativo. Il modello di embedding deve essere già nella cache per eseguire tali test completamente offline.

## Avvio dei quattro servizi

Aprire quattro terminali nella radice del repository, dopo avere preparato ambiente, template e indice:

```powershell
# Terminale 1: Data Agent
& .\data_agent\.venv\Scripts\python.exe -m uvicorn app:app --app-dir data_agent --host 127.0.0.1 --port 8000
```

```powershell
# Terminale 2: RAG
& .\data_agent\.venv\Scripts\python.exe -m uvicorn app:app --app-dir rag --host 127.0.0.1 --port 8001
```

```powershell
# Terminale 3: backend, senza riavvio automatico
npm --prefix backend run start
```

```powershell
# Terminale 4: frontend
npm --prefix frontend run dev
```

Controllare `/health` su `http://127.0.0.1:8000`, `http://127.0.0.1:8001` e `http://127.0.0.1:3001`. Aprire l'indirizzo mostrato da Vite, normalmente `http://localhost:5173/`. Non avviare duplicati se i servizi sono già attivi. Vite inoltra `/api` al backend; per distribuire il build statico serve un reverse proxy equivalente, non fornito da questo prototipo.

## Recupero locale Python facoltativo

Normalmente Node comunica con Data Agent e RAG tramite HTTP. È disponibile un recupero locale facoltativo mediante `child_process`, disabilitato in partenza. Per abilitarlo, indicare in `backend/.env`:

```dotenv
PYTHON_BRIDGE_ENABLED=true
PYTHON_EXECUTABLE=C:/percorso/assoluto/TrialPulse/data_agent/.venv/Scripts/python.exe
```

Sostituire il percorso con quello reale, senza inserire credenziali. Utilizzare l'ambiente Python già configurato con le dipendenze Data e RAG. L'interprete deve essere un file esistente indicato con percorso assoluto. Gli argomenti e le domande non vengono eseguiti in una shell.

Il recupero si attiva soltanto per connessioni HTTP rifiutate (`ECONNREFUSED`) a servizi loopback (`127.0.0.1`, `localhost`, `::1`). Non si attiva per timeout, risposte HTTP 400/422/503, JSON non valido, documentazione non attestata o errori del provider Groq. Il normale trasporto HTTP resta prioritario; non vengono avviati server FastAPI.

Per le analisi viene eseguito un processo Python a richiesta. Per RAG viene utilizzato un worker Python seriale, avviato alla prima necessità e chiuso dopo un periodo di inattività. Il worker riutilizza il modello di embedding già caricato nello stesso processo. Entrambi restituiscono gli stessi corpi JSON dei servizi HTTP e sono soggetti alle medesime validazioni Node. Un indice Chroma locale e un modello di embedding già disponibili rimangono necessari: il recupero non ricostruisce l'indice e non scarica il modello.

Il recupero non corregge errori del modello generativo e non è necessario all'avvio ordinario. Può aumentare memoria e latenza quando il servizio locale è fermo; non sostituisce il controllo di disponibilità dei servizi Python.

## Utilizzo, capacità e limiti

- **RAG-only:** regole, protocolli, schedule e finestre. Specificare lo studio quando la regola varia fra protocolli; gli alias ufficiali riconosciuti sono contestualizzati con gli ID canonici. I valori di calendario vengono verificati contro le sezioni effettivamente recuperate.
- **Data-only:** recruitment, enrollment, screening failure, retention/dropout, visite, completeness, query, deviations, trend e confronti. I calcoli provengono dal Data Agent, non dal modello.
- **RAG → Data:** recupero e applicazione di regole documentali, incluse visit windows, soglie di completeness, query aging, recruitment sotto target e major deviations temporali. Distinguere sempre regole Novera, dati calcolati e suggerimenti non vincolanti.

Esempi e limiti verificabili sono raccolti in [tests/kb_query_set.md](tests/kb_query_set.md) e nella [matrice di valutazione](tests/agent_evaluation_matrix.md). Questi scenari non sono una garanzia di successo autonomo per ogni nuova richiesta.

`major_deviations_window` rileva almeno tre eventi per sito in una finestra mobile di 30 giorni sulla storia disponibile. Non calcola gli ultimi 30 giorni rispetto a una data di riferimento: questo perimetro recente non è implementato. Non usare il conteggio storico totale come sostituto del controllo temporale. Nel recruitment, un mese non restituito non equivale a zero: uno zero può essere riportato solo se effettivamente presente nei risultati.

I duplicati rimossi dalla vista analitica, le anomalie segnalate e i record esclusi da una specifica analisi sono categorie distinte. Una risposta aggregata non dimostra la conformità di gruppi assenti o dei singoli siti.

Le fonti consultate non attestano automaticamente ogni affermazione generativa. Evidenze insufficienti devono produrre un limite o una richiesta di chiarimento, non valori inventati. I presenter controllati verificano i report pertinenti; le citazioni nella prosa libera mantengono limiti di affidabilità.

La conversazione visualizzata sopravvive al refresh tramite `sessionStorage`, senza archivio di sessione nel backend. Ogni richiesta trasmette al massimo quattro scambi completi consecutivi recenti e 6.000 caratteri; gli scambi troppo lunghi non vengono abbreviati. Una nuova conversazione cancella la memoria locale dopo conferma. Dettagli dell'interfaccia in [frontend/README.md](frontend/README.md).

Non usare TrialPulse per diagnosi, scelta terapeutica, idoneità clinica o classifiche di efficacia fra trattamenti. Le richieste miste possono ricevere la sola analisi operativa consentita, con rifiuto della raccomandazione clinica. I dati sintetici non permettono conclusioni di superiorità terapeutica.

## Errori provider

Il modello principale è `openai/gpt-oss-120b`, con fallback `openai/gpt-oss-20b` soltanto su HTTP 429 del provider. Il fallback resta attivo nella richiesta corrente; la richiesta successiva riparte dal principale. L'SDK usa `maxRetries: 0`.

Il backend dispone di pacing basato sui segnali di quota, un unico retry applicativo per specifici `400 tool_use_failed` intermedi dopo una ricerca documentale riuscita e un recupero controllato dei report recruitment validati in caso di tale errore nella finale forzata. Non sono retry generali né garanzie di completamento. Restano quattro round tool massimi e una completion finale; i risultati già ottenuti non devono essere ricalcolati per effetto del retry.

Gli HTTP 400 generativi e i 429 di rate limiting sono problemi distinti. Errori intermittenti possono impedire la risposta anche con strumenti locali funzionanti; la causa dei `tool_use_failed` non è risolta in generale. Il pacing non coordina globalmente le quote di richieste indipendenti. Le risposte controllate non espongono credenziali o generazioni rifiutate grezze. Il prototipo è destinato all'uso locale e non implementa autenticazione.

Un errore terminale del provider produce un errore API controllato. Se invece il fallback completa la generazione ma omette i fatti strutturati necessari, il calendario viene rifiutato anche quando la fonte pertinente è stata consultata: il recupero del documento da solo non autorizza la pubblicazione dei valori. I follow-up documentali hanno ottenuto risposte corrette in collaudi locali, ma restano possibili risposte generative incomplete; non è garantito il completamento di ogni conversazione.

## Test e build

Dalla radice:

```powershell
npm --prefix backend test
npm --prefix frontend test
npm --prefix frontend run build
& .\data_agent\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
& .\data_agent\.venv\Scripts\python.exe .\scripts\validate_kb.py
```

Le suite usano simulazioni del provider, non chiamate Groq reali. Per impedire download del modello durante i test Python, dopo averne preparato la cache:

```powershell
$env:HF_HUB_OFFLINE = "1"
$env:TRANSFORMERS_OFFLINE = "1"
& .\data_agent\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
```

I test automatici non sostituiscono il controllo nel browser di responsive, font, refresh e dialoghi nativi, né il collaudo del comportamento autonomo del provider.

## Dataset e riproducibilità

Il [CSV ufficiale](data/trialpulse_operations.csv) contiene 1.508 righe fisiche, 1.500 righe logiche, 43 colonne e 8 duplicati intenzionali; 194 partecipanti screenati, 154 arruolati e 40 screening failure. Include dirty data controllati. Il disegno e i target sono in [study_design.yaml](data_agent/config/study_design.yaml).

Seed: `2939583971211916763`, registrato in [reproducibility.yaml](data_agent/config/reproducibility.yaml). SHA-256 atteso:

```text
3f9ad9042443eeecf70071132b87032f2564a6dba4b3d81f01efb18bd8aff7ec
```

Verifica non distruttiva:

```powershell
Get-FileHash .\data\trialpulse_operations.csv -Algorithm SHA256
```

Le suite loader/Data Agent verificano anche struttura, duplicati e ground truth. Non eseguire `data_agent/validate_dataset.py` come controllo in sola lettura: richiama il generatore. Non rigenerare il CSV per avviare l'applicazione.

## Plausibilità dei dati sintetici

Le fonti scientifiche sono state usate per controllare la plausibilità dei range, con maggiore aderenza per variabili centrali e più libertà per dettagli operativi. Non sono stati riprodotti record di trial reali; non si tratta di una revisione sistematica formale. La letteratura non costituisce il dataset né la Knowledge Base operativa.

Riferimenti principali, identificati in [plausibility_sources.md](docs/references/plausibility_sources.md) e con indirizzi già riportati nelle [note di plausibilità](docs/references/kb_plausibility_notes.md):

- Psilocibina: Goodwin et al., NEJM 2022, [Single-Dose Psilocybin for a Treatment-Resistant Episode of Major Depression](https://doi.org/10.1056/NEJMoa2206443).
- Esketamina: Reif et al., NEJM 2023, [ESCAPE-TRD](https://pubmed.ncbi.nlm.nih.gov/37792613/).
- Dextrometorfano + bupropione: [GEMINI](https://pubmed.ncbi.nlm.nih.gov/35649167/).
- Sertralina: [PANDA](https://pubmed.ncbi.nlm.nih.gov/31543474/).

Distribuire solo sorgenti, test, template e documenti necessari: escludere credenziali, ambienti installati, cache e archivi locali non verificati. I lockfile npm e i requirements Python sono parte della riproducibilità.
