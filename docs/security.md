# Security

Hopya is an early implementation, not an audited or production-ready security product. This document describes the current boundaries and operator obligations, not a guarantee against compromise.

## Trust Boundaries

- AdonisJS owns authentication, authorization, validation and data mutations. Astro pages and React controls are not authorization controls.
- Tasks, documents, hierarchy, custom fields, comments, reactions, notifications and attachments belong to a workspace. User-supplied workspace/resource/parent/comment IDs, roles, anchors and AI arguments pass server-side scoping, permission, and bounded-input checks on every operation. Notification ownership always comes from authentication, never a request user ID.
- Site administration manages accounts and restricted audit information; being a site administrator does not implicitly grant membership in another user's workspace.
- The workspace Owner role is protected. Role management must not grant privileges the caller cannot delegate, and the last active owner cannot be removed.
- SQL uses bound parameters; relational mutations and their audit entries are transactional. Audit records should identify actions/resources without storing task bodies, credentials or full AI prompts.
- Assignment and task user-mention notifications contain task/comment references and actor metadata, not copied bodies. Mention targets must be active same-workspace task readers, are limited to 20 per body, and do not let same-origin links bypass authorization when opened. Document comments currently offer task/structure links but not user-mention notifications. `comments:create` is separate from write permission; moderation is `comments:manage`. Site-administrator status alone grants no workspace discussion access.

## Authentication

First setup requires the operator's random `SETUP_TOKEN` and closes once an account exists. There are no shipped users or default passwords. Registration is opt-in. Keep a recoverable local administrator credential and restrict access to the initial setup page.

Passwords are salted with scrypt. Browser sessions use HttpOnly, SameSite=Lax cookies; `APP_URL=https://...` enables Secure cookies. Session, programmatic-token and password-reset-token values are random and stored hashed, with expiry and revocation checks. Personal tokens are revealed once and act with their owner's permissions, not a separately restricted token scope. Email/password changes recheck the authenticating credential inside the committing transaction after asynchronous hashing, then revoke prior credentials; intervening logout, expiry or revocation cannot produce a replacement session. Disabled users cannot continue using sessions/tokens.

Unsafe browser requests require the `Origin` to match `APP_URL`. Bearer requests without cookies may authenticate without an Origin; supplying a browser Origin still requires a match. Do not allow wildcard CORS or strip Origin checks for convenience. Optional local password recovery requires both `SMTP_URL` and `SMTP_FROM`; it gives generic request responses, fragment-only 30-minute links, single-use tokens, and complete Hopya session/token revocation. External mailbox delivery is not guaranteed or certified. There is no built-in multi-factor authentication; use a properly tested identity provider for stronger sign-in policy and maintain an operator recovery plan.

The direct API defaults to `TRUST_PROXY_HOPS=0`, ignoring forwarded IP headers. Compose sets `1` only for the private API behind the supplied Nginx, which overwrites `X-Forwarded-For`/`X-Real-IP` and removes `Forwarded`. Keep that API unpublished and its network restricted. Password-login limits are partitioned by normalized account and verified IP; SSO-start and other non-login limits are not account-partitioned. Add appropriate edge abuse limits rather than relying solely on this in-memory application limiter.

Login permits 10 requests per normalized account/IP and 100 total requests per verified IP within a fixed 15-minute window, including invalid bodies and failed attempts. Password-reset requests additionally allow three attempts per normalized email per hour and use the ordinary 10-attempt verified-IP category. Login storage is isolated from other categories and bounded to 1,000 IP windows, each holding at most 100 account hashes. Other categories retain at most 10,000 windows and 10 attempts per category/IP (assistant categories also include the authenticated user). Full capacity fails closed for new windows and every limit response includes `Retry-After`. A single IP rotating email strings cannot consume unrelated authentication slots; a distributed attack can still saturate address capacity, and busy shared NATs can hit the aggregate ceiling. Configure trusted proxy addresses and edge protection accordingly. Restarting the single API clears this in-memory accounting; it is not a distributed abuse-defense service.

An outer TLS proxy requires narrowly configured inner-Nginx real-IP handling: `set_real_ip_from` must identify the exact trusted outer socket-peer address, with `real_ip_header X-Forwarded-For`, and the outer proxy must overwrite that header with a verified client address. Never trust all addresses or a broad/shared Docker subnet. Without real-IP handling, users can share the outer proxy's SSO bucket; overly broad handling lets attackers spoof it. See the [deployment trust-chain instructions](deployment.md#https). Rotating forged forwarding headers was tested against the supplied one-hop stack, not every possible outer-proxy configuration.

## Secrets And Privacy

Keep `.env` private, out of source control, images, build context, exports and diagnostic bundles. Only the API receives application/provider secrets. Docker administrators can inspect container environments and data; this deployment does not defend against a compromised host or Docker daemon. Use encrypted disks/backups where appropriate. `APP_KEY` is not database encryption: SQLite, attachments, audit data and exports are readable to their storage administrator.

