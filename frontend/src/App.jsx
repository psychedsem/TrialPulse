import { useEffect, useRef, useState } from "react";
import { requestChat } from "./api/chat.js";
import { MessageText } from "./MessageText.js";
import { loadConversation, saveConversation, selectHistory, resetConversation } from "./conversation.js";

const INITIAL_MESSAGES = [
  {
    id: 0,
    role: "assistant",
    text: "Ciao, sono TrialPulse. Posso consultare la documentazione operativa Novera e analizzare i dati sintetici degli studi clinici. Quale studio, sito o criticità vuoi esaminare?",
  },
];

function ArrowUpIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="M12 19V5m0 0-6 6m6-6 6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Message({ role, text, loading = false }) {
  const isUser = role === "user";
  return (
    <article className={`message ${isUser ? "message--user" : "message--assistant"}`} aria-label={loading ? "TrialPulse sta rispondendo" : undefined}>
      <div className="message__content">
        <div className="message__label">{isUser ? "Tu" : "TrialPulse"}</div>
        <div className={`message__bubble ${isUser ? "message__bubble--glass" : "message__bubble--bot"}${loading ? " message__bubble--loading" : ""}`} role={loading ? "status" : undefined}>
          {loading ? <>
            <span>TrialPulse sta analizzando la richiesta</span>
            <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
          </> : <MessageText role={role} text={text} />}
        </div>
      </div>
    </article>
  );
}

export default function App() {
  const [history, setHistory] = useState(loadConversation);
  const [messages, setMessages] = useState(() => [
    ...INITIAL_MESSAGES,
    ...history.map(({ role, content }, index) => ({ id: index + 1, role, text: content })),
  ]);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const nextId = useRef(messages.length);
  const scrollAreaRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const area = scrollAreaRef.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [messages, isSending, error]);

  async function handleSend(event) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || isSending) return;

    setMessages(current => [...current, { id: nextId.current++, role: "user", text: message }]);
    setDraft("");
    setError("");
    setIsSending(true);

    try {
      const answer = await requestChat(message, globalThis.fetch, selectHistory(history));
      const completed = [...history, { role: "user", content: message }, { role: "assistant", content: answer }];
      saveConversation(completed);
      setHistory(completed);
      setMessages(current => [...current, { id: nextId.current++, role: "assistant", text: answer }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Si è verificato un errore. Riprova.");
    } finally {
      setIsSending(false);
    }
  }

  function handleNewConversation() {
    if (isSending) return;
    if (!resetConversation(messages.length > 1 || Boolean(draft.trim()))) return;
    setHistory([]);
    setMessages(INITIAL_MESSAGES);
    setDraft("");
    setError("");
    nextId.current = 1;
    inputRef.current?.focus();
  }

  function handleComposerKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent?.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <img
          className="app-header__logo"
          src="/brand/trialpulse-logo.png"
          alt="TrialPulse"
          width="1711"
          height="562"
        />
        <div className="app-header__actions">
          <button
            className="app-header__new"
            type="button"
            onClick={handleNewConversation}
            disabled={isSending}
            aria-label="Nuova conversazione"
            title="Nuova conversazione"
          >
            <span className="app-header__new-label">
              <span>Nuova</span>
              <span>Conversazione</span>
            </span>
          </button>
        </div>
      </header>

      <main className="chat-stage" aria-label="Conversazione TrialPulse">
        <div ref={scrollAreaRef} className="chat-stage__scroll" role="log" aria-label="Messaggi della conversazione" aria-live="polite" aria-relevant="additions text">
          <div className="chat-stage__inner">
            {messages.map(message => (
              <Message key={message.id} role={message.role} text={message.text} />
            ))}
            {isSending && <Message role="assistant" loading />}
          </div>
        </div>
      </main>

      <section className="composer-region" aria-label="Scrivi a TrialPulse">
        <form className="composer" onSubmit={handleSend}>
          <label className="visually-hidden" htmlFor="message-input">Messaggio</label>
          <textarea
            id="message-input"
            ref={inputRef}
            className="composer__input"
            placeholder="Scrivi un messaggio..."
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            disabled={isSending}
            rows={2}
          />
          <button
            className="composer__submit"
            type="submit"
            aria-label="Invia messaggio"
            title="Invia messaggio"
            disabled={isSending || !draft.trim()}
          >
            <ArrowUpIcon />
          </button>
        </form>
        {error && <p className="composer__error" role="alert">{error}</p>}
        <p className="composer__disclaimer">
          <strong>Novera Neuro Research</strong>
          <span>: dati sintetici • supporto alle operazioni cliniche</span>
        </p>
      </section>
    </div>
  );
}