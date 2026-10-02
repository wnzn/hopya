# Effect 4 Workflows

Reviewed 2026-10-02. Hopya uses stable `effect@4.0.0` on the pinned Node 24 runtime. The API dependency now declares `^4.0.0`; the lockfile records the exact release. Adonis/Lucid continue to own authentication, permissions, SQL transactions and migrations. Effect describes integration failures, resource lifetimes and bounded concurrency.

## Native v4 migration

The migration uses actual v4 APIs, without a compatibility shim:

- `Effect.result` returns `Success.success` or `Failure.failure`, replacing `either` and its `Right`/`Left` cases.
- `Effect.callback` adapts Node HTTP callbacks and returns an interruption finalizer.
- `Effect.catch`/`catchCause`, `timeoutOrElse({ duration, orElse })`, and `Semaphore` replace their v3 counterparts.
- Causes contain a flat `reasons` array. Native v4 `runPromise`/`runSync` squash Causes to original failure/defect values rather than v3's `FiberFailure` wrapper. Hopya's `runSyncThrow` and `runPromiseThrow` explicitly inspect `Exit`, preserve original identity including `HttpError`, and convert interruption-only causes to `AbortError`. The Promise bridge accepts an optional abort signal.
- New reusable integration generators use `Effect.fnUntraced`. Runtime execution is kept at Promise/worker boundaries; graph actions yield their HTTP, credential and SMTP Effects directly.

Expected failures belong in `Effect.try`, `tryPromise` or `fail`. `Effect.promise` and `sync` turn exceptions into defects. `result` handles expected failures, not defects. The shared bridge still supports deliberately propagated defects in existing security/database code; this migration does not reclassify database outages as invalid credentials.

## Durable automation execution

The database queue remains authoritative. Event enqueueing still commits with the originating audited mutation, versions stay immutable, and task-updating actions use the publisher's ordinary workspace-scoped service operations with causation/re-entry limits.

The worker claims four runs at a time and evaluates them with concurrency four. Each run captures its own `Exit`, including unexpected defects, so a failure cannot cancel sibling deliveries. Errors in stored data and local state I/O are explicit, sanitized failures. A failed attempt records running steps/nodes as failed and untouched ones as skipped, in one lease-checked transaction. Already delivered outputs are preserved. Completion and legacy step acknowledgments now also require the current lease.

All expired running leases—graph, linear and standalone webhook—fail closed. **Expired legacy/webhook attempts are no longer automatically replayed.** A remote endpoint might have accepted a write before its local acknowledgment failed. Failure/timeout does not prove that the remote effect did not happen; operators must inspect the remote outcome before explicitly starting another attempt. No delivery, token exchange or SQL/task mutation is blindly retried.

Lucid Promises cannot be cancelled. State operations wait for their real outcome before interruption releases a worker or terminal-state recovery runs. SQLite worker state operations are serialized separately from network deliveries: a synchronous `better-sqlite3` busy wait otherwise prevents another worker's transaction from committing on the same event loop. PostgreSQL retains concurrent state operations. If recording failure is itself unavailable, the attempt keeps its lease for fail-closed expiry instead of being presented as successful.

## Transport and credential lifetimes

- Each hostname resolution owns a cancellable DNS resolver, checks A and AAAA concurrently, and has a five-second deadline. Both families are checked against the existing network policy before selecting a pin.
- Pinned HTTP uses one fresh socket per resolution, rejects redirects, retains body/response limits and absolute/socket deadlines, and destroys request/response resources on interruption. Synchronous native header/configuration exceptions are typed sanitized failures; native errors containing header names or values are never persisted.
- Graph execution rechecks publisher access before every node and again after DNS/OAuth work immediately before an outbound HTTP request. Lease checks guard task writes and persisted outcomes. Credential origin/path/workspace binding, encryption, live revocation and response redaction remain enforced.
- OAuth token requests compose DNS and pinned HTTP Effects, with four permits and a twenty-second total deadline including admission. Single-flight refreshes are deliberately awaited through encrypted-token persistence: interruption must not discard a newly rotated token or release a refresh lock early. Refresh persistence participates in the SQLite worker-state serialization.
- Graph email, linear email and password-reset delivery share a two-permit SMTP Effect and a fifteen-second deadline including admission. Acquisition/release owns an abort controller, sockets and transport. Nodemailer's transport `close()` alone does not stop active SMTP delivery, so cleanup also aborts/destroys the actual socket, including connection establishment and TLS upgrades. Success, failure, timeout and interruption all release the resources. Native SMTP errors are sanitized.