The supplied Nginx access log omits query strings, bodies, cookies, authorization and referrers. Its error log is deliberately limited to critical diagnostics because request errors may include OIDC callback query values. Apply equivalent filtering to any outer proxy and monitoring agent. Treat route IDs, IP addresses and audit metadata as private information too. Do not enable verbose request/provider logging in a live deployment without redaction review.

Core operation has no mandatory hosted service or silent telemetry. Astro telemetry is explicitly disabled in supplied build/dev scripts and containers. Optional S3, OIDC and AI connections necessarily disclose some data to those operator-selected services. Audit each dependency and integration rather than interpreting this as a blanket no-network promise.

## Optional Services

`OIDC_ISSUER` must exactly match discovery's `issuer`, including trailing slash and case. URL-equivalent strings are not interchangeable identity bindings. Passwordless unlink must leave another identity for that exact configured issuer with a configured client; inactive-issuer links or disabled SSO do not count as recovery. This local guard makes no provider request and cannot prove that an operator-linked subject still exists or that the provider is available. Verify the new identity before unlinking the old one; use suspension to quarantine access without removing recovery links.

OIDC must validate issuer, audience, state, nonce and PKCE; identities bind to `(issuer, subject)`. Email is not a stable identifier and must not automatically link an existing local account. Keep auto-provisioning and insecure HTTP off unless their implications are understood. Restrict allowed identities at the provider and test account disablement/logout behavior. Local logout is not necessarily provider-wide logout. See [OpenID claim stability](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability).

External identity-provider sessions are independent from Hopya sessions. Configure provider-side session revocation after recovery and deprovisioning, and revoke or suspend the corresponding Hopya account after an incident. Restoring an older identity or Hopya database can revive credentials valid at that snapshot; repeat revocation before reopening a restored service.

Attachments are private API resources, not anonymous uploads. Use bounded payloads, generated object keys and attachment disposition rather than executing or serving uploaded content as application HTML. Authorization does not make a file harmless: no malware-scanning guarantee is provided. Keep S3 buckets private, use least-privilege credentials and encryption, and maintain independent versioned backups. See [AWS S3 security guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html).

AI inputs and model outputs are untrusted. Task text can contain prompt injection. The assistant must use authorized workspace context and offer proposals rather than silently mutate data. A human must review the actual affected task, workspace and fields before confirming through normal permission-checked routes. This does not make model-supplied facts reliable. Provider destinations/keys are operator-configured; restrict egress as needed and consider model-provider retention and billing.

MCP supports local stdio forwarding and an administrator-controlled SSE endpoint that is disabled by default. SSE requires a personal bearer token on the initial stream and every message POST; cookies and URL tokens are rejected. Sessions are bound to the authenticated user, bounded per user/instance, expire after 30 minutes, and close when the setting is disabled. Calls use the same workspace permission checks as REST, and site-admin status alone grants no task access. MCP exposes only read tools by default. `HOPYA_MCP_ALLOW_WRITES=true` is operator consent to expose mutation tools, not consent to any particular action; the MCP host must enforce human approval for each write. Leave writes disabled when the host cannot enforce that policy. A model or `confirmed` argument alone is not proof of human consent. A personal token can access all workspaces its user can access; use a separate account with minimal memberships for automation. See the [integration guide](integrations.md) and [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## Container Controls

The supplied stack uses non-root processes, read-only root filesystems, bounded temporary storage, dropped Linux capabilities and `no-new-privileges`. It never mounts the Docker socket or publishes the API/web ports. The only default host listener is loopback port 8888. `/data` remains writable by the API, so an API compromise could still change or erase its data. Private networking is not isolation from other compromised containers sharing that network.

Keep the host kernel, Docker, pinned images and dependencies patched; digest pinning does not apply future fixes automatically. Do not run privileged containers or give application users Docker access. Review [OWASP Docker Security](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html), including its warning that Docker-published ports can bypass assumptions about host firewall rules.

## Before Wider Use

- Test HTTPS, secure cookies, exact Origin enforcement and intended hostname routing.
- Run authorization and integration tests, including forged cross-workspace IDs and denied token access.
- Rehearse cold backup and restore with local objects and, separately, S3 object versions.
- Review dependencies/images, establish patching cadence and measure resource/abuse limits.
- Restrict registration/provisioning, review admin/Owner memberships and remove unused tokens.
- Verify logs contain no raw credentials, authorization callback codes or entire AI prompts.
- Establish a private security reporting channel before public distribution. None is designated yet; contact the instance operator privately and do not include live credentials in public reports.

If compromise is suspected, isolate access, preserve appropriately protected evidence and revoke affected credentials. Rotating `APP_KEY` alone does not replace token revocation or clean recovery. Coordinate provider-key rotation with the respective providers and verify a trusted backup before restoring. Recovery can resurrect old token/session records, so review them before reopening the site.
