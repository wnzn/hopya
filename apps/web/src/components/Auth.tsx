import { useEffect, useState, type SubmitEvent } from "react";
import { api, message, type Config } from "../lib/api";
import { ErrorNotice, Loading, Brand } from "./Shared";

export default function Auth() {
  const [config, setConfig] = useState<Config | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Config>("/config")
      .then(setConfig)
      .catch((e) => setError(message(e)));
  }, []);
  const setup = config?.setupRequired;
  const creating = setup || mode === "register";
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api(`/auth/${setup ? "setup" : mode}`, "POST", values);
      window.location.assign("/app");
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <main id="main" className="auth-layout" tabIndex={-1}>
      <section className="auth-aside">
        <Brand className="brand" />
      </section>
      <section className="auth-main">
        <div className="auth-card">
          <Brand className="mobile-brand" />
          <h1>
            {setup
              ? "Set up your home"
              : creating
                ? "Join the workspace"
                : "Welcome back"}
          </h1>
          <p className="muted">
            {setup
              ? "Create the first administrator using the setup token provided by your operator."
              : creating
                ? "Create your account to use this workspace."
                : "Pick up where you left off."}
          </p>
          <ErrorNotice error={error} />
          {!config ? (
            error ? (
              <button onClick={() => window.location.reload()}>
                Try again
              </button>
            ) : (
              <Loading />
            )
          ) : (
            <>
              <form onSubmit={submit} className="stack">
                {creating && (
                  <label>
                    Your name
                    <input
                      name="name"
                      aria-label="Your name"
                      autoComplete="name"
                      required
                      maxLength={120}
                    />
                  </label>
                )}
                <label>
                  Email
                    <input
                      name="email"
                      aria-label="Email"
                      type="email"
                    autoComplete="username"
                    required
                    maxLength={254}
                  />
                </label>
                <label>
                  Password
                    <input
                      name="password"
                      aria-label="Password"
                      type="password"
                    autoComplete={
                      creating ? "new-password" : "current-password"
                    }
                    required
                    minLength={creating ? 12 : 1}
                    maxLength={256}
                  />
                </label>
                {creating && (
                  <small className="muted">
                    Use at least 12 characters for your password.
                  </small>
                )}
                {setup && (
                  <label>
                    Operator setup token
                    <input
                      name="setupToken"
                      aria-label="Operator setup token"
                      type="password"
                      autoComplete="off"
                      required
                      maxLength={512}
                    />
                    <small>
                      Ask the person hosting this instance. This is not a public
                      invitation code.
                    </small>
                  </label>
                )}
                <button className="primary" disabled={busy}>
                  {busy
                    ? "Please wait..."
                    : setup
                      ? "Create administrator"
                      : creating
                        ? "Create account"
                        : "Sign in"}
                </button>
              </form>
              {!setup && !creating && config.passwordResetEnabled && (
                <p className="auth-switch"><a href="/forgot-password">Forgot your password?</a></p>
              )}
              {!setup && config.ssoEnabled && (
                <a className="button sso" href="/api/v1/auth/sso">
                  Continue with single sign-on
                </a>
              )}
              {!setup && config.registrationEnabled && (
                <p className="auth-switch">
                  {creating ? "Already have an account?" : "New here?"}{" "}
                  <button
                    className="text-button"
                    onClick={() => {
                      setMode(creating ? "login" : "register");
                      setError("");
                    }}
                  >
                    {creating ? "Sign in" : "Create an account"}
                  </button>
                </p>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
