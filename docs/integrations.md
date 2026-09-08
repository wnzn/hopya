# Optional Integrations

The application works with local authentication and filesystem storage without AI, S3, SSO, telemetry, or a vendor account. Optional integrations must be tested with the operator's selected provider before production use.

## AI Assistant

Operator settings belong only in the API environment. Set `AI_PROVIDER`, `AI_MODEL`, and optionally `AI_BASE_URL`/`AI_API_KEY`. An empty provider disables the assistant.

`AI_MAX_OUTPUT_TOKENS` sets an integer budget from 256 to 32768 (default 2048). Native OpenAI requests use `max_completion_tokens`, including reasoning tokens, and explicitly set `store:false`. Compatible endpoints and Anthropic use `max_tokens`; Google uses `generationConfig.maxOutputTokens`. Increase the budget deliberately for reasoning models that exhaust it before answering; it can increase cost. The response-size and timeout bounds still apply. This follows the [official OpenAI SDK parameter documentation](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts), which deprecates `max_tokens` and marks it incompatible with o-series models. `store:false` does not claim zero provider-side retention; review the provider's policy.

| Provider | Default base URL | Requests |
| --- | --- | --- |
| `openai` | `https://api.openai.com/v1` | `/chat/completions`, bearer key |
| `anthropic` | `https://api.anthropic.com/v1` | `/messages`, `x-api-key` |
| `google` | `https://generativelanguage.googleapis.com/v1beta` | `/models/{model}:generateContent`, `x-goog-api-key` |
| `openai-compatible` | Required operator-supplied base | `/chat/completions`; optional bearer key for local servers |

Base URLs include the API version prefix, not the final method path. For example, a local llama.cpp/vLLM/Ollama-compatible endpoint is typically `http://model-server:8000/v1` or `http://ollama:11434/v1`; verify your server's actual API. Groq, Mistral, DeepSeek and other compatible services can use their documented versioned base URL and model name. Compatibility depends on the selected endpoint/model accepting Chat Completions and producing the required JSON. No specific hosted model/version is guaranteed. Private HTTP is allowed for trusted local model networks; use HTTPS for remote credentials. Redirects are rejected, and ordinary users/models cannot choose outbound URLs.

`POST /api/v1/workspaces/:wid/agent` accepts only `{message}` (1-8000 characters). It requires `agent:use` and `items:read`, sends the message plus up to 100 recent task titles/statuses/priorities/dates and 100 list names/IDs. It does not send member emails, task descriptions, attachments, provider keys or other workspaces. The assistant is single-turn; the displayed conversation is browser-memory history, not a stored chat or an automatically resent transcript.

These context bounds are enforced in SQL using lightweight columns, not by loading all tasks and discarding most of them. The target list and current permissions are checked again after the provider returns.

Output is `{reply,proposal?}`. Proposal fields are `title`, optional `description`, `nodeId`, `dueDate`, `priority`. Model JSON is bounded and validated, and list references and current authentication/permissions are rechecked after the request. Provider timeout is 45 seconds with four concurrent requests maximum. Unusable output returns a safe error, not a silently executed action. Only an action/outcome flag is audited, not the prompt/answer text.

Closing the assistant or switching workspace aborts the pending browser request. When Adonis detects a client disconnect, it cancels the provider HTTP request/body and releases its local slot; normal POST-body completion is not treated as a disconnect. The 45-second deadline covers both waiting for response headers and reading the body. Busy requests return `429` with `Retry-After: 1`; provider timeout/failure returns sanitized `502` and does not record a successful answer. These lifecycle and revocation cases are exercised with controlled real-HTTP providers, not simulated clocks.

Cancellation cannot retract context already sent upstream or guarantee that a provider stops generation or billing. Proxies must propagate disconnects to Adonis. Credential/permission revocation prevents answer delivery and auditing after the provider wait; it does not immediately stop remote processing. Verify these boundaries with your selected proxy/provider rather than assuming a cloud cancellation guarantee.

**No agent endpoint mutates tasks.** The UI opens a review dialog, permits editing and requires **Confirm and create**. That ordinary REST creation revalidates all values and current permissions. The assistant cannot delete tasks, run shell commands, browse arbitrary URLs or change permissions. Treat advice as untrusted, including task-content prompt injection. Review the provider's privacy, retention and cost policies before enabling it.

## MCP

