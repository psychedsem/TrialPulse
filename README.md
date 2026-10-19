# TrialPulse

[![Verifiche CI](https://github.com/psychedsem/TrialPulse/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/psychedsem/TrialPulse/actions/workflows/ci.yml?query=branch%3Amain)

**Agente AI multi-tool per le Clinical Research Operations**
Progetto finale del Master in AI e Agenti AI per il Business

Ho sviluppato **TrialPulse** come prototipo di agente AI per supportare il lavoro di un **Clinical Operations Manager / Study Operations Lead**. L'agente consulta documentazione interna e dati operativi di trial clinici, confronta studi e siti e aiuta a individuare criticità attraverso indicatori misurabili.

Ho ambientato il progetto in **Novera Neuro Research**, un'azienda biotech fittizia specializzata nella ricerca sui disturbi depressivi. Azienda, studi, siti, partecipanti e dati sono interamente sintetici.

**[Apri la demo su Firebase](https://trialpulse-25650.web.app/)** | **[Esplora il repository GitHub](https://github.com/psychedsem/TrialPulse)**

**Schermate dei test:** [Visualizza la cartella con gli screenshot dei test completi](docs/test-gallery/)

## TrialPulse in azione

Le schermate della galleria documentano esempi osservati nell'applicazione, tra cui recupero documentale, analisi operative e grafici. Sono evidenze di prove specifiche, non una garanzia che ogni generazione successiva produca lo stesso risultato.

Galleria completa: [1A - chiarimento](docs/test-gallery/1A.Disambiguazione_richiesta_documentale.png), [1B - documentazione](docs/test-gallery/1B.Recupero_documentale_mirato.png), [2 - KPI portfolio](docs/test-gallery/2.KPI_Operativi_portfolio.png), [3 - confronto studi](docs/test-gallery/3.Confronto_operativo_studi.png), [4 - tabella comparativa](docs/test-gallery/4.Tabella_comparativa_studi.png), [5 - regola e dati](docs/test-gallery/5.Regola_operativa_dati_mensili.png), [6 - andamento mensile](docs/test-gallery/6.Andamento_mensile_recruitment.png), [7 - pandas e grafico a barre](docs/test-gallery/7.Pandas_agent_dinamico_grafico_barre.png), [8 - pandas e grafico a linee](docs/test-gallery/8.Pandas_agent_dinamico_grafico_lineare.png).

Le catture dei Test 7 e 8 provengono dal browser sui servizi locali ordinari. Mostrano gli arruolamenti mensili dei quattro studi, rispettivamente con un grafico a barre e uno a linee, da febbraio a giugno 2026. Queste verifiche manuali sono distinte dai test automatici.

## Funzionalità

TrialPulse utilizza un **modello linguistico come orchestratore**: interpreta la domanda, seleziona gli strumenti pertinenti e, quando necessario, li richiama in sequenza. Non dipende da un instradamento rigido basato esclusivamente su parole chiave.

| Modalità | Cosa permette di fare |
| --- | --- |
| **RAG-only** | Consultare protocolli, schedule delle visite, procedure, FAQ e regole operative della Knowledge Base Novera, riportando le fonti documentali. |
| **Data-only** | Esplorare il CSV sintetico, calcolare KPI, confrontare studi e siti, individuare anomalie e osservare trend. |
| **RAG → Data** | Recuperare una regola dalla documentazione e applicarla ai dati, per esempio per le finestre di visita o le soglie di escalation. |

L'agente distingue dati del CSV, regole interne fittizie e interpretazioni operative. Chiede chiarimenti quando una richiesta è ambigua e segnala quando non dispone di elementi sufficienti per rispondere.

### Analisi operative e visualizzazioni

Il Data Agent mette a disposizione **17 analisi deterministiche** per recruitment e target, screening failure, retention e dropout, completamento e mancata esecuzione delle visite, completezza dei dati, deviazioni, query e relativi tempi, confronti tra studi e siti e andamento nel tempo. Le metriche rispettano filtri e denominatori definiti, mentre le anomalie del dataset vengono esplicitate.

Per domande che richiedono un'elaborazione descrittiva personalizzata, TrialPulse dispone anche di un **pandas agent dinamico**. Il modello orchestratore può scegliere `analyze_operations` con `analysis: "dynamic"` e richiedere un grafico `bar` o `line`. Una generazione LLM dedicata produce codice pandas sulla base della domanda, della tipologia di grafico e dei nomi delle colonne, senza ricevere i record del dataset.

Il codice passa attraverso validazioni e una **coda locale privata** prima di essere eseguito in un container Docker isolato. Un executor separato carica il CSV, deduplica i record e applica i filtri; il container riceve soltanto i dati necessari, senza mount del repository, accesso alla rete o credenziali. Tabella e PNG Matplotlib derivano dallo stesso risultato. Sono previsti fino a **12 serie** e **120 righe** di output; i periodi senza osservazioni non vengono trasformati automaticamente in zeri.

Il risultato grafico viene mostrato nella chat tramite il campo opzionale `artifacts` dell'API, senza inserire codice generato o PNG in base64 nella cronologia inviata al modello. Le immagini recenti possono essere ripristinate tramite `sessionStorage`, entro limiti di dimensione e disponibilità dello storage.

### Interfaccia

Il frontend React/Vite offre un'interfaccia responsive con identità visiva dedicata, risposte Markdown, tabelle, grafici, gestione degli errori e dello stato di caricamento. Supporta **Invio** per inviare, **Shift+Invio** per andare a capo, cronologia recente nella sessione del browser e nuova conversazione con conferma di azzeramento. I metadati Open Graph e Twitter Card consentono la visualizzazione della cover ufficiale quando viene condiviso il link, dopo la pubblicazione della relativa build.

## Studi e scenario operativo

Il portfolio Novera comprende quattro studi fittizi sui disturbi depressivi, con partecipanti sintetici di **18-65 anni** e severità almeno moderata.

| Studio | Trattamento | Popolazione |
| --- | --- | --- |
| `NNR-PSI-01` | Psilocibina | MDD e TRD |
| `NNR-ESK-02` | Esketamina | MDD e TRD |
| `NNR-DXB-03` | Destrometorfano + bupropione | MDD |
| `NNR-SER-04` | Sertralina | MDD |

La rete comprende **otto siti fittizi**: Roma (`SITE_01`), Milano (`SITE_02`), Barcellona (`SITE_03`), Parigi (`SITE_04`), Amsterdam (`SITE_05`), Berlino (`SITE_06`), Londra (`SITE_07`) e Zurigo (`SITE_08`). Tra gli scenari simulati figurano recruitment lento a Barcellona, query aging elevato ad Amsterdam, visite mancate a Londra e siti con prestazioni migliori.

## Architettura e distribuzione

L'applicazione mantiene separati orchestrazione, analisi strutturate, recupero documentale e interfaccia.

| Componente | Tecnologie | Responsabilità |
| --- | --- | --- |
| **Frontend** | React, Vite | Interfaccia conversazionale, rendering Markdown e artefatti grafici |
| **Backend** | Node.js, Express, SDK Groq | `POST /api/chat`, scelta e sequenza dei tool, gestione delle risposte |
| **Data Agent** | Python, FastAPI, pandas | KPI, filtri, qualità dei dati e preparazione delle richieste dinamiche |
| **RAG** | Python, FastAPI, ChromaDB | Ricerca semantica nei documenti operativi Novera |
| **Executor pandas** | Python, Docker | Esecuzione isolata dei job dinamici e produzione dei grafici |

La **demo pubblica** utilizza Firebase Hosting per il frontend statico e una VM Linux su **Google Cloud Compute Engine** per backend, Data Agent e RAG. Caddy espone l'API in HTTPS e systemd gestisce i servizi applicativi. I componenti server comunicano tramite HTTP locale; chiavi e altre credenziali restano lato server, fuori dal repository.

L'executor pandas non è un servizio web e **non espone endpoint pubblici**. Sulla VM sono stati predisposti Docker rootless con utente dedicato, immagine sandbox e coda privata; i controlli di avvio e dei limiti delle risorse sono riusciti. **L'integrazione runtime e l'abilitazione pubblica dei grafici dinamici devono ancora essere collaudate**: la presenza del codice e dell'infrastruttura non equivale alla disponibilità della funzione sulla demo Firebase.

### Knowledge Base e applicazione delle regole

La Knowledge Base contiene **11 documenti operativi fittizi**: protocol synopsis, calendari e finestre di visita, SOP, linee guida di monitoring, ruoli, responsabilità, FAQ e criteri di escalation. ChromaDB indicizza i documenti e il modello `intfloat/multilingual-e5-small` ne produce gli embedding.

Tra le regole Novera figurano l'escalation delle query con aging superiore a 10 giorni, la revisione dei siti sotto il 75% del target di recruitment per due mesi, le soglie di data completeness e i controlli sulle deviazioni maggiori in una finestra mobile di 30 giorni. Le finestre delle visite variano per studio: una domanda sulla sola "Week 6" richiede di chiarire a quale protocollo ci si riferisce.

Il CSV **non contiene colonne con le finestre di visita già applicate né flag out-of-window precalcolati**. TrialPulse deve recuperare la regola documentale appropriata e applicarla alle date registrate. Le fonti scientifiche reali utilizzate per verificare la plausibilità del dataset non fanno parte della Knowledge Base operativa.

## Dataset sintetico e qualità dei dati

Il file `data/trialpulse_operations.csv` è generato in modo deterministico da configurazioni versionate e da un seed congelato. Comprende:

- **1.500 righe logiche** partecipante-visita, **1.508 righe fisiche** e **43 colonne**.
- **194 partecipanti screenati**, di cui **154 arruolati** e **40 screening failure**.
- **8 duplicati intenzionali**, date incoerenti, valori mancanti non critici, differenze di formattazione e alcune incongruenze di monitoring e query.

Queste imperfezioni servono a verificare deduplicazione, controlli di qualità, denominatori e segnalazione delle anomalie, senza assumere che i dati siano perfetti.

### Plausibilità dei valori sintetici

I record non provengono da trial reali. Per mantenere intervalli plausibili, i range di alcune variabili sono stati confrontati con una selezione limitata di pubblicazioni sui trattamenti rappresentati. Le variabili sono classificate secondo la loro importanza per TrialPulse:

- **HIGH:** intervalli più vicini ai valori plausibili osservati nelle fonti.
- **MEDIUM:** intervalli più flessibili, mantenendo la coerenza del contesto.
- **LOW:** variabilità maggiore, ma sempre plausibile.

Le pubblicazioni sono un **controllo di plausibilità**, non un dataset da riprodurre, una validazione clinica o una revisione sistematica della letteratura.

**Riferimenti scientifici principali:**

- **Psilocibina:** Goodwin et al., *New England Journal of Medicine* (2022), [Single-Dose Psilocybin for a Treatment-Resistant Episode of Major Depression](https://doi.org/10.1056/NEJMoa2206443).
- **Esketamina:** Reif et al., *New England Journal of Medicine* (2023), [ESCAPE-TRD](https://pubmed.ncbi.nlm.nih.gov/37792613/).
- **Destrometorfano + bupropione:** studio [GEMINI](https://pubmed.ncbi.nlm.nih.gov/35649167/).
- **Sertralina:** studio [PANDA](https://pubmed.ncbi.nlm.nih.gov/31543474/).

La classificazione e i riferimenti aggiuntivi sono descritti in `docs/references/plausibility_sources.md`.

## Riproducibilità, sicurezza e verifiche

Il generatore e le configurazioni sono conservati nel repository. Il dataset congelato non viene rigenerato durante l'avvio o i test ordinari.

| Controllo | Valore |
| --- | --- |
| Seed principale | `2939583971211916763` |
| SHA-256 CSV ufficiale | `3f9ad9042443eeecf70071132b87032f2564a6dba4b3d81f01efb18bd8aff7ec` |
| Configurazione riproducibilità | `data_agent/config/reproducibility.yaml` |

### Qualità e testing

Il progetto comprende test unitari e d'integrazione per analisi, deduplicazione, regole e finestre temporali, orchestrazione dei tool, errori e risposte, oltre a test React con **Testing Library**, browser **Playwright** con API simulate e verifiche di avvio multipiattaforma. La qualità del codice è controllata con **Ruff, Black, mypy, ESLint e Prettier**, ciascuno nel perimetro configurato; la tipizzazione Python rigorosa riguarda alcuni moduli, non l'intera codebase.

Le esecuzioni documentate includono **556 test backend superati**, **42 test frontend Node**, **5 test React** e **1 test browser E2E con API simulate**. Una successiva suite Python leggera sulla correzione dell'arresto executor ha ottenuto **108 PASS e 1 SKIP**; lo SKIP riguarda un test di segnalazione POSIX non applicabile a Windows. Sono stati inoltre eseguiti test Docker separati e un collaudo nativo dei servizi su runner Ubuntu e macOS. Questi risultati appartengono a esecuzioni e ambienti distinti e non costituiscono una singola certificazione end-to-end del deployment pubblico.

La [CI GitHub Actions](https://github.com/psychedsem/TrialPulse/actions/workflows/ci.yml) esegue i controlli ordinari a ogni push e pull request; prove più onerose, come il runtime Docker e il RAG con modello, richiedono un avvio esplicito. Il workflow separato per la portabilità nativa verifica l'avvio dei servizi su Ubuntu e macOS. Non vengono eseguite chiamate Groq nei test automatici con provider simulato.

### Isolamento del pandas agent

La validazione AST limita il codice ammesso, ma **non sostituisce una sandbox**. I job vengono eseguiti in container effimeri con rete disabilitata, filesystem read-only, UID non privilegiato, capability rimosse, `no-new-privileges`, seccomp restrittivo, **512 MiB di RAM**, **1 CPU** e **32 processi** al massimo. Il codice generato non controlla l'immagine Docker, i mount, i comandi o i privilegi. L'executor è separato dai servizi web e conserva un lock di sicurezza quando la rimozione di un container non può essere confermata.

Il profilo seccomp deriva da Moby Profiles: [attribuzione e modifiche](data_agent/sandbox/seccomp.json.license) e [licenza Apache-2.0 originale](data_agent/sandbox/LICENSE-APACHE-2.0.txt). Il testo legale di terzi rimane nella lingua originale.

## Installazione e avvio locale

Il modo più semplice per preparare una nuova copia del progetto è utilizzare il **launcher Python nativo**, che coordina le verifiche e l'avvio dei quattro servizi su Windows, Linux e macOS. Per prerequisiti, installazione, istruzioni Bash, avvio manuale e Docker Compose è disponibile la guida [Sviluppo e verifiche locali](docs/local-dev.md).

```text
python scripts/dev.py setup --full
python scripts/dev.py test
python scripts/dev.py start
```

`setup --full` installa le dipendenze, ma non rigenera il CSV e **non costruisce l'indice RAG automaticamente**. Al primo avvio, se l'indice manca, inizializzarlo seguendo la guida; `rag/build_index.py` sostituisce la collezione esistente e non va rilanciato su un indice già preparato. `start` utilizza le porte locali **8000** (Data Agent), **8001** (RAG), **3001** (backend) e **5173** (frontend). Si arrestano i processi di quella sessione con Ctrl+C.

### Configurazione del provider

Le credenziali non devono comparire nel codice né nel frontend. Per una nuova installazione, copiare i template pertinenti senza sovrascrivere eventuali `.env` già presenti:

```powershell
Copy-Item .\backend\.env.example .\backend\.env
Copy-Item .\frontend\.env.example .\frontend\.env.local
Copy-Item .\data_agent\.env.example .\data_agent\.env
```

Configurare `GROQ_API_KEY` soltanto nei componenti server autorizzati. L'interfaccia usa `VITE_API_BASE_URL` per il backend HTTPS della build pubblica e un proxy Vite durante lo sviluppo. Il backend comunica con FastAPI e RAG tramite HTTP locale e dispone di un fallback Python opzionale, disabilitato per impostazione predefinita.

### Analisi dinamica nell'ambiente locale

La modalità dinamica è **disabilitata per impostazione predefinita** (`TRIALPULSE_PANDAS_ENABLED=0`). Richiede un daemon Docker Linux compatibile, un'immagine sandbox verificata, un executor separato e una coda condivisa privata. Il launcher ordinario non la attiva automaticamente. I passaggi manuali per l'ambiente Windows e i test Docker sono documentati di seguito per chi desidera riprodurre il comportamento in isolamento.

Dalla radice del progetto, con Docker Desktop Linux attivo:

```powershell
docker build --file data_agent/sandbox/Dockerfile --tag trialpulse-pandas-sandbox:local data_agent
$sandboxImage = docker image inspect trialpulse-pandas-sandbox:local --format '{{.Id}}'
if ($LASTEXITCODE -ne 0 -or $sandboxImage -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Immagine Docker non verificata.' }
```

L'immagine viene scelta tramite ID `sha256` locale, non tramite tag modificabile. Il Dockerfile fissa il digest della base e le versioni principali, ma non tutte le dipendenze transitive: una nuova build non garantisce lo stesso ID.

In un terminale dedicato, senza chiavi Groq nell'ambiente dell'executor:

```powershell
$pandasQueue = Join-Path $env:TEMP 'trialpulse-pandas-local'
& .\data_agent\.venv\Scripts\python.exe .\data_agent\pandas_executor.py --queue $pandasQueue --image $sandboxImage
```

Prima di avviare il Data Agent, configurare nel suo ambiente la medesima coda e le variabili `TRIALPULSE_PANDAS_ENABLED=1`, `GROQ_API_KEY` e `GROQ_MODEL`. Non avviare un secondo processo sulla porta 8000. L'executor non deve ricevere credenziali né accesso all'ambiente server; un lock residuo richiede verifica dei processi e dei container prima di qualsiasi rimozione manuale.

## Limiti e utilizzo responsabile

TrialPulse è un **prototipo dimostrativo di supporto alle Clinical Research Operations**, non un sistema clinico di produzione. Non diagnostica, non determina l'idoneità di un partecipante, non raccomanda terapie e non stabilisce la superiorità clinica di un trattamento. I dati interamente sintetici non dimostrano risultati di efficacia o sicurezza nella pratica clinica.

Le risposte generate dall'agente richiedono una verifica rispetto alle fonti e ai dati disponibili. TrialPulse integra controlli sulla provenienza delle informazioni, sulla validità degli input e sull'esecuzione isolata delle analisi dinamiche. Tuttavia, la correttezza metodologica dei risultati, in particolare dei grafici generati tramite codice pandas, deve essere verificata prima di utilizzarli a supporto di decisioni operative.

La conversazione recente rimane nella sessione del browser, non in un archivio centrale. Gli artefatti grafici hanno una persistenza locale limitata e non sono inseriti nella history LLM. La demo pubblica non costituisce una certificazione generale di sicurezza, autenticazione o prontezza per l'uso clinico.

## Contatti

Per informazioni sul progetto o per entrare in contatto con me:

- LinkedIn: [Simone "Sem"](https://www.linkedin.com/in/simone-sem/)
