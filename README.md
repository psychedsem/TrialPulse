# TrialPulse

**Agente AI multi-tool per le Clinical Research Operations**
Progetto finale del Master in AI e Agenti AI per il Business

Ho sviluppato **TrialPulse** come prototipo di agente AI per supportare il lavoro di un **Clinical Operations Manager / Study Operations Lead**. L'agente consulta documentazione interna e dati operativi di trial clinici, confronta studi e siti e aiuta a individuare criticità attraverso indicatori misurabili.

Ho ambientato il progetto in **Novera Neuro Research**, un'azienda biotech fittizia specializzata nella ricerca sui disturbi depressivi. Azienda, studi, siti, partecipanti e dati sono interamente sintetici.

Demo Firebase:
Repository GitHub:

## Cosa ho realizzato

Ho progettato un agente che sceglie autonomamente gli strumenti necessari alla domanda, anziché seguire un semplice instradamento basato su parole chiave. Ho implementato tre modalità di lavoro:

- **RAG-only:** recupero protocolli, calendari delle visite, procedure e regole operative dalla Knowledge Base interna Novera.
- **Data-only:** analisi dei dati sintetici tramite Python e pandas, con KPI di recruitment, screening, retention, visite, completezza, deviazioni, query e trend.
- **RAG → Data:** recupero una regola documentale e la applico ai dati, per esempio per verificare finestre di visita o condizioni di escalation.

Ho previsto domande di chiarimento quando manca lo studio di riferimento, verifiche sulla provenienza delle informazioni e risposte prudenti quando i documenti o i dati non sostengono una conclusione. Ho mantenuto separati i risultati del CSV, le regole interne Novera e gli eventuali suggerimenti operativi.

Ho disegnato un’interfaccia responsive con identità grafica dedicata, supporto a Markdown e tabelle, gestione degli errori, invio con Enter e nuova riga con Shift+Enter.

## Studi e scenario operativo

Ho costruito un portfolio di quattro studi sui disturbi depressivi, con popolazione sintetica di età compresa tra 18 e 65 anni e sintomatologia almeno moderata.

| Studio | Trattamento | Popolazione |
| --- | --- | --- |
| `NNR-PSI-01` | Psilocibina | MDD e TRD |
| `NNR-ESK-02` | Esketamina | MDD e TRD |
| `NNR-DXB-03` | Destrometorfano + bupropione | MDD |
| `NNR-SER-04` | Sertralina | MDD |

Ho distribuito le attività su **otto siti fittizi**: Roma (`SITE_01`), Milano (`SITE_02`), Barcellona (`SITE_03`), Parigi (`SITE_04`), Amsterdam (`SITE_05`), Berlino (`SITE_06`), Londra (`SITE_07`) e Zurigo (`SITE_08`). Ho inserito criticità riconoscibili, come recruitment lento a Barcellona, query aging elevato ad Amsterdam e visite mancate a Londra, insieme a siti con prestazioni migliori.

## Architettura e Knowledge Base

Ho separato l'applicazione in quattro componenti, mantenendo l'orchestrazione nel backend:

| Componente | Tecnologie | Responsabilità |
| --- | --- | --- |
| Frontend | React, Vite | Interfaccia conversazionale e cronologia recente |
| Backend | Node.js, Express, SDK Groq | Endpoint `POST /api/chat`, scelta e sequenza dei tool |
| Data Agent | Python, FastAPI, pandas | Analisi del CSV e calcolo dei KPI |
| RAG | Python, FastAPI, ChromaDB | Ricerca semantica nei documenti Novera |

Ho utilizzato **`intfloat/multilingual-e5-small`** per gli embedding della Knowledge Base e i modelli **`openai/gpt-oss-120b`** e **`openai/gpt-oss-20b`** per la componente generativa, con fallback limitato nei casi previsti.

