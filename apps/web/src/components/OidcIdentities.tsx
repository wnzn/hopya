import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { api, message, type OidcIdentity, type User } from "../lib/api";
import { ErrorNotice } from "./Shared";
import Select from "./Select";

export default function OidcIdentities({
  users,
  currentUserId,
}: {
  users: User[];
  currentUserId: string;
}) {
  const [userId, setUserId] = useState("");
  const account = users.find((user) => user.id === userId);
  return (
    <section
      className="settings-section oidc-identities"
      aria-labelledby="oidc-heading"
    >
      <div className="section-intro">
        <h2 id="oidc-heading">OIDC identities</h2>
        <p>
          Link an existing Hopya account to a verified SSO identity. This does
          not create an identity-provider account or change workspace permissions.
        </p>
      </div>
      <div className="stack">
        <label>
          Identity account
          <Select
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
          >
            <option value="">Choose an account</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} ({user.email}){user.disabled ? " - Disabled" : ""}
              </option>
            ))}
          </Select>
        </label>
        {account ? (
          <AccountIdentities
            key={account.id}
            account={account}
            currentUserId={currentUserId}
          />
        ) : (
          <p className="muted">
            Choose an account to view and manage its linked identities.
          </p>
        )}
      </div>
    </section>
  );
}

function AccountIdentities({
  account,
  currentUserId,
}: {
  account: User;
  currentUserId: string;
}) {
  const [identities, setIdentities] = useState<OidcIdentity[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [revision, setRevision] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // The keyed panel discards drafts/results on account changes; abort both reads and writes.
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setIdentities(null);
    setError("");
    const query = new URLSearchParams({ userId: account.id });
    api<OidcIdentity[]>(
      `/admin/oidc-identities?${query}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((rows) => {
        if (!controller.signal.aborted)
          setIdentities(
            rows.filter((identity) => identity.userId === account.id),
          );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [account.id, revision]);

  async function link(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.current || loading || !identities) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      // Send the operator's exact values. Adonis validates and authorizes the binding.
      await api(
        "/admin/oidc-identities",
        "POST",
        {
          userId: account.id,
          issuer: data.get("issuer"),
          subject: data.get("subject"),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      form.reset();
      setSuccess("Identity linked. The list is being refreshed.");
      setRevision((r) => r + 1);
      heading.current?.focus();
    } catch (e) {
      if (!controller.signal.aborted) setError(message(e));
    } finally {
      if (!controller.signal.aborted) {
        mutation.current = null;
        setBusy(false);
      }
    }
  }

  async function unlink(identity: OidcIdentity) {
    if (mutation.current || loading) return;
    if (
      !window.confirm(
        `Unlink this identity from ${account.name} (${account.email})?\n\nIssuer: ${identity.issuer}\nSubject: ${identity.subject}\n\nThis revokes ALL sessions and programmatic tokens for this account, signing it out on every device. The server will reject removing the last sign-in method if the account has no password.${account.id === currentUserId ? "\n\nThis is your account. You will need to sign in again." : ""}`,
      )
    )
      return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api<{ success: true }>(
        `/admin/oidc-identities/${encodeURIComponent(identity.id)}`,
        "DELETE",
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (account.id === currentUserId) {
        window.location.assign("/login");
        return;
      }
      setSuccess(
        "Identity unlinked. All sessions and programmatic tokens for this account were revoked.",
      );
      setRevision((r) => r + 1);
      heading.current?.focus();
    } catch (e) {
      if (!controller.signal.aborted) setError(message(e));
    } finally {
      if (!controller.signal.aborted) {
        mutation.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <div className="stack">
      <div className="section-heading">
        <h3 ref={heading} tabIndex={-1}>
          Linked identities
        </h3>
        <button
          type="button"
          disabled={busy || loading}
          onClick={() => setRevision((r) => r + 1)}
        >
          Refresh identities
        </button>
      </div>
      <ErrorNotice error={error} />
      {success && (
        <p className="notice success" role="status">
          {success}
        </p>
      )}
      {loading ? (
        <p role="status">Loading linked identities...</p>
      ) : identities?.length === 0 ? (
        <p className="notice">No linked identities for this account.</p>
      ) : (
        identities && (
          <ul
            className="record-list oidc-records"
            aria-label="Linked identities"
          >
            {identities.map((identity) => (
              <li key={identity.id}>
                <div>
                  <dl>
                    <dt>Issuer</dt>
                    <dd>
                      <code>{identity.issuer}</code>
                    </dd>
                    <dt>Subject</dt>
                    <dd>
                      <code>{identity.subject}</code>
                    </dd>
                    <dt>Linked</dt>
                    <dd>
                      <time dateTime={identity.createdAt}>
                        {new Date(identity.createdAt).toLocaleString()}
                      </time>
                    </dd>
                  </dl>
                </div>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void unlink(identity)}
                  aria-label={`Unlink subject ${identity.subject} from issuer ${identity.issuer}`}
                >
                  Unlink
                </button>
              </li>
            ))}
          </ul>
        )
      )}
      <form className="stack" onSubmit={link} aria-label="Link OIDC identity">
        <h3>Link an identity</h3>
        <p className="notice" id="oidc-verification">
          Verify the exact issuer URL and OIDC subject (sub) in your trusted
          identity provider before linking. Ask your operator for the configured
          HTTPS issuer; no host is assumed here. Email is not proof of identity.
          Do not substitute an email address for the subject. For Ory, the
          issuer is Hydra, not Kratos. Never paste passwords, tokens, client
          secrets or private keys.
        </p>
        <fieldset
          className="bare-fieldset stack"
          disabled={busy}
          aria-describedby="oidc-verification"
        >
          <legend className="sr-only">Verified identity values</legend>
          <label>
            Exact issuer URL
            <input
              name="issuer"
              type="url"
              pattern="https://.+"
              required
              maxLength={2048}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              title="Paste the exact HTTPS issuer URL configured by your operator."
            />
          </label>
          <label>
            Exact OIDC subject (sub)
            <input
              name="subject"
              type="text"
              required
              maxLength={255}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="checkbox-label">
            <input type="checkbox" required />I verified this issuer and subject
            at my trusted OIDC provider for the selected account, not by email.
          </label>
          <div>
            <button className="primary" disabled={loading || !identities}>
              {busy ? "Saving..." : "Link identity"}
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
