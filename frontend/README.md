# TrialPulse frontend

Interfaccia conversazionale React/Vite per TrialPulse, agente di supporto alle operazioni cliniche di Novera Neuro Research. I trial, i siti e i dati visualizzati sono sintetici.

## Avvio in locale

Prerequisiti: Node.js compatibile con Vite 7 e backend Node di TrialPulse attivo sulla porta 3001.

Dalla radice del repository:

```powershell
npm --prefix frontend install
npm --prefix frontend run dev
```

Aprire l'indirizzo mostrato da Vite, normalmente `http://localhost:5173`.

Per avviare il backend in una seconda finestra PowerShell:

```powershell
npm --prefix backend run dev
```

I servizi RAG e Data Agent devono essere attivi affinché le richieste che li utilizzano possano andare a buon fine. Il frontend invia soltanto `{ "message": "..." }` a `POST /api/chat` e visualizza il campo `answer` della risposta JSON.

Vite inoltra `/api` al backend locale senza esporre credenziali nel browser. Per cambiare il target del proxy copiare `.env.example` in `.env.local` e modificare `BACKEND_PROXY_TARGET`. In una distribuzione non gestita dal server Vite occorre configurare un reverse proxy per `/api` verso Node.

## Verifiche

```powershell
npm --prefix frontend test
npm --prefix frontend run build
```

I test unitari verificano la chiamata HTTP e gli errori più comuni. Il comportamento dell'interfaccia, i font caricati da Google Fonts, la risposta reale del modello e la resa responsive richiedono anche una verifica nel browser.

## Interfaccia

- Logo TrialPulse centrato nell'intestazione bianca.
- Simbolo Novera come favicon.
- Messaggi dell'utente con effetto vetro lattiginoso, bordo lucido e riflessi agli angoli; etichetta "Tu" in `#009499`.
- Messaggi TrialPulse bianchi con bordo blu `#051466`.
- Pannello conversazione con bordi laterali, angoli arrotondati e margini esterni bianchi.
- Sfondo della conversazione sfumato, con blu `#9ab1fc` più evidente nella parte inferiore destra.
- Invio con Enter, nuova riga con Shift+Enter.
- Pulsante "Nuova conversazione" nell'intestazione in alto a destra: ripristina la schermata iniziale e cancella i messaggi locali, il testo non inviato e gli eventuali errori. Durante una richiesta in corso il pulsante è disabilitato.
- Barra di composizione e nota sui dati sintetici nella parte inferiore.

I font sono caricati da Google Fonts; se non disponibili viene usato il carattere di fallback indicato nel CSS. Non sono inclusi file di font nel repository.

La conversazione è conservata soltanto nello stato della pagina corrente e viene azzerata al ricaricamento o tramite il pulsante "Nuova conversazione". L'API corrente non riceve una cronologia conversazionale o un identificativo di sessione: i messaggi precedenti non vengono inviati al modello. Il pulsante per ora esegue solo un reset locale, senza creare una sessione lato server. L'interfaccia non implementa autenticazione, dashboard o analisi cliniche autonome.