Hopya uses the official TypeScript MCP SDK v1 and stdio. It is a separate process that forwards to REST with `HOPYA_API_URL` (origin only) and `HOPYA_API_TOKEN`. It never opens the database or another unauthenticated listener. See [README configuration](../README.md#api-and-mcp).

Default tools: `list_workspaces`, `get_workspace`, `list_items`, `get_item`. Mutation tools `create_item`, `update_item`, `delete_item` appear only with `HOPYA_MCP_ALLOW_WRITES=true`. That is operator permission to expose tools, **not per-action human consent**. The host must enforce its own human-approval policy. Keep writes disabled for hosts that cannot do so. Tool annotations are hints, not security enforcement. All REST RBAC, validation, version conditions and token revocation remain authoritative.

`list_items` returns one `{items,nextCursor}` page, with optional `limit` (1-500, default 200) and `cursor` alongside its existing filters. Follow non-null cursors with the same filters; do not treat the first page as all tasks. Responses are limited to 4 MiB of incoming UTF-8 bytes and reading is cancelled immediately when that limit is exceeded. Large individual records or metadata may require the REST API even at a one-item page size. This bounds response buffering, not total process memory or the MCP host's model context.

Use a dedicated account with only required workspace memberships. Tokens currently inherit all that account's permissions rather than taking separate scopes. To avoid stale updates, pass `expectedUpdatedAt` to `update_item`. Keep tokens in the MCP client's private environment, not arguments or source control. Run `node apps/api/build/bin/mcp.js` after `npm ci` and building the API. Do not wrap it with commands that print non-protocol text to stdout.

## OIDC

Hopya accepts a [compatible OpenID Connect provider](oidc-setup.md). Identity-provider deployment, recovery, MFA, and lifecycle policies remain the operator's responsibility.

Configure `OIDC_ISSUER` with the exact issuer URL (not the discovery document), `OIDC_CLIENT_ID` and the provider-required `OIDC_CLIENT_SECRET`. Register `${APP_URL}/api/v1/auth/sso/callback` for Authorization Code flow. Current client-secret authentication follows openid-client's default `client_secret_post`; verify the IdP supports it. Use HTTPS for the app, issuer and provider endpoints.

Routes: `GET /api/v1/auth/sso`, then `/api/v1/auth/sso/callback`. Flows use PKCE S256, random state/nonce, hashed browser-bound cookie/state, ten-minute expiry and one-use consumption. ID token signatures/issuer/audience are verified by openid-client. Redirect hosts are not accepted from request data. Tokens/claims are not persisted or logged.

Local admin setup must happen first. `OIDC_AUTO_PROVISION=false` is the default. In `/admin`, **OIDC identities** lets an administrator select an account, inspect linked identities and explicitly link verified issuer/subject values. REST uses `GET|POST /api/v1/admin/oidc-identities` and `DELETE /api/v1/admin/oidc-identities/:id`. A matching email alone never links accounts. Unlinking revokes all target sessions/tokens and blocks matching in-flight exchanges; the last passwordless sign-in method is protected. A fresh JIT enrollment may still create a different non-admin account if its verified email is new, so unlinking is not an upstream ban.

With `OIDC_AUTO_PROVISION=true`, only verified, valid, non-colliding email claims can create a new non-admin account. New users receive no existing workspace membership. Local registration remains independently controlled. Existing linked identities use `(issuer,subject)` regardless of email changes; account suspension still blocks them. Local logout does not promise IdP-wide logout.

`OIDC_ALLOW_INSECURE_HTTP=true` is solely for loopback development tests and is rejected in production. Do not use it as a workaround for public HTTPS configuration.

## Attachments

`STORAGE_DRIVER=filesystem` stores opaque objects under `DATA_DIR/objects` with private permissions. `s3` uses the AWS SDK's default credential chain and requires `S3_BUCKET`, `S3_REGION`, optionally `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE`. The bucket must exist and be private. Use a dedicated bucket and credentials limited to object get/put/delete; no public ACL is set. S3 HTTP can be used on a trusted local storage network; remote storage should enforce TLS. Some SDK operations, including conditional writes, may vary across S3-compatible products and need real-service verification.

Paths are `/api/v1/workspaces/:wid/items/:id/attachments`:

- GET lists `{id,name,size,contentType,createdAt}` metadata.
- POST accepts `{name,contentType,data}` where `data` is canonical base64 and decoded content is at most 10 MiB. Requires task write/read access. JSON transport has a 15 MiB bound; proxy accepts 20 MiB.
- GET `/:attachmentId` downloads authorized private bytes with forced attachment disposition and `nosniff`, not inline HTML.
- DELETE `/:attachmentId` revokes metadata access transactionally; physical failures return `cleanupPending:true` and remain tracked for cleanup.

Authorization is rechecked after storage waits. Filenames never become filesystem paths or object keys. Upload failures are compensated; a durable object ledger tracks uncertain remote writes and deleted-item objects. The single API replica runs a bounded hourly cleanup for unreferenced objects older than 24 hours (up to 100 per run). Admin status exposes the pending count. Failed objects retry later; monitor the backlog and provider configuration.

Changing the storage driver/bucket/endpoint is **not a migration**. Objects record a backend fingerprint and do not silently fall back to another location. Preserve old settings and transfer/verify objects before changing metadata. S3 versions require their own lifecycle/backup policy; deleting a current object does not necessarily erase old versions. Workspace export includes attachment metadata but not bytes or storage keys. See [backup/restore](deployment.md#backup-and-restore).

## Verification Boundaries

| Integration | Application boundary | Operator verification |
| --- | --- | --- |
| Filesystem | Private object keys, permission checks, bounded uploads, deletion ledger, and garbage collection | Host disk monitoring, backup restoration, and sustained workload |
| S3 | Signed private requests, bounded payloads, permission rechecks, and tracked cleanup | Provider compatibility, bucket policy, versions, lifecycle, and remote restore |
| OIDC | PKCE/state/nonce validation, issuer-subject identity binding, and local revocation | Provider access policy, MFA, recovery, logout, and deprovisioning |
| AI | Bounded context/output, provider timeouts, permission rechecks, and proposal-only behavior | Model behavior, retention, cost, regional policy, and cancellation behavior |
| MCP | Authenticated REST forwarding, read-only defaults, and optional mutation exposure | MCP host security and human approval for every write |
