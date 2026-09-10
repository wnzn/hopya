# REST API

The base path is `/api/v1`. Successful responses are direct JSON arrays or objects. Failures use `{ "error": "message" }`. Resource identifiers are UUIDs; configurable status IDs are bounded safe strings. Date-only values use `YYYY-MM-DD`; server timestamps use UTC ISO-8601. Unknown mutation fields are rejected. See [architecture](architecture.md) for the complete endpoint inventory and [integrations](integrations.md) for attachments, OIDC, AI and MCP.

`GET /mcp/sse` opens the administrator-enabled MCP SSE stream; `POST /mcp/messages?sessionId=...` carries client messages. Both require a personal token in the `Authorization: Bearer` header and reject cookie-only authentication. The endpoint returns 404 while disabled. Sessions are user-bound, expire after 30 minutes, and are limited to four per user and 32 per instance. MCP payloads use the MCP protocol rather than the ordinary REST response envelope.

## Authentication

Create a personal token in Settings after signing in. It is revealed once, hashed at rest, expires after 90 days and can be revoked immediately. Tokens inherit their account's current workspace permissions; there are no independent per-token scopes. Use a dedicated restricted account for automation. Do not expose tokens in URLs, client code, shell history or logs.

```sh
curl --fail-with-body "$HOPYA_URL/api/v1/workspaces" \
  -H "Authorization: Bearer $HOPYA_API_TOKEN"
```

The example assumes secret variables supplied privately in your environment. Browser login uses HttpOnly cookies. Every unsafe browser request, including login and setup, must carry an `Origin` exactly matching `APP_URL`. Origin-less mutations require a valid bearer and no cookies. An explicit foreign Origin is rejected even with a valid bearer. No permissive CORS is enabled, except the dev-only `ALLOW_ANY_ORIGIN=true` escape hatch (echoes any requesting origin with credentials, answers preflights, logs a startup warning; never enable on a reachable instance).

| Method and path | Input / result |
| --- | --- |
| `GET /config` | Public feature booleans and `setupRequired`; no secrets |
| `POST /auth/setup` | `{name,email,password,setupToken}`; first operator-authorized admin only |
| `POST /auth/register` | `{name,email,password}`; only when enabled after setup |
| `POST /auth/login` | `{email,password}`; session cookie plus public user |
| `POST /auth/forgot-password` | `{email}`; generic accepted response, with email delivery when configured |
| `POST /auth/reset-password` | `{token,password}`; consume one-use link and revoke all credentials |
| `GET /auth/me` | `{id,name,email,isAdmin}` |
| `POST /auth/logout` | Revoke current browser session |
| `PATCH /auth/profile` | `{name,email?,password?,currentPassword?}`; current password required for email/password changes; prior credentials revoked |
| `GET /auth/tokens` | Token metadata only |
| `POST /auth/tokens` | `{name}`; raw token once |
| `DELETE /auth/tokens/:id` | Revoke caller-owned token |