## Other reviewed boundaries

- Agent provider fetches now combine Effect interruption, browser disconnect and the existing 45-second deadline. Admission increments before the awaited context query, closing a race that could exceed four requests. Existing bounded response reading and live permission rechecks remain in place.
- Origin middleware now represents expected security rejection in the failure channel instead of a Promise defect.
- OIDC's outer deadline uses the native v4 API and retains openid-client's configured per-request timeout. Actual upstream exchanges remain owned by openid-client; Effect interruption of this existing SDK Promise does not itself abort that SDK operation. Shared discovery/configuration is not mutated per caller.
- Live SQL already uses the shared failure bridge, request-owned clients, driver deadlines and `finally` cleanup; no blanket Effect timeout/retry was added around external SQL writes. Core pure validation, OpenAPI construction and bulk admission only needed native API migration.
- The coordinated image/appearance work owns storage and logo boundaries, including the storage collector's database-error accounting and logo lookup's expected failure channel.

## Verification boundaries

Risk-based API regressions cover v4 failure/defect identity and cancellation cleanup; invalid-header failure isolation; DNS cancellation; real local SMTP socket interruption, permit reuse and delivery; bounded worker claims; a database acknowledgment failure after remote acceptance; sibling-run completion; and non-replay of expired linear/webhook leases. Existing automation tests retain immutable versioning, graph branch selection, lease loss, permission denial, credential secrecy, OAuth one-use state, request bounds and re-entry protection.

Focused pinned-Node-24 verification passes: API typecheck and 54 tests across `automations`, `automation-transport`, `core`, `accounts`, `sso`, `agent-lifecycle` and `http`. This includes the actual 45-second agent deadline. An additional disposable local implicit-TLS SMTP fixture verifies cleanup after a completed TLS handshake and subsequent successful delivery; its self-signed certificate used fixture-only trust bypass, and the generated key/certificate were removed. `npm ls effect --all` resolves only 4.0.0; installation reports zero audit vulnerabilities; `git diff --check` passes. Initial automation runs exposed the SQLite worker-state locking defect described above, repaired before the passing rerun.

Final integrated verification on 2026-10-02 passes the complete pinned-Node24 `npm run check`: all API/web/operator typechecks, 125 API tests, 73 web units, eight initializer tests and both production builds. The stream regression passes its real deadline and complete 42,707,557-byte/800-item workspace snapshot. Compose configuration and staged whitespace checks pass; the existing Vite large-chunk advisory remains.

No browser/Playwright runs are part of this workflow verification. Real external SMTP/TLS deployments, OAuth/OIDC providers, PostgreSQL automation-worker execution, DNS infrastructure failure modes and process-kill recovery have not been independently verified here. Local HTTP/SMTP fixtures and simulated stale leases are evidence for the covered paths, not a production-readiness claim.

## Official references

- [npm stable distribution tags](https://registry.npmjs.org/-/package/effect/dist-tags) and [4.0.0 metadata](https://registry.npmjs.org/effect/4.0.0).
- [Effect 4.0 announcement](https://effect.website/blog/releases/effect/40/).
- [Official migration guide](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md), [error-handling changes](https://github.com/Effect-TS/effect/blob/main/migration/error-handling.md), and [flat Cause representation](https://github.com/Effect-TS/effect/blob/main/migration/cause.md).
- Installed release declarations/source in `node_modules/effect/dist` and `node_modules/effect/src` were used to verify the actual v4 `callback`, `timeoutOrElse`, resource-finalizer, semaphore and Cause APIs.
