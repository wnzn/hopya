import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { api, message, workspacePath, type Proposal } from "../lib/api";
import { plainText } from "../lib/rich-text";
import { ErrorNotice, useDialog } from "./Shared";

export default function Agent({
  workspaceId,
  writable,
  onReview,
  onClose,
}: {
  workspaceId: string;
  writable: boolean;
  onReview: (proposal: Proposal) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<
    { role: "You" | "Assistant"; text: string; proposal?: Proposal }[]
  >([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), [workspaceId]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setModal(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useDialog(ref, modal);
  const Panel = modal ? "dialog" : "aside";
  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    const controller = new AbortController();
    request.current = controller;
    setError("");
    setBusy(true);
    const text = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "You", text }]);
    try {
      const result = await api<{ reply: string; proposal?: Proposal }>(
        `${workspacePath(workspaceId)}/agent`,
        "POST",
        { message: text },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setMessages((m) => [
        ...m,
        { role: "Assistant", text: result.reply, proposal: result.proposal },
      ]);
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(message(e));
        setInput((current) => current || text);
      }
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <Panel
      ref={(element) => { ref.current = element; }}
      className="agent-panel"
      aria-modal={modal || undefined}
      aria-label="Workspace assistant"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (!modal && event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="agent-head">
        <div>
          <h2>Workspace assistant</h2>
        </div>
        <button aria-label="Close assistant" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="chat-log" role="log" aria-live="polite">
        {messages.length === 0 && (
          <div className="chat-empty">
            <h3>Turn a thought into a next step.</h3>
            <p>
              Ask for a summary, find a loose end, or describe a task you'd like
              to create.
            </p>
          </div>
        )}
        {messages.map((entry, i) => (
          <div
            key={i}
            className={`chat-message ${entry.role === "You" ? "from-user" : ""}`}
          >
            <strong>{entry.role}</strong>
            <p>{entry.text}</p>
            {entry.proposal && (
              <div className="proposal">
                <small>SUGGESTED TASK</small>
                <h3>{entry.proposal.title}</h3>
                {entry.proposal.description && (
                  <p>{plainText(entry.proposal.description)}</p>
                )}
                <button
                  disabled={!writable}
                  onClick={() => onReview(entry.proposal!)}
                >
                  Review suggestion
                </button>
                {!writable && (
                  <small>
                    You need task-write permission to create this task.
                  </small>
                )}
              </div>
            )}
          </div>
        ))}
        {busy && <p role="status">Thinking...</p>}
      </div>
      <ErrorNotice error={error} />
      <form className="agent-compose" onSubmit={send}>
        <label htmlFor="agent-message" className="sr-only">
          Message the assistant
        </label>
        <textarea
          id="agent-message"
          value={input}
          maxLength={8000}
          rows={3}
          required
          onChange={(e) => setInput(e.target.value)}
          placeholder="What would you like to work through?"
        />
        <button className="primary" disabled={busy || !input.trim()}>
          {busy ? "Waiting..." : "Send message"}
        </button>
      </form>
    </Panel>
  );
}
