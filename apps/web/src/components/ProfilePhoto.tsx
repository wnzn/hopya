import { useRef, useState, type ChangeEvent } from "react";
import { api, message, type User } from "../lib/api";
import { prepareProfilePhoto } from "../lib/profile-photo";
import Avatar from "./Avatar";
import { ErrorNotice } from "./Shared";

export default function ProfilePhoto({ user, disabled, onChanged, onBusyChange }: {
  user: User;
  disabled: boolean;
  onChanged: (photoUrl: string | null) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function save(file?: File) {
    if (busy || disabled) return;
    setBusy(true); onBusyChange(true); setError(""); setSuccess("");
    try {
      const data = file ? await prepareProfilePhoto(file) : undefined;
      const result = await api<{ photoUrl: string | null }>("/auth/profile/photo", file ? "PUT" : "DELETE", data);
      onChanged(result.photoUrl);
      setSuccess(file ? "Profile photo saved." : "Profile photo removed. Your initial is shown instead.");
    } catch (cause) { setError(message(cause)); }
    finally {
      setBusy(false); onBusyChange(false);
      requestAnimationFrame(() => uploadButton.current?.focus());
    }
  }
  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void save(file);
  }
  return <section className="profile-photo-settings" aria-labelledby="profile-photo-heading" aria-busy={busy}>
    <Avatar name={user.name} photoUrl={user.photoUrl} className="profile-photo-preview" label={`${user.name}'s profile picture`} />
    <div className="stack">
      <div><h3 id="profile-photo-heading">Profile picture</h3>
        <p className="muted" id="profile-photo-help">PNG, JPEG or WebP up to 10 MiB. Saved as a centered square up to 512px and 512 KiB. Your initial is used when no picture is available.</p></div>
      <div className="button-group">
        <button ref={uploadButton} type="button" disabled={busy || disabled} onClick={() => input.current?.click()}>
          {busy ? "Saving photo…" : user.photoUrl ? "Replace picture" : "Upload picture"}
        </button>
        {user.photoUrl && <button type="button" disabled={busy || disabled} onClick={() => void save()}>Remove picture</button>}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only-input" tabIndex={-1}
          aria-label="Choose profile picture" aria-describedby="profile-photo-help" disabled={busy || disabled} onChange={choose} />
      </div>
      <ErrorNotice error={error} />
      {busy && <p role="status" className="muted">Preparing and saving your picture…</p>}
      {success && <p role="status" className="notice success">{success}</p>}
    </div>
  </section>;
}
