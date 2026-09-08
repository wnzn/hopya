import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { api, message, type SiteSettings } from "../lib/api";
import { ErrorNotice } from "./Shared";

export default function SiteSettingsSection() {
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<SiteSettings>("/site/settings", "GET", undefined, controller.signal)
      .then((data) => {
        setSettings(data);
        setLoaded(true);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(message(e));
          setLoaded(true);
        }
      });
    return () => controller.abort();
  }, []);
  async function toggleLanding() {
    if (!settings) return;
    const next = !settings.landingDisabled;
    const landing = window.confirm(
      next
        ? "Disable the public landing page? Visitors will be sent to the sign-in page."
        : "Enable the public landing page?",
    );
    if (!landing) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const updated = await api<{ landingDisabled: boolean }>(
        "/site/settings",
        "PATCH",
        { landingDisabled: next },
      );
      setSettings((current) =>
        current ? { ...current, landingDisabled: updated.landingDisabled } : current,
      );
      setSuccess(next ? "Landing page disabled." : "Landing page enabled.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function uploadLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 300 * 1024) {
      setError("Logo must be at most 300 KB.");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Could not read the file."));
        reader.readAsDataURL(file);
      });
      const result = await api<{ url: string; updatedAt: string }>("/site/logo", "PUT", {
        contentType: file.type,
        data,
      });
      setSettings((current) =>
        current
          ? { ...current, logo: { updatedAt: result.updatedAt, url: result.url } }
          : current,
      );
      setSuccess("Logo updated. Reload other pages to see it.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function deleteLogo() {
    if (!window.confirm("Remove the custom logo and restore the default?")) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api("/site/logo", "DELETE");
      setSettings((current) => (current ? { ...current, logo: null } : current));
      setSuccess("Custom logo removed.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (!loaded) return null;
  return (
    <section className="settings-section" aria-labelledby="site-settings-heading">
      <div className="section-intro">
        <h2 id="site-settings-heading">Site settings</h2>
        <p>
          Landing page visibility and instance branding. Changes apply to this
          instance only.
        </p>
      </div>
      <div className="stack">
        <ErrorNotice error={error} />
        {success && (
          <p className="notice success" role="status">
            {success}
          </p>
        )}
        {!settings ? (
          <p className="muted">Site settings are unavailable.</p>
        ) : (
          <>
            <div className="setting-row">
              <div>
                <strong>Landing page</strong>
                <small className="muted">
                  {settings.landingDisabled
                    ? "Disabled — visitors go straight to sign-in."
                    : "Enabled — visitors see the public landing page."}
                </small>
              </div>
              <button disabled={busy} onClick={() => void toggleLanding()}>
                {settings.landingDisabled ? "Enable landing page" : "Disable landing page"}
              </button>
            </div>
            <div className="setting-row">
              <div>
                <strong>Custom logo</strong>
                <small className="muted">
                  PNG, JPEG, WebP or SVG up to 300 KB. Shown in the sidebar,
                  sign-in page and landing page.
                </small>
                {settings.logo && (
                  <img
                    className="site-logo-preview"
                    src={settings.logo.url}
                    alt="Current custom logo"
                  />
                )}
              </div>
              <div className="button-group">
                <button disabled={busy} onClick={() => fileInput.current?.click()}>
                  {settings.logo ? "Replace logo" : "Upload logo"}
                </button>
                {settings.logo && (
                  <button className="danger" disabled={busy} onClick={() => void deleteLogo()}>
                    Remove
                  </button>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="sr-only-input"
                  onChange={(e) => void uploadLogo(e)}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}