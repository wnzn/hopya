import { useEffect, useState, type SubmitEvent } from "react";
import { api, message } from "../lib/api";
import { Brand, ErrorNotice } from "./Shared";

export default function PasswordRecovery({ mode }: { mode: "forgot" | "reset" }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (mode !== "reset") return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    setToken(params.get("token") || "");
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, [mode]);
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    if (mode === "reset" && values.get("password") !== values.get("confirmPassword")) {
      setError("Passwords do not match.");
      return;
    }
    if (mode === "reset" && !token) {
      setError("Password reset link is invalid or expired.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (mode === "forgot") {
        const response = await api<{ message: string }>("/auth/forgot-password", "POST", { email: values.get("email") });
        setSuccess(response.message);
      } else {
        await api("/auth/reset-password", "POST", { token, password: values.get("password") });
        setSuccess("Your password has been reset. You can now sign in.");
        form.reset();
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  const reset = mode === "reset";
  return (
    <main id="main" className="auth-layout" tabIndex={-1}>
      <section className="auth-aside"><Brand className="brand" /></section>
      <section className="auth-main">
        <div className="auth-card">
          <Brand className="mobile-brand" />
          <h1>{reset ? "Choose a new password" : "Reset your password"}</h1>
          <p className="muted">{reset ? "Use at least 12 characters." : "Enter your sign-in email. If the account is eligible, we'll send a link that expires in 30 minutes."}</p>
          <ErrorNotice error={error} />
          {success ? <>
            <p className="notice success" role="status">{success}</p>
            <a className="button" href="/login">Return to sign in</a>
          </> : <form className="stack" onSubmit={submit}>
            {reset ? <>
              <label>New password<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} /></label>
              <label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256} /></label>
            </> : <label>Email<input name="email" type="email" autoComplete="username" required maxLength={254} /></label>}
            <button className="primary" disabled={busy}>{busy ? "Please wait..." : reset ? "Reset password" : "Send reset link"}</button>
          </form>}
          {!success && <p className="auth-switch"><a href="/login">Return to sign in</a></p>}
        </div>
      </section>
    </main>
  );
}
