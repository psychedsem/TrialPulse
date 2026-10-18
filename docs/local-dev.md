# Sviluppo e verifiche locali

Requisiti: Python nella versione di `.python-version`, Node.js 22 e npm.
Eseguire i comandi dalla radice del repository. Il launcher Python è compatibile
con Windows, macOS e Linux.

```text
python scripts/dev.py setup --full
python scripts/dev.py test
python scripts/dev.py start
```

`setup` crea `.venv` e installa dipendenze Python e Node dai file versionati.
Senza `--full` installa il profilo Python leggero, senza Chroma o modello RAG.
Non genera dati, non costruisce indici e non modifica configurazioni locali.
Per configurare il provider, copiare manualmente `backend/.env.example` in
`backend/.env` e inserire la propria chiave soltanto nel file locale ignorato.
Il frontend non riceve segreti. Il backend carica la propria configurazione locale.

Il launcher seleziona automaticamente il proprio interprete. Per eseguire invece
i comandi diretti `python -m pytest`, Ruff, Black o mypy, attivare `.venv`:
PowerShell `.\.venv\Scripts\Activate.ps1`; su macOS/Linux `source .venv/bin/activate`.
Senza attivazione si può usare direttamente `.venv/Scripts/python.exe` su Windows
o `.venv/bin/python` su macOS/Linux, senza cambiare le protezioni della shell.

`start` avvia i quattro servizi in primo piano sulle porte 8000, 8001, 3001 e 5173.
Rifiuta l'avvio se una porta è già occupata. Non sostituisce servizi esistenti.
Usare Ctrl+C nello stesso terminale per arrestare i processi creati dal launcher;
`stop` ricorda questa modalità e non cerca processi per nome o PID.
L'analisi pandas dinamica e il trasporto Python di fallback sono disabilitati.
Per le risposte documentali locali serve un indice RAG già disponibile.
Il launcher non lo ricostruisce automaticamente.

Se il comando disponibile è `python3`, usarlo al posto di `python` negli esempi.
`test` esegue backend, test frontend legacy e React, build, lint, formato e Python
leggero. `test --full` include la raccolta Python completa con il modello RAG;
i test del sandbox Docker restano opt-in tramite la loro configurazione dedicata.
Per il browser: `npm --prefix frontend exec playwright install chromium`, poi
`npm --prefix frontend run test:e2e`. Questi test usano servizi simulati.

## Controlli frontend

Dalla cartella `frontend`: `npm test` esegue i test Node, `npm run test:react` verifica App con DOM, API simulate e storage della sessione di test. Il browser E2E descritto sopra usa Vite isolato su 5187, rifiuta una porta occupata e intercetta tutte le API senza backend o provider.
- `npm run lint` controlla frontend e backend: variabili inutilizzate ed effetti React incompleti restano avvisi nei sorgenti esistenti, mentre le variabili inutilizzate sono errori nei test/config.
- `npm run lint:strict` non ammette avvisi nel perimetro dei test/config.
- `npm run format:check` controlla il formato dei test/config dichiarati nello script; `npm run format` modifica solo quel perimetro, senza riscritture generali.
- `npm run format:check:all` mostra il debito dei sorgenti senza modificarli e non è un requisito della build.

React copre invii, loading, Markdown, errori/recupero, history riuscita, PNG persistiti, conferma reset e tastiera; E2E copre errore, recupero, ricaricamento, history nel payload e cancellazione. Le fixture non provano l'affidabilità del modello o dei servizi clinico-operativi. Report e tracce sono in `.tmp/playwright`, esclusa da Git.

## Quattro servizi con Docker Compose

Serve un daemon Docker Linux attivo. La configurazione mantiene Node/Express,
FastAPI/pandas, RAG/Chroma locale e React/Vite in quattro container ordinari.
Il frontend usa il server Vite di sviluppo; non è una configurazione di deploy.
I servizi attendono gli health check dei rispettivi prerequisiti.
L'health RAG controlla lo stato dell'API e la presenza del file SQLite dell'indice.
Non dimostra la correttezza del retrieval, verificata separatamente dal job CI.
Serve l'inizializzazione esplicita sottostante prima dell'avvio completo.

```text
docker compose --env-file backend/.env.example config --quiet
docker compose --env-file backend/.env.example build
docker compose --env-file backend/.env.example run --rm --no-deps rag python build_index.py
docker compose --env-file backend/.env.example up --wait
docker compose --env-file backend/.env.example down
```

Il comando `build_index.py` inizializza o ricostruisce soltanto il volume nominato
`trialpulse-qa-chroma`. Non monta né tocca `rag/chroma_db` dell'host.
Scarica il modello nella cache separata `trialpulse-qa-model-cache`.
`down` conserva entrambi i volumi; non usare `down --volumes` se si desidera
conservare indice e modello. Le porte sono pubblicate soltanto su loopback:
frontend 15173, backend 13001, Data Agent 18000 e RAG 18001.
Sono distinte dalle porte dei servizi locali; il frontend QA si apre su
`http://127.0.0.1:15173`. Sono personalizzabili con le variabili di sessione
`TRIALPULSE_QA_FRONTEND_PORT`, `TRIALPULSE_QA_BACKEND_PORT`,
`TRIALPULSE_QA_DATA_PORT` e `TRIALPULSE_QA_RAG_PORT`.
Il backend ascolta su tutte le interfacce solo all'interno del container.

Compose usa esclusivamente gli esempi di configurazione. La chiave è vuota per
impostazione predefinita; per una conversazione LLM impostare esplicitamente la
variabile di sessione `TRIALPULSE_QA_GROQ_API_KEY`, mai nel frontend o nei file
versionati. Non pubblicare l'output completo di `compose config` con una chiave
impostata. `--env-file backend/.env.example` evita la lettura implicita di `.env`.

L'executor pandas resta un processo separato, escluso da Compose.
Nessun servizio riceve socket Docker, privilegi daemon o directory operative
dell'host; l'analisi dinamica è disabilitata. Il suo collaudo resta indipendente.

## Integrazione continua

`.github/workflows/ci.yml` verifica push e pull request con soli permessi di
lettura: backend, frontend legacy e React, build, lint, formato, browser con mock,
Python leggero e validazione Compose. Non esegue deploy né chiamate LLM.
I job RAG con download del modello, runtime Compose e isolamento del sandbox sono
separati e richiedono le opzioni esplicite nell'avvio manuale del workflow.
L'opzione Docker abilita sia Compose sia i test reali dell'executor esistente;
non aggiunge l'executor ai quattro servizi. Le suite escluse dal profilo
leggero non vanno interpretate come test superati.

Il badge per il README usa lo stato effettivo del workflow su GitHub:

```markdown
[![CI TrialPulse](https://github.com/psychedsem/TrialPulse/actions/workflows/ci.yml/badge.svg)](https://github.com/psychedsem/TrialPulse/actions/workflows/ci.yml)
```

Una configurazione verificata localmente non dimostra un'esecuzione riuscita su GitHub.
