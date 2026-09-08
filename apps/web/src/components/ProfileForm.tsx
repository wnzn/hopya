import { useState, type SubmitEvent } from "react";
import { api, message, type User } from "../lib/api";
import { ErrorNotice } from "./Shared";

export default function ProfileForm({ user, setUser, onCredentialsChanged }: {
  user: User;
  setUser: (user: User) => void;
  onCredentialsChanged?: () => void;
}) {
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    const credentialsChanged = password !== "" || email.toLowerCase() !== user.email;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const updated = await api<User>("/auth/profile", "PATCH", {
        name: data.get("name"),
        email,
        ...(credentialsChanged ? { currentPassword: data.get("currentPassword") } : {}),
        ...(password ? { password } : {}),
      });
      setUser(updated);
      if (credentialsChanged) onCredentialsChanged?.();
      form.elements.namedItem("currentPassword") && ((form.elements.namedItem("currentPassword") as HTMLInputElement).value = "");
      form.elements.namedItem("password") && ((form.elements.namedItem("password") as HTMLInputElement).value = "");
      setSuccess(credentialsChanged
        ? "Account updated. Other sessions and existing tokens have been revoked."
        : "Your profile has been updated.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section id="profile-security" className="settings-section" aria-labelledby="profile-heading">
      <div className="section-intro">
        <h2 id="profile-heading">Profile &amp; security</h2>
        <p>Your name, sign-in email, and local password.</p>
      </div>
      <div className="stack">
        <ErrorNotice error={error} />
        {success && <p className="notice success" role="status">{success}</p>}
        <form className="stack" onSubmit={submit}>
          <label>
            Display name
            <input name="name" defaultValue={user.name} required autoComplete="name" maxLength={120} />
          </label>
          <label>
            Email
            <input name="email" type="email" defaultValue={user.email} required autoComplete="username" maxLength={254} />
          </label>
          <div className="form-grid">
            <label>
              Current password
              <input name="currentPassword" type="password" autoComplete="current-password" maxLength={256} />
            </label>
            <label>
              New password
              <input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={256} />
            </label>
          </div>
          <small className="muted">
            Your current password is required to change your email or password. Leave password fields empty to keep your password.
          </small>
          <div><button className="primary" disabled={busy}>{busy ? "Saving..." : "Save account"}</button></div>
        </form>
      </div>
    </section>
  );
}