Passwords are 12-256 characters when set. Sessions last seven days and are capped at 20 per account; active tokens are capped at 50. Login permits 10 requests per normalized account/IP and 100 total requests per verified IP per 15 minutes, including invalid attempts. Password-reset requests are limited by verified IP and normalized email, return the same response for existing and missing accounts, and issue only hashed 30-minute single-use tokens. Login address windows are separately bounded to 1,000; other authentication categories retain a 10,000-window cap. `429` includes `Retry-After`; see the [limiter boundaries](security.md#authentication). Profile credential changes revalidate the current credential after hashing and fail with `401` if it expired or was revoked before commit.

## Workspaces And Hierarchy

| Method and path | Input / result |
| --- | --- |
| `GET /workspaces` | Membership-scoped workspace array |
| `POST /workspaces` | `{name}`; creates workspace plus Owner, Member and Viewer roles |
| `GET /workspaces/:wid` | `{workspace,role,permissions,members,roles,nodes,documents,documentPages,fields,projectFields,listStatusConfigs}` |
| `PATCH /workspaces/:wid` | `{name}`; requires `workspace:manage` |
| `DELETE /workspaces/:wid` | Owner-only permanent deletion of the workspace and relational contents |
| `GET /workspaces/:wid/nodes` | Hierarchy node array |
| `POST /workspaces/:wid/nodes` | `{name,kind,parentId?,description?}`; kind `project`, `folder`, `list`; description is project-only |
| `PATCH /workspaces/:wid/nodes/:id` | `{name?,description?,parentId?,expectedParentId?}`; rename, edit a project description or move a folder/list within its workspace |
| `DELETE /workspaces/:wid/nodes/:id` | Empty nodes only; `409` if child nodes/documents/tasks remain |
| `GET /workspaces/:wid/lists/:listId/statuses` | `{listId,statuses?,updatedAt,inheritedProjectUpdatedAt?}`; present array is explicit, omission inherits from a project |
| `PATCH /workspaces/:wid/lists/:listId/statuses` | `{statuses: array|null,expectedUpdatedAt?,expectedProjectUpdatedAt?}`; replace explicit statuses or restore project inheritance |
| `GET /workspaces/:wid/views/list/settings` | Authenticated user's settings; optional `projectId` query, omitted for all projects |
| `PATCH /workspaces/:wid/views/list/settings` | Replace authenticated user's settings with optimistic concurrency |
| `GET /workspaces/:wid/export` | Version 5 JSON with workspace hierarchy, attributed documents/pages, tasks, comments, reactions, fields and attachment metadata |

Projects and standalone lists may be workspace roots. Folders require a project/folder parent; nested lists may use either. Lists contain tasks, not hierarchy nodes. Folder depth is bounded at 32. Names are bounded at 120 characters. Structure mutations require `structure:write`. Export is portable data, not a backup/import format; it excludes credentials, audit history and attachment bytes. Workspace deletion requires the protected Owner role, is permanent, and includes tasks, hierarchy, memberships, roles, fields and automation records. Export needed data first.

Node responses include `description` (default empty string) plus nullable `icon` and `color` catalog IDs. Only project POST/PATCH accepts description, bounded to 50,000 characters; empty string clears it. Folder/list descriptions remain empty. Icons are `diamond|briefcase|target|folder|archive|bookmark|list|checklist|calendar|flag`; colors are `slate|orange|amber|green|teal|blue|violet|rose`. Null restores the kind/default appearance. On a cross-project hierarchy move, each inherited descendant list must be valid under the destination project's statuses. Overridden lists retain their effective statuses and do not block the move based on project defaults. Moving an inheriting list to root materializes its current statuses; moving a standalone list into a project preserves its statuses as an override. No move remaps task statuses.

Moves preserve node IDs, child relationships, tasks and attachments. Projects cannot be moved under another node; self/descendant/list parents, foreign workspace IDs and moves pushing any descendant past depth 32 are rejected. Send the original `parentId` as `expectedParentId` when moving to reject stale placement with `409`; a condition requires a `parentId` mutation. Rename-only PATCHes preserve the current parent. No empty or unknown-field mutation is accepted. Move/rename plus audit commit in the same transaction.

Workspace bootstrap is permission-filtered so management-only roles can use Settings without reading tasks. Every active member can read the workspace name and their own role/permissions. Hierarchy metadata is returned with task, document, or structure access; document page links additionally require task and document read access. Field definitions require task read or structure write; the member directory requires task read or member management; the full role catalog requires task read, member management, or role management. Other arrays are empty (the role list retains the caller's own role). This never grants task-body, document-body, or export access.

## Documents

Documents are structural leaves at workspace root or beneath a project/folder. `GET|POST /workspaces/:wid/documents` lists metadata or creates `{title,body?,parentId?}`. `GET|PATCH|DELETE /workspaces/:wid/documents/:id` reads, conditionally updates, or deletes one document. PATCH requires `documents:read`, `documents:write`, at least one mutable field, and the exact `expectedUpdatedAt`; DELETE requires `documents:delete`. Titles are 1-300 characters and Markdown bodies are at most 50,000 characters. Deleting a document also deletes its nested document-page subtree and removes page links, while preserving every linked task and task subtask.

`GET|POST /workspaces/:wid/documents/:id/pages` lists a bounded virtual page tree or links `{itemId,position?}`. Only an active top-level task can be linked, and one task can belong to at most one document. Its ordinary subtasks appear as nested pages. Listing requires document/task read access and returns `{items,total,truncated}` with at most 500 rendered tasks; totals remain complete. `DELETE /workspaces/:wid/documents/:id/pages/:itemId` requires document write and task read access and unlinks without deleting the task. A linked root task cannot become a subtask until unlinked.

`GET|POST /workspaces/:wid/documents/:id/subpages` lists document-backed pages in the containing root document or creates one with `{title,placement?}`. Placement `page` is accepted only on the root document and creates a top-level Pages-rail entry; the default `subpage` creates beneath the addressed document/page up to the 31-level limit. GET works from either the root or one of its pages and returns `{rootId,documents,total,truncated}` with at most 500 complete summaries, including each entry's `pagePlacement`. Document-backed pages use document permissions and open through the normal document editor.

## Tasks

Prefer `GET /workspaces/:wid/items/page` for interactive/programmatic reads. It accepts optional `nodeId`, `search`, `status`, `archived`, `limit` and `cursor`. `archived` is `exclude` (default), `include`, or `only`. Search matches literal title/description substrings. `limit` is an integer from 1 to 500, default 200. The result is `{items: [...], nextCursor: string | null}`.

Follow a non-null `nextCursor` unchanged with the same workspace and filters until it becomes null. A page may contain fewer than `limit` items because the encoded page budget is 2 MiB; do not infer completion from row count. One schema-validated item may exceed that soft budget so it can be returned whole; any encoded stored record above 8 MiB fails rather than truncates. Cursors are canonical position descriptors bound to workspace/filter values, not authentication credentials. You may change the page size between calls, but changing filters requires starting without a cursor.

```sh
curl --fail-with-body --get "$HOPYA_URL/api/v1/workspaces/$WORKSPACE_ID/items/page" \
  -H "Authorization: Bearer $HOPYA_API_TOKEN" \
  --data-urlencode "limit=200"
```

For a subsequent page, also pass `--data-urlencode "cursor=$NEXT_CURSOR"` after taking the non-null value from the previous response. Each request checks current permissions. The `(createdAt,id)` seek avoids offset drift if an earlier item is deleted; multiple pages are not a frozen snapshot across concurrent changes. Use a complete bulk stream when you need one consistent dataset snapshot.

`GET /workspaces/:wid/items` retains the existing complete JSON-array response and `nodeId`, `search`, `status`, `archived` filters. It streams a consistent read snapshot on SQLite or PostgreSQL. `/workspaces/:wid/export` likewise streams the complete versioned workspace document and always includes archives. Neither silently limits rows. At most eight bulk reads globally and two per account may run at once; excess requests receive `429` with `Retry-After: 1`. Snapshots expire after 30 seconds and are released on cancellation, finish or error. HEAD validates access but holds no stream slot.

Streams recheck authentication and task-read permission before each chunk. Errors detected before headers return sanitized JSON; revocation, timeout or corruption after headers aborts the connection. Treat an interrupted download as failed, not as an importable partial export. Already delivered bytes cannot be recalled. Settings downloads stream directly through the browser rather than buffering and reserializing exports in JavaScript.

`POST /workspaces/:wid/items` requires `title` and `nodeId` (a list). Example body:

```json
{
  "nodeId": "11111111-1111-4111-8111-111111111111",
  "title": "Rehearse backup recovery",
  "description": "Verify restored attachments and membership.",
  "status": "todo",
  "priority": "high",
  "startDate": "2026-09-07",
  "dueDate": "2026-09-10",
  "tags": ["operations"],
  "assigneeId": null,
  "checklist": [{"text": "Verify task data", "done": false}],
  "parentId": null,
  "customFields": {}
}
```

`GET`, `PATCH` and `DELETE /workspaces/:wid/items/:id` address a single workspace-scoped task. PATCH preserves omitted fields. Null clears nullable dates, assignee, or parent; empty string clears description. Status must match an ID in the destination list's effective configuration on create, update and move. An explicit list workflow is effective; otherwise the root project's configuration is effective. Standalone lists always define explicit statuses. Omitted create status defaults to the first effective status. Priority: `none`, `low`, `medium`, `high`, `urgent`. Title is 1-300 characters, description at most 50,000, tags at most 30 distinct values of 1-60 characters. A checklist has at most 100 entries with server-normalized IDs and 1-200 character text. `parentId` must identify another task in the same workspace and cannot create a cycle or exceed the subtask-depth limit. Start cannot follow due date. The assignee must be an active workspace member.

Responses add `id`, `workspaceId`, `archivedAt`, `createdAt` and `updatedAt`. Server-generated identity/timestamps and archive state cannot be overwritten through ordinary task create/update. Updates require both `items:read` and `items:write`; deletion requires `items:delete`.

`POST /workspaces/:wid/items/bulk` atomically archives or permanently deletes 1-100 selected tasks. Every entry requires the exact current task revision. A parent may be archived or deleted only when all descendants are selected; any missing, foreign, stale, duplicate, or incomplete target rejects the complete mutation. Archive requires `items:read` and `items:write`; delete requires `items:delete`.

### Discussion And Notifications

`GET /workspaces/:wid/items/:id/comments` returns the complete task discussion in creation order with `parentId`, optional `anchor`, and grouped `{emoji,count,reactedByMe}` reactions. `POST` accepts `{body,parentId?,anchor?}`; bodies are Markdown from 1-10,000 characters, replies stay on the same task, and reply depth is limited to 32. Reading requires `items:read`; posting and reacting require `items:read` plus `comments:create`.

Document discussion uses the equivalent routes under `/workspaces/:wid/documents/:id/comments` and requires `documents:read`; posting and reacting additionally require `comments:create`. An optional root-comment anchor is `{revision,start,end,exact,prefix,suffix}` using UTF-16 offsets over the saved Markdown body or task description. The server rejects stale/nonmatching selections. Body edits use quote context to relocate an unambiguous range; deleted or ambiguous text leaves an `orphaned` anchor and retained quote rather than deleting the thread. Replies inherit their root thread's range and cannot provide another anchor.

`DELETE /workspaces/:wid/items/:id/comments/:commentId` first replaces the body with a tombstone so replies and deep links remain stable. The author may delete their own entry; delegated moderators need `comments:manage`. A member with `comments:manage` may call DELETE again to permanently remove the tombstone; its direct replies remain and are reattached to the removed entry's parent. `PATCH .../comments/:commentId/reaction` accepts `{emoji,active}` using `👍`, `❤️`, `😂`, `🎉`, `😕`, or `👀`. Each member can hold one of each reaction per comment.

`GET /workspaces/:wid/notifications` returns up to 200 newest assignment and user-mention notifications owned by the authenticated member. `GET .../unread-count` returns `{unread}`; `PATCH .../notifications/:id` accepts `{read:boolean}`, and DELETE removes that owned row. User mentions are same-origin Markdown links generated by the editor and are accepted only for active members of the same workspace with `items:read`. A body/comment may mention at most 20 users, unchanged task mentions do not notify twice, and self-notifications are skipped. Task and structure links created with `@@` and `@@@` are navigation links, not notification recipients.

```json
{
  "action": "archive",
  "items": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "expectedUpdatedAt": "2026-09-08T10:00:00.000Z"
    }
  ]
}
```

### Concurrent Editing

Pass the exact `updatedAt` from your last read as `expectedUpdatedAt` on PATCH:

```json
{
  "status": "done",
  "expectedUpdatedAt": "2026-09-06T12:00:00.000Z"
}
```

A changed task returns `409` without modification or a mutation audit. Refresh, reconcile with the human's intended change and retry using the new version. The browser always sends this condition and only changed fields. REST/MCP clients that omit it explicitly accept last-write-wins behavior. It is not valid on creation.

## Fields And Access

Custom field definitions use `GET|POST /workspaces/:wid/fields` and `PATCH|DELETE /workspaces/:wid/fields/:id`. Creation accepts `{name,type,options?,settings?,projectId?}`; types are `text`, `number`, `date`, `datetime`, `checkbox`, `select`, `checklist`, `rating`, `formula`. Optional projectId atomically adds the created definition to that project; omitted projectId creates only a reusable workspace catalog entry. Task `customFields` maps field UUIDs to typed values or null; PATCH replaces the map, so clients must preserve unrelated entries and send expectedUpdatedAt. Unknown fields and wrong types are rejected. Destructive field deletion uses indexed single-row value/version reads, removes assignments, and advances affected task/configuration versions; `field.delete` audit details include the exact touched-task count. Audit failure rolls back the complete operation.

Field definitions return `{id,workspaceId,name,type,options,settings?}`. `select` remains the dropdown type. Select and checklist definitions require 1-100 unique options, each a trimmed nonempty string of at most 120 characters; other types accept only empty options. Checklist values are arrays of unique selected option strings (including `[]`); rating values are integers from 1 through `settings.maxRating` (default 5). `maxRating` is an integer from 1 through 10. All field types permit null. Datetime values are valid ISO timestamps of at most 64 characters with `Z` or an explicit offset, preserved as supplied; dates remain calendar-valid `YYYY-MM-DD` strings.

`settings?: {dateFormat?,maxRating?,formula?}` is strict: dateFormat applies only to date/datetime fields, maxRating only to rating fields, and formula only to formula fields. New formula fields define one nonempty expression of at most 200 characters at creation (`=0` is the browser starter); references use `{{Field name}}`, are trimmed and must resolve inside the workspace. Calculated values are read-only on tasks. Legacy formula definitions without `settings.formula` retain their per-task expression behavior until deliberately configured. Renaming or deleting a referenced field is rejected until shared formulas are updated. Date formats are `yyyy-MM-dd`, `MMM d, yyyy`, `MMMM d, yyyy`, `dd/MM/yyyy`; they affect presentation, never stored date values. Field PATCH requires `structure:write` and at least one of `{name?,options?,settings?}`. Type and projectId cannot be patched. Supplied options/settings replace that property, omitted properties are retained, and `{settings:{}}` restores defaults. Changes that invalidate any existing value, including retained unassigned values, return 409 without mutation. Validation scans one task map at a time. Field updates and safe audit metadata commit atomically; task values/versions and project assignment revisions are unchanged. This endpoint uses last-write-wins semantics.

`GET|PATCH /workspaces/:wid/projects/:projectId/fields` manages a root project's or standalone root list's field-owner configuration; the historical route and `projectId` response key are retained. GET returns `{projectId,fieldIds,builtInFields,statuses,dateFormat?,updatedAt}`. PATCH accepts `{fieldIds?,builtInFields?,statuses?,dateFormat?,expectedUpdatedAt?}` with at least one configuration property; null dateFormat restores the default. Standalone status mutations use `/lists/:listId/statuses`, not this route, and current standalone statuses are reflected in GET/detail/export responses. Arrays must contain unique allowed values; fieldIds must belong to the workspace (maximum 100). Built-ins are `priority`, `startDate`, `tags`, `description`, `nodeId`, `createdAt`, `updatedAt`. Optional dateFormat uses the same enum for built-in date presentation (absent means ISO display). GET requires membership plus items:read or structure:write; PATCH requires structure:write. A stale revision returns 409. Workspace detail and both exports include every root field-owner configuration in `projectFields`. Unassigning is not deletion: task values and versions remain intact. Assignments organize display, not REST/MCP access permissions.

`statuses` is an ordered array of 1-50 strict `{id:string,name:string,color:string,completed:boolean}` objects. IDs are unique, 1-64 characters matching `^[A-Za-z0-9][A-Za-z0-9_-]*$`; names are trimmed, 1-120 characters; colors are six-digit `#RRGGBB` hex strings. PATCH replaces the array, allowing add, reorder, rename, color/completion edits and removal. Removing an ID still used in an inheriting list under that project returns 409. Renaming an ID is removal plus addition, not a task rewrite. Completion is configured explicitly, not inferred from the ID. Legacy projects retain all five persisted IDs (`todo`, `backlog`, `in_progress`, `review`, `done`); migration 006 and new projects use that order with todo first to preserve the prior default, and only done initially completed. Custom status IDs also work in page, bulk and MCP filters, with unchanged cursor binding and authorization.

List status configuration reuses that exact status schema. `GET /workspaces/:wid/lists/:listId/statuses` returns the stored configuration, not a materialized effective copy: omitted `statuses` means inheritance. `inheritedProjectUpdatedAt` is always present and is the current owning project's configuration revision, including when the list already has an override. `PATCH` requires `statuses`; send an array to add or replace the override or `null` to inherit. `expectedUpdatedAt`, when supplied, must exactly match the returned list revision or the request returns `409`.

`GET|PATCH /workspaces/:wid/lists/:listId/tag-colors` manages presentation colors independently for each list. GET returns `{listId,colors,updatedAt}`. PATCH strictly replaces `{colors,expectedUpdatedAt}`; colors maps up to 30 exact non-empty tag names (maximum 60 characters) to six-digit hex colors. The revision is required and stale writes return `409`. Reads require structure visibility; writes require `structure:write`. This configuration does not create, rename, or delete task tags.

When the stored configuration is inherited and PATCH enables an override array, `expectedProjectUpdatedAt` is required and must equal the current owning project's `inheritedProjectUpdatedAt`; omission returns `400` and a mismatch returns `409`. The owning project is resolved from current ancestry inside the mutation transaction, so a concurrent project status change or list reparent cannot enable an override from a stale inherited view. Changing an existing override or restoring inheritance needs only the list revision; `expectedProjectUpdatedAt` is accepted but does not add another conflict condition for those transitions. Every list has a row from creation or migration, so first-write concurrency has the same semantics as later writes. GET requires membership plus `items:read` or `structure:write`; PATCH requires `structure:write`. The mutation and safe `list.statuses.update` audit are one transaction. An override change or removal that would invalidate a task already in that list returns `409`; task rows are never rewritten.

Project status PATCH retains its existing request/response shape and concurrency contract. Its removal check covers only tasks in lists currently inheriting from that project. Tasks in overridden lists use their override and do not block project status changes.

List-view settings return `{view:"list",projectId:string|null,columnOrder:string[],hiddenColumns:string[],sort:{column,direction}|null,updatedAt:string|null}`. GET uses an optional UUID `projectId` query and returns current scope defaults with `updatedAt:null` before the first save. PATCH is a strict full replacement: `{projectId?:string|null,columnOrder,hiddenColumns,sort,expectedUpdatedAt}`. Send `expectedUpdatedAt:null` only to create; updates require the exact current timestamp and stale writes return `409`. Both methods require workspace membership plus `items:read`; viewers can manage only their own settings, while write-only members and outsiders cannot read or write them. Project scope must name a root project in the workspace.

Columns are unique and bounded to the always-available `title`, `status`, `assigneeId`, `dueDate`; optional built-ins `priority`, `startDate`, `tags`, `description`, `nodeId`, `createdAt`, `updatedAt`; and `custom:<UUID>`. Workspace-wide scope accepts any configured workspace custom field. A root-project or standalone-list scope accepts only custom fields assigned to that field owner. `title` must remain in `columnOrder` and cannot be hidden; hidden columns must occur in the order, and sort must name a non-hidden ordered column with direction `asc` or `desc`. The authenticated account is the storage identity; no client user ID is accepted. Mutations and count-only audits commit in one transaction, and removing the membership deletes its settings.

Formula values remain raw strings, at most 200 characters with 20 references. New/changed references use exact sibling custom-field names in `{{Name}}` and cannot refer to the formula itself. Quoted reference-looking text is literal. Removing an input field does not block unrelated edits to an unchanged saved formula. Display evaluation supports arithmetic, comparisons, quoted strings, and SUM/AVERAGE/MIN/MAX/ROUND/ABS/IF/CONCAT with bounded nesting and no JavaScript execution. Raw values are retained in REST and exports; missing references, malformed expressions and non-finite results display the raw expression rather than inventing a result. Referenced formula strings are not recursively evaluated.

Roles use `GET|POST /workspaces/:wid/roles` and `PATCH|DELETE /workspaces/:wid/roles/:id`, with `{name,permissions}`. Permissions are `items:read`, `items:write`, `items:delete`, `documents:read`, `documents:write`, `documents:delete`, `comments:create`, `comments:manage`, `structure:write`, `members:manage`, `roles:manage`, `workspace:manage`, `agent:use`. Owner is immutable and receives all permissions. Role managers cannot grant or manage privileges above their own; assigned roles cannot be deleted.

Membership creation is `POST /workspaces/:wid/members` with `{email,roleId}` for an existing active account. `PATCH /workspaces/:wid/members/:userId` changes `{roleId}`; DELETE removes a member and clears task assignments. Normal membership changes cannot remove the last active Owner. Site-admin security suspension is deliberately exempt and retains ownership for recovery.

## Site Administration

All `/admin/*` endpoints require `isAdmin`, not a workspace role. Site administration does not implicitly grant access to workspace task data.

- `GET|POST /admin/users`: list public user metadata including disabled state, or create `{name,email,password,isAdmin?}`.
- `PATCH /admin/users/:id`: set `{isAdmin?,disabled?}`. Disabling revokes credentials and clears assignments, even for sole workspace owners. The last active site administrator is protected.
- `GET /admin/audit`: optional `workspaceId`, `limit` (1-200, default 50), `offset` (default 0). Returns newest-first events. No password/token hashes, raw provider keys, task bodies or full AI prompts.
- `GET /admin/status`: counts, migration metadata, selected integration booleans, storage mode and pending object cleanup count; no provider credentials.
- `GET /admin/oidc-identities`: optional `userId` UUID filter; returns `{id,userId,issuer,subject,createdAt}` entries only. Unknown or malformed query parameters are rejected.
- `POST /admin/oidc-identities`: explicit `{userId,issuer,subject}` linking. See [SSO](integrations.md#oidc).
- `DELETE /admin/oidc-identities/:id`: unlink and atomically revoke every target session and API token, with safe audit counts. Returns `409` unless a passwordless account retains another identity for the exact configured issuer and SSO has a configured client. Inactive-issuer links do not count as recovery. Configuration must exactly match the discovery issuer, not merely normalize to the same URL. Self-unlink is permitted for password-backed admins but signs them out. Matching already-running callbacks cannot reinstate the identity/session. Unlink is not a permanent identity-provider ban: restrict JIT and/or disable the upstream identity when quarantining access.

## Integrations And Automations

All `/workspaces/:wid/webhooks` and `/automations` endpoints require `workspace:manage`. Workspace events are `item.created`, `item.updated`, `item.deleted`, `node.created`, `node.updated`, `node.deleted` and `field.changed`, emitted after mutation transactions commit. The user manual renders `GET /api/v1/openapi.json` at `/docs`.

- `GET|POST /workspaces/:wid/webhooks`: list `{id,name,url,events,enabled,createdAt,updatedAt}` (secrets never returned) or create `{name,url,events,enabled?}` (max 20 per workspace; URL must be http(s)). The creation and rotation responses return the signing secret once; rotate it with `POST /workspaces/:wid/webhooks/:id/rotate`.
- `PATCH|DELETE /workspaces/:wid/webhooks/:id`: update name, URL, events or enabled; delete. Audits record event names only.
- Enabled webhooks receive `POST` JSON `{event,workspaceId,itemId?,nodeId?,fieldId?,actorId?,changes?,item?,at}` with `x-hopya-signature: sha256=HMAC(secret, body)`.
- `GET|POST /workspaces/:wid/automations`: list or create `{name,event,steps,enabled?}` (max 50 per workspace). `steps` contains 1-20 ordered provider actions. The legacy singular `action` input remains accepted for existing clients, but cannot be combined with `steps`.
- `PATCH|DELETE /workspaces/:wid/automations/:id`: update or delete an automation.
- `GET /workspaces/:wid/automations/runs?limit=&automationId=&status=`: up to 100 recent durable runs, newest first. `GET /workspaces/:wid/automations/runs/:runId` returns one workspace-scoped run. Responses include bounded sanitized detail and ordered step records with `pending|running|delivered|failed|skipped` status, output/log and timestamps. `POST /workspaces/:wid/automations/:id/test` queues a real test run and returns its ID.
- Automation step providers (validated at save time): `webhook` (`{url,method?}` posts event JSON), `email` (`{to,subject}`; requires operator `SMTP_URL` and an available mail adapter), `http` (`{url,method?,headers?,body?}` supporting `{{event}}`; defaults to event JSON), and non-mutating `log` (`{message}`). Later step strings may reference bounded output from an earlier step with `{{steps.1.output}}`; forward/self references are rejected. HTTP/webhook response bodies are read only to the output cap. Header maps, event snapshots, output, logs, time, concurrency, run retention, and URLs are bounded. Runs enqueue in the triggering transaction, survive restarts, execute sequentially, and skip remaining steps after failure without rolling back the triggering user mutation.

## Task Import And Export

Task transfer uses `POST /workspaces/:wid/items/import` (requires `items:write`) and `GET /workspaces/:wid/items/export` (requires `items:read`).

- Import body `{nodeId,format,data}` (strict; `format` is `json` or `csv`; `data` at most 1,000,000 characters) targets one list. At most 500 rows per request. JSON data must be an array of row objects; CSV data needs a header row containing `title`. Shared columns: `title*` (1-300), `description`, `status` (status id or exact name against the destination list), `priority`, `startDate`/`dueDate` (`YYYY-MM-DD`, start not after due), `tags` (`;`-separated, trimmed, deduplicated, at most 30 of at most 60 characters), `assignee` (email of an active member), and `custom:<ExactFieldName>` (or a `customFields` object for JSON). CSV strings coerce strictly (finite numbers, true/false/yes/no/1/0 checkboxes, integer ratings within range, `;`-split checklists). Failures are `400 Row N: reason`; validation runs fully before any write, so imports are all-or-nothing in one transaction with a single count-only audit entry. Success is `201 {imported,ids}`.
- Export accepts `format=json|csv` with optional `nodeId` (any node, expanded to descendant lists), `status` (exact id), `search` (literal substring over title/description) and `limit` (default 1000, max 5000), ordered by creation. JSON returns API-shape items; CSV uses `id,title,description,status,priority,startDate,dueDate,tags,assigneeEmail,nodeId,nodePath,createdAt,updatedAt` plus `custom:<FieldName>` columns (union, capped at 50) with `;`-joined lists and empty nulls. Responses carry `Content-Disposition: attachment` and `text/csv` or `application/json`.

## Site Settings

- `GET /site/settings` and `PATCH /site/settings` (site admin): read or toggle `landingDisabled` and `mcpSseEnabled`; GET also reports whether the operator set `LANDING_ENABLED=true`. The public `/config` `landingEnabled` is false by default and remains false when the operator disables it or an administrator disables the page. The landing page itself renders from the editable `apps/web/src/landing.json` template.
- `PUT /site/logo` (site admin): upload `{contentType,data}` where data is base64 PNG, JPEG, WebP or SVG up to 300 KB. `GET /site/logo` serves the public bytes with a 300-second cache; `DELETE /site/logo` removes it. `/config` exposes the current `logo` URL when set.

## Errors

`400` validation, `401` missing/expired credentials or login failure, `403` permission/origin denial, `404` missing scoped resource, `409` state/version conflict, `413` payload too large, `429` rate/concurrency limit, `502` invalid/failed AI response, `503` disabled/unavailable integration, `504` bulk deadline before headers. Post-header stream failures abort the connection. Storage and OIDC provider errors are sanitized rather than returning upstream response bodies.