Ho preparato una Knowledge Base operativa fittizia con protocol synopsis, schedule e visit windows, SOP, linee guida di monitoring, responsabilità, FAQ e criteri di escalation. Tra le regole documentate ho incluso la site review per recruitment inferiore al 75% del target per due mesi consecutivi, l'escalation delle query oltre 10 giorni e i controlli sulle deviazioni maggiori in finestre temporali di 30 giorni.

Ho volutamente **evitato di inserire nel CSV finestre di visita e indicatori out-of-window già calcolati**: l'agente deve prima recuperare le regole corrette dalla documentazione e poi applicarle ai dati.

## Dataset sintetico e qualità dei dati

Ho generato il dataset operativo `data/trialpulse_operations.csv` in modo deterministico, partendo da configurazioni versionate e da un seed congelato. Il dataset contiene:

- **1.500 record logici** partecipante-visita, **1.508 righe fisiche** e **43 colonne**.
- **194 partecipanti screenati**, di cui **154 arruolati** e **40 screening failure**.
- **8 duplicati intenzionali**, oltre ad anomalie controllate in date, campi non critici, formattazioni, monitoring e query.

Ho introdotto queste imperfezioni per verificare che le analisi non assumessero dati perfetti. Ho distinto gli zeri effettivamente presenti dai periodi non restituiti e ho previsto segnalazioni esplicite dei problemi di qualità.

### Come ho scelto i range dei dati

Ho creato **dati completamente sintetici**, senza copiare i record di alcun trial clinico reale. Per mantenerli credibili, ho confrontato i range di alcune variabili con una piccola selezione di pubblicazioni scientifiche pertinenti ai quattro trattamenti.

Ho classificato le variabili in tre livelli, in base alla loro importanza per TrialPulse:

- **HIGH:** per le variabili più importanti ho mantenuto range più vicini ai valori plausibili osservati nelle fonti.
- **MEDIUM:** ho adottato intervalli più flessibili, preservando la coerenza complessiva.
- **LOW:** ho lasciato maggiore variabilità, senza introdurre valori volutamente irrealistici.

Ho utilizzato quindi le pubblicazioni come **controllo di plausibilità**, non come dataset da riprodurre né come base per affermare risultati clinici. Non ho svolto una revisione sistematica della letteratura. Ho mantenuto queste fonti esterne alla Knowledge Base RAG, dedicata esclusivamente alle regole operative fittizie di Novera.

**Riferimenti scientifici principali:**

