import { useEffect, useState, type SubmitEvent } from "react";
import { api, message } from "../lib/api";
import { ErrorNotice, Loading, Shell, ThemeToggle, useSession } from "./Shared";
import ProfileForm from "./ProfileForm";

type Token = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
};

export default function Account() {
  const { user, setUser, error: authError } = useSession();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [rawToken, setRawToken] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<Token[]>("/auth/tokens", "GET", undefined, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setTokens(next); })
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [user?.id, revision]);

  async function createToken(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || profileBusy || loading || rawToken) return;
    const form = event.currentTarget;
    const name = new FormData(form).get("name");
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await api<{ token: string }>("/auth/tokens", "POST", { name });
      setRawToken(result.token);
      form.reset();
      setTokens(await api<Token[]>("/auth/tokens"));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(token: Token) {
    if (busy || profileBusy || !window.confirm(`Revoke "${token.name}"? Apps using it will lose access immediately.`)) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api(`/auth/tokens/${token.id}`, "DELETE");
      setTokens((current) => current.filter((t) => t.id !== token.id));
      setSuccess("Token revoked.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell user={user} active="account" currentPage="Account settings">
      <div className="settings-body">
        <h1>Account settings</h1>
        <p className="muted">Your profile, appearance, sign-in security and personal access tokens.</p>
        <ErrorNotice error={authError} />
        {authError ? <button onClick={() => window.location.reload()}>Reload account</button> : !user ? <Loading /> : (
          <>
            <ProfileForm user={user} setUser={setUser} disabled={busy} onBusyChange={setProfileBusy} onCredentialsChanged={() => {
              setRawToken("");
              setTokens([]);
              setSuccess("");
              setRevision((current) => current + 1);
            }} />
            <section className="settings-section" aria-labelledby="appearance-heading">
              <div className="section-intro">
                <h2 id="appearance-heading">Appearance</h2>
                <p>Choose light or dark mode, or follow your device settings.</p>
              </div>
              <ThemeToggle />
            </section>
            <section className="settings-section" aria-labelledby="tokens-heading">
              <div className="section-intro">
                <h2 id="tokens-heading">Personal access tokens</h2>
                <p>
                  Connect scripts and MCP clients. Tokens act as you and respect
                  your workspace permissions.
                </p>
              </div>
              <div className="stack">
                <ErrorNotice error={error} />
                {error && <button disabled={busy || loading} onClick={() => setRevision((current) => current + 1)}>Reload tokens</button>}
                {success && <p className="notice success" role="status">{success}</p>}
                {rawToken && (
                  <div className="notice token-reveal">
                    <strong>Copy this token now. It will not be shown again.</strong>
                    <label>
                      New access token
                      <input
                        readOnly
                        type="text"
                        value={rawToken}
                        onFocus={(e) => e.target.select()}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <button onClick={() => setRawToken("")}>I saved it. Hide token.</button>
                  </div>
                )}
                <form className="inline-form" onSubmit={createToken}>
                  <label>
                    Token name
                    <input name="name" required maxLength={120} placeholder="e.g. Local MCP client" />
                  </label>
                  <button disabled={busy || profileBusy || loading || !!rawToken}>Create token</button>
                </form>
                {loading ? <Loading /> : tokens.length ? (
                  <ul className="record-list">
                    {tokens.map((token) => (
                      <li key={token.id}>
                        <div>
                          <strong>{token.name}</strong>
                          <small>
                            Created {new Date(token.createdAt).toLocaleDateString()}
                            {token.lastUsedAt && ` · Last used ${new Date(token.lastUsedAt).toLocaleDateString()}`}
                            {token.expiresAt && ` · Expires ${new Date(token.expiresAt).toLocaleDateString()}`}
                          </small>
                        </div>
                        <button className="danger" disabled={busy || profileBusy} onClick={() => void revoke(token)}>Revoke</button>
                      </li>
                    ))}
                  </ul>
                ) : !error && <p className="muted">No active tokens. Only create one when you need programmatic access.</p>}
              </div>
            </section>
          </>
        )}
      </div>
    </Shell>
  );
}
