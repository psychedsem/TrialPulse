# TrialPulse frontend

Interfaccia conversazionale React/Vite per TrialPulse, agente di supporto alle operazioni cliniche di Novera Neuro Research. I trial, i siti e i dati visualizzati sono sintetici.

## Avvio in locale

Prerequisiti: Node.js compatibile con Vite 7 (versione di riferimento in `.nvmrc`) e backend Node di TrialPulse attivo sulla porta 3001.

Dalla radice del repository:

```powershell
npm --prefix frontend install
npm --prefix frontend run dev
```

Aprire l'indirizzo mostrato da Vite, normalmente `http://localhost:5173`.

Per avviare il backend in una seconda finestra PowerShell:

```powershell
npm --prefix backend run start
```

Le richieste documentali e analitiche richiedono i servizi RAG e Data Agent disponibili. Il backend può usare anche il recupero Python locale facoltativo descritto nel [README principale](../README.md), quando esplicitamente configurato e nelle sole condizioni previste. Il frontend invia a `POST /api/chat` il messaggio corrente e la cronologia recente in `{ "message": "...", "history": [...] }`, poi visualizza il campo `answer` della risposta JSON. La cronologia inviata comprende al massimo 8 messaggi precedenti e 6.000 caratteri, mantenendo coppie utente/assistente complete.

Vite inoltra `/api` al backend locale senza esporre credenziali nel browser. Per cambiare il target del proxy copiare `.env.example` in `.env.local` e modificare `BACKEND_PROXY_TARGET`. In una distribuzione non gestita dal server Vite occorre configurare un reverse proxy per `/api` verso Node.

## Verifiche

```powershell
npm --prefix frontend test
npm --prefix frontend run build
```

I test verificano chiamate HTTP, errori, cronologia, persistenza, reset e rendering Markdown sicuro, comprese le tabelle. Il comportamento dell'interfaccia, i font caricati da Google Fonts, la risposta reale del modello e la resa responsive richiedono anche una verifica nel browser.

## Interfaccia

- Logo TrialPulse centrato nell'intestazione bianca.
- Simbolo Novera come favicon.
- Messaggi dell'utente con effetto vetro lattiginoso, bordo lucido e riflessi agli angoli; etichetta "Tu" in `#009499`.
- Messaggi TrialPulse bianchi con bordo blu `#051466`.
- Pannello conversazione con bordi laterali, angoli arrotondati e margini esterni bianchi.
- Sfondo della conversazione sfumato, con blu `#9ab1fc` più evidente nella parte inferiore destra.
- Invio con Enter, nuova riga con Shift+Enter.
- Pulsante "Nuova conversazione" nell'intestazione in alto a destra, disabilitato durante una richiesta; reset e conferma descritti sotto.
- Barra di composizione e nota sui dati sintetici nella parte inferiore.

I font sono caricati da Google Fonts; se non disponibili viene usato il carattere di fallback indicato nel CSS. Non sono inclusi file di font nel repository.

La conversazione viene conservata in `sessionStorage` del browser e ripristinata dopo il ricaricamento della scheda. Il pulsante "Nuova conversazione" chiede conferma, cancella la cronologia locale e riporta alla schermata iniziale. Il backend riceve il contesto recente in ogni richiesta, ma non mantiene un archivio delle conversazioni né un identificativo di sessione lato server. Se una richiesta fallisce, l'utente può riprovare: il tentativo non riuscito non viene aggiunto alla cronologia persistita. L'interfaccia non implementa autenticazione, dashboard o analisi cliniche autonome.