- **Psilocibina:** Goodwin et al., *New England Journal of Medicine* (2022), [Single-Dose Psilocybin for a Treatment-Resistant Episode of Major Depression](https://doi.org/10.1056/NEJMoa2206443).
- **Esketamina:** Reif et al., *New England Journal of Medicine* (2023), [ESCAPE-TRD](https://pubmed.ncbi.nlm.nih.gov/37792613/).
- **Destrometorfano + bupropione:** studio [GEMINI](https://pubmed.ncbi.nlm.nih.gov/35649167/).
- **Sertralina:** studio [PANDA](https://pubmed.ncbi.nlm.nih.gov/31543474/).

Ho raccolto ulteriori dettagli e la classificazione delle variabili in `docs/references/plausibility_sources.md`.

## Riproducibilità e verifiche

Ho conservato il generatore, le configurazioni e i controlli di integrità nel repository, senza rigenerare il dataset dopo il congelamento.

- **Seed:** `2939583971211916763`
- **CSV SHA-256:** `3f9ad9042443eeecf70071132b87032f2564a6dba4b3d81f01efb18bd8aff7ec`
- **Configurazione:** `data_agent/config/reproducibility.yaml`

Ho verificato i calcoli e i contratti applicativi mediante suite automatiche: **543 test backend**, **34 test frontend** e **61 test Python**, oltre alla validazione dei **11 documenti** della Knowledge Base. Ho inoltre eseguito prove reali su RAG, Data Agent, applicazione delle regole, gestione delle ambiguità e limiti clinici. I test automatici con provider simulato non equivalgono a una garanzia di affidabilità generativa in ogni esecuzione.

Ho predisposto questi comandi di verifica dalla root, dopo l’installazione:

```powershell
npm --prefix backend test
npm --prefix frontend test
npm --prefix frontend run build
& .\data_agent\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
& .\data_agent\.venv\Scripts\python.exe .\scripts\validate_kb.py
Get-FileHash .\data\trialpulse_operations.csv -Algorithm SHA256
```

## Installazione e avvio locale

Ho sviluppato e verificato il prototipo su **Windows/PowerShell**, con **Node.js 24.19.0**, **npm 11.17.0** e **Python 3.14.2**. Per riprodurre l'ambiente su una nuova copia, ho previsto i seguenti comandi dalla root del progetto:

```powershell
npm --prefix backend ci
npm --prefix frontend ci
python -m venv data_agent/.venv
& .\data_agent\.venv\Scripts\python.exe -m pip install -r .\data_agent\requirements.txt -r .\rag\requirements.txt
```

Ho separato le credenziali dal codice: la chiave `GROQ_API_KEY` appartiene esclusivamente a `backend/.env`, creato a partire da `backend/.env.example`. Il frontend usa `frontend/.env.local`, ricavato da `frontend/.env.example`, soltanto per configurare il proxy `BACKEND_PROXY_TARGET`. Non ho inserito segreti nel frontend o nel repository.

Ho previsto la costruzione dell'indice Chroma **solo se assente**, prima dell'avvio del RAG:

```powershell
& .\data_agent\.venv\Scripts\python.exe .\rag\build_index.py
```

**Attenzione:** questo comando sostituisce la collezione `trialpulse_kb` eventualmente esistente. Non l'ho previsto come operazione da ripetere a ogni avvio.

Ho utilizzato quattro terminali separati per i servizi locali:

```powershell
# 1. Data Agent: porta 8000
& .\data_agent\.venv\Scripts\python.exe -m uvicorn app:app --app-dir data_agent --host 127.0.0.1 --port 8000

# 2. RAG: porta 8001
& .\data_agent\.venv\Scripts\python.exe -m uvicorn app:app --app-dir rag --host 127.0.0.1 --port 8001

# 3. Backend: porta 3001
npm --prefix backend run start

# 4. Frontend: porta 5173
npm --prefix frontend run dev
```

Ho utilizzato `http://localhost:5173` come indirizzo locale dell'interfaccia. Il frontend inoltra `/api` al backend tramite il proxy Vite; il backend comunica con i servizi Python via HTTP locale. Ho predisposto anche un recupero Python tramite `child_process`, facoltativo e disabilitato per impostazione iniziale, utilizzabile solo nelle condizioni documentate in `backend/.env.example`.

## Limiti e utilizzo responsabile

Ho progettato TrialPulse per il **supporto alle operazioni di ricerca**, non per diagnosi, valutazioni di idoneità, raccomandazioni terapeutiche o confronti di superiorità clinica tra trattamenti. I dati sintetici possono illustrare indicatori operativi, ma non dimostrano quale terapia sia più efficace.

Ho mantenuto controlli sulle fonti e sugli output, pur riconoscendo alcuni limiti: il provider Groq può restituire occasionalmente errori `400 tool_use_failed`, risposte strutturate incomplete o `429` per limiti di quota. Ho implementato pacing, retry e fallback circoscritti, senza considerarli garanzie di successo. Ho sviluppato il sistema come **prototipo locale**, privo di autenticazione e non ancora configurato per un utilizzo pubblico in produzione.

Ho conservato la conversazione recente nella sessione del browser, con ripristino dopo il refresh e possibilità di azzerarla tramite conferma. Non ho realizzato un archivio centrale delle conversazioni. Per un'eventuale demo pubblica, la distribuzione del solo frontend statico non sostituisce l'hosting e la protezione del backend, del Data Agent e del RAG.