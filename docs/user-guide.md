# User Guide

Hopya stores your tasks on the instance managed by your operator. The current interface is an early implementation; report errors with the action and approximate time, not your password or token.

## Sign In

Open `/login` on your instance. On a fresh installation the operator creates the first administrator using a private setup token. Everyone else signs in with an account created by an administrator, optional self-registration if enabled, or configured single sign-on. SSO is not automatic membership in a workspace. Ask a workspace owner to add you after your account exists.

There is no public demo login. If you lose your password or your identity provider is unavailable, contact the operator. Do not clear server data or repeat first setup as a password-reset method.

## Organize Work

1. Open **Work** at `/app` and create a workspace or choose an existing one from the sidebar. Your first created workspace is selected automatically.
2. Use the **+** beside **Structure** to create a standalone list or a project. Both may sit at the workspace root.
3. Tasks must belong to a list. A list may stay at the workspace root or live inside a project or folder. Folders remain inside projects or other folders.
4. Select a project/folder to see tasks in its descendant lists, select a list for just its tasks, or choose **All tasks** for the whole workspace.
5. Use a structure entry's **Manage** control to rename it or move a folder/list in the same workspace. Lists may move to workspace root; folders remain inside projects. Contents and workspace permissions stay intact. Cycles and moves beyond the nesting limit are rejected, and a stale move asks you to reload rather than overwrite someone else's placement.
6. Only empty structure entries can be deleted; deletion is not an automatic recursive purge.

Documents appear as first-class entries in the workspace hierarchy at workspace root or beneath a project/folder. Create one through the same hierarchy action, then edit its title and Markdown body. The separate Pages sidebar includes the main document and its page tree. Its header `+` creates another top-level page inside the document; the `+` on a page row creates a nested child of that page. Selecting any entry opens it in the same editor. All page documents remain grouped beneath their containing main document in the workspace hierarchy, while the Pages sidebar distinguishes peer pages from true subpages for indentation and collapse behavior. A page's options menu can open, rename or delete it; confirmed deletion also removes its nested document subpages. Existing task-page links and linked tasks remain preserved. A project/folder containing a document is not considered empty.

Workspaces are separate permission boundaries, not just visual categories. Being a site administrator does not automatically reveal all task data.

## Create And Edit

Choose **New task**, select its list and provide a title. When creation starts from a specific list, that destination is fixed and omitted from the form. Optional fields include body, priority, tags, start date, due date, an assignee from the workspace and custom fields configured by the workspace manager. The checklist starts collapsed. A disabled **New task** button may mean there is no list yet; a missing action may mean your role lacks permission.

The **Body** uses the TipTap rich-text editor and is stored as Markdown. Its toolbar offers bold, italic, strikethrough, inline code, headings, lists, quotes, code blocks and links; an existing link can be edited or removed. Standard keyboard history shortcuts remain available. Plain typing stays plain Markdown. Board and list previews show plain text; control characters are normalized on save and formatting is preserved verbatim up to the 50,000-character limit.

In a task Body or comment, type `@` to mention a workspace member, `@@` to link a task, or `@@@` to link a project, folder, or list. Only user mentions notify, and only active members who can read tasks are offered. New assignments and user mentions appear in the workspace **Inbox** below the workspace picker. Its badge is hidden at zero; Inbox entries can be opened, marked read/unread, or deleted.

Open a task or document's **Comments** panel to post Markdown comments, reply, and add a reaction. To comment on a specific saved plain-text word or line, select one unambiguous segment in the read-only body and choose **Comment on selection**. A selection crossing Markdown formatting boundaries may need to be narrowed. Attached ranges are highlighted. If later edits remove the text or make its match ambiguous, the thread remains with its original quote and is marked orphaned. Duplicate selected text cannot be anchored until the selection is unambiguous. Reply threads retain a deleted marker when a parent is removed. Authors can delete their own comments; roles with `comments:manage` can moderate them. Posting and reacting require `comments:create` plus read access to the target.

When you select a project or folder, ordinary creation defaults to a list inside that location, not an unrelated workspace list. If that location has no lists, create one with **Add a list here** (when permitted) or ask a manager. Existing task edits retain their actual list; explicit assistant review can still choose any authorized workspace list.

Task destination choices show project/folder ancestry; identical paths also show an ID so you can distinguish them. If a save reports a version conflict, your draft remains open. **Reload current task** asks before replacing the draft with the latest record; cancel to keep your work, or confirm and then reapply only your intended changes. A failed reload keeps the draft. The app never silently retries a conflicting write.

Projects and standalone lists start with To do, Backlog, In progress, Review and Done. Lists inside projects can inherit project statuses or define their own; standalone lists always define their own. Priorities are None, Low, Medium, High and Urgent. Start and due dates are calendar dates, not timed reminders; do not assume a notification will be sent when a due date arrives. Custom DateTime fields also store a time. Open an existing task to edit, then save. Deletion requires its own permission and confirmation; there is no promised undo/trash recovery.

Search matches task titles, descriptions and tags in the current workspace selection. The status filter and hierarchy selection also affect what you see. Clear filters before concluding that a saved task is missing.

## Views

| View | How to use it |
| --- | --- |
| List | Select text/number cells and press Enter or F2 to edit; choice/date cells open directly. Use the title for full details or its pencil for inline rename. |
| Board | Tasks appear in status columns. Drag a card or use its **Move to** select control, which also works with a keyboard or touch. |
| Calendar | Tasks appear on their due date, or start date if no due date exists. Undated and outside-grid tasks have separate lists. Use month arrows, **Today**, or **Jump to month**. |
| Gallery | Tasks appear as status-aware cards. Choose Auto-fit or two through five columns; the browser remembers the workspace choice and narrow screens use one safe column. |
| Timeline | A Gantt-style month view spans start through due date. A single date is a one-day milestone. Unscheduled/out-of-month tasks are listed separately. **Jump to month** avoids repeated arrow clicks. This is not dependency scheduling or a critical-path planner. |

Changing views does not copy or move tasks. The same selected workspace, hierarchy, search and status filter apply. Calendar and timeline edits use the task dialog, not a required drag gesture.

List view renders one section per actual destination list in the selected hierarchy, including nested and empty lists, so each section can end with an unambiguous **Add task** row. The sections share the initial 100-task display budget; search and totals remain complete. Board, List and Timeline use the available width and scroll internally when their contents are wider; Gallery responds from one to five columns. Project descriptions can be entered when creating or managing a project and appear beneath its title.

The sidebar's disclosure controls collapse or expand project/folder branches, persisted in this browser per workspace. Managing a project, folder, or list also lets workspace structure managers choose a shared icon and color from the safe built-in catalog.

The workspace loads tasks in bounded pages and reports progress. Until all pages arrive, partial rows and totals are not presented as complete; a failed load offers retry. Search and filters cover the whole successfully loaded workspace, including later pages.

List and Gallery initially show 100 matching tasks; Board shows up to 100 in each column. Calendar starts with up to 100 per displayed day and 100 in each undated/outside list. Timeline starts with 100 scheduled rows in the chosen month plus 100 outside/unscheduled rows. Each view shows complete totals and an explicit control to reveal more; no task is removed from search or export. Expanded batches survive saves/refreshes and reset when you change view, filters or the selected date month. The browser still retains the full loaded dataset, so deliberately expanding every row can be expensive.

On narrow screens use the navigation toggle and horizontally scroll wide boards, calendars and List grids. **Tab** moves through controls; task-view tabs also support arrow keys and Home/End. Open cards with the keyboard and change statuses with **Move to** rather than dragging. Dialogs support keyboard focus and Escape to close. Use the displayed save action to persist edits before closing.

## Settings

Click your account icon at the bottom of the sidebar to open **Account settings**, **Field management**, **Import &amp; export**, **Webhooks &amp; automations**, **API docs**, **Help**, **Settings**, **Administration** (site administrators only), or **Sign out**. The account menu supports keyboard activation and Escape to close.

**Appearance** contains the dark-mode control and **Use system theme** reset. The choice is saved in this browser and also applies on the login page. The sidebar uses a lighter dark surface and is separated from application content; there is no theme button among the navigation links.

At `/settings` or `/account`, update your display name, sign-in email, or local password. Email and password changes require your current password; credential changes revoke other sessions, personal tokens, and pending reset links, so reconnect affected clients.

Select the intended workspace before changing its settings. Depending on your permissions you can rename it, add existing users by email, change/remove memberships, manage custom roles and define custom fields. Types are text, number, date, datetime, checkbox, dropdown, checklist, rating and formula. Dropdown selects one configured option; checklist selects multiple options. Ratings have a configurable maximum from 1 to 10. Deleting a definition from the workspace catalog removes its task values; export important data first. Workspace owners also see **Delete workspace**. This permanently removes its tasks, hierarchy, members, fields and automation history after the exact workspace name is entered; download any needed export first.

### Project and Standalone List Fields

Choose a project, standalone list or a list inside a project, then **Add fields** in List. The task options menu offers the same configuration without discarding an unsaved draft. In All tasks, explicitly choose the target in the picker. Check existing catalog fields or optional built-ins and choose **Apply fields**, or use **Create field and add**. Templates include Estimate (hours), Effort (points), Progress (%) and Reference; they are ordinary typed fields, not automatic unit/range enforcement.

Core List columns are Task, Status, Assignee and Due date. Optional columns include Priority, Start date, Tags, Body, List, Created and Updated. Projects and standalone lists select their own optional/custom fields; lists inside projects inherit the project's choices. New field owners start without optional fields. Existing projects retain their previous field visibility after migration so saved work does not disappear unexpectedly; trim their configuration using the picker.

The project field picker also contains status and date settings. Add or remove statuses, change their names/colors, and mark which count as completed. A status still used by tasks cannot be removed: move those tasks to another status first. Cross-project moves require a status supported by the destination. New tasks start in the first effective status.

When a project-owned list is selected, **Add fields** edits field assignments for its project, but the status section applies only to that list. Choose **Use project statuses** to inherit future project changes, or **Override statuses for this list** to maintain a separate ordered status set. A standalone root list owns its optional built-ins, custom-field assignments and date format, and directly edits its own statuses. At `/settings`, the field target selector includes projects and lists. Board columns and the status filter combine the definitions of the lists currently in scope, including configured statuses that have no tasks.

Use **Move up** and **Move down** to order project or list statuses; the first effective status is the default for new tasks. When an existing task moves to another list, its status is retained only if that list supports it, otherwise it changes to the destination's first status. New-task drafts always change to the destination's first status when their list changes. If multiple lists use different definitions with the same status name, Board labels those columns with the applicable list paths and marks incompatible drag targets unavailable.

Choose a project date format such as `YYYY-MM-DD`, `Sep 7, 2026`, `September 7, 2026`, or `07/09/2026`. Individual Date/DateTime fields can override it. Formatting does not rewrite stored dates; DateTime editing uses local time and persists an ISO timestamp. Workspace field settings can edit names, options and rating limits. Changes that invalidate saved values are rejected, as are renames referenced by stored formulas; update those values or formulas first.

Unchecking a project field hides it without deleting saved values. Task details retain them under **Other saved fields**; adding the field back restores it. Moving a task/list between projects preserves all values. All tasks combines configured columns across projects and leaves unassigned row cells blank. In List, one click selects text/number cells; Enter, F2, or double-click starts editing. Choice, checkbox, and date-like cells open directly. Tab or choosing another cell saves and moves, while choosing outside the grid saves and clears selection. Escape cancels. Errors retain the draft, and a conflict offers an explicit discard-and-reload action rather than silently overwriting someone else's work. Open **Columns** to change order or visibility. Open **Filter & group** beside it to add multiple AND filters or group each list by any built-in or custom task field, including fields not shown as columns. Row checkboxes select the currently displayed tasks in that list and reveal permission-aware Archive and Delete actions; parent tasks require their subtasks to be selected. Archive removes tasks from ordinary views while complete workspace backups retain them. Column order, visibility, and sorting are saved for your account and workspace/project scope. Press unmodified **C** outside inputs and dialogs to create a task in the selected or first available list.

Priority badges progress from green Low through amber Medium and orange High to dark red Urgent. Manage a list to assign colors to up to 30 exact tag names; the same tag may intentionally have a different color in another list.

### Formula Examples

Enter a raw expression in a Formula field; the preview and cells display its result. References use exact custom-field names, not spreadsheet cell addresses. Supported functions are SUM, AVERAGE, MIN, MAX, ROUND, ABS, IF and CONCAT; names are case-insensitive and a leading `=` is optional.

```text
=SUM({{Estimate}}, {{Buffer}})
=IF({{Qty}}>0, ROUND({{Qty}}*{{Price}}, 2), 0)
=CONCAT("Task: ", {{Reference}})
```

This is a bounded display calculator, not full Excel: no code, network access, range addresses or recursive evaluation of other formula strings. Missing inputs or invalid/non-finite calculations display the raw expression. Inputs already stored as null count as numeric zero or empty text; a missing field is not assumed to be zero.

An AI proposal's priority remains visible in its review dialog even if Priority is not selected for that project's columns. Hiding a column never skips human review of a suggested value.

In the task editor, empty text/number/date/select values clear to an unset value. Checkbox fields distinguish **No** from **Not set**: uncheck for No, or choose **Clear** to unset. Viewers can focus, select and scroll the full task description and text values without receiving edit permission.

Owners have protected controls. The last active owner cannot be removed, and a role manager cannot use custom roles to escalate beyond delegated permissions. If you cannot perform an action, ask an owner to review your role rather than trying another UI or token: the API enforces the same boundary.

**Download workspace JSON** exports version 5 task, hierarchy, attributed document/page, discussion, reaction, root field-owner, list-configuration, custom-field and attachment-metadata records allowed by your current permissions. In `projectFields`, the historical `projectId` key may identify a root project or standalone root list. Treat the file as private. It does not bundle attachment bytes, user accounts, credentials or all site state, and it is not a restore point. Operators need the [full backup procedure](deployment.md#backup-and-restore).

The browser downloads this as a streamed snapshot. Wait for successful download completion; an interrupted stream is not a complete export. Permission revocation, a slow connection or too many simultaneous downloads can stop it. Close redundant downloads and retry only while you still have access.

## Account Settings

Open the user menu and choose **Account settings** to update your display name, sign-in email, or local password. Email and password changes require your current local password and revoke your other sessions, personal tokens, and pending password-reset links. Accounts that sign in only through SSO can update their display name but must manage their identity-provider email and credentials with that provider.

When the operator has configured local mail delivery, **Forgot your password?** appears on the sign-in page. Entering an email always shows the same response. Eligible local accounts receive a single-use link valid for 30 minutes; completing it signs out every existing Hopya session and revokes all personal tokens. If mail recovery is unavailable, contact the instance operator without sharing a password.

## Personal Tokens

In **Personal access tokens** under Settings, give a token a recognizable name, create it and put the one-time value into your script or MCP client's private environment. It acts as you with your current workspace permissions. Never share it in chat, commit it or put it in a URL. If lost, create a replacement; it cannot be shown again. Choose **Revoke** to stop clients using that token immediately.

The [README](../README.md#api-and-mcp) has MCP launch settings. Your MCP client, not an ordinary terminal conversation, launches the stdio process. Alternatively, a site administrator can enable MCP SSE in **Administration > Site settings** and clients can connect to `/api/v1/mcp/sse` with a personal bearer token header. MCP is read-only unless the operator sets `HOPYA_MCP_ALLOW_WRITES=true` for the relevant process. Even then, the client must request human confirmation for each write; enabling tools does not approve their use. See the [integration guide](integrations.md).

## Attachments And AI

Save the task first, then use its attachment section to upload a file up to 10 MiB. Downloads remain permission-checked; sharing a download URL does not make a file public. Size errors can come from either the application or proxy. Do not upload executable content you expect Hopya to run, and do not assume uploads have been malware-scanned. Removing a task/attachment revokes its availability, but physical cleanup and S3 version retention may take longer. Ask the operator about storage and retention.

Wait for attachment loading to finish before adding/removing files. A failed listing offers **Retry attachments** instead of claiming the task has none. If an upload's refresh fails, retry the listing before uploading again; the file may already have been saved.

The **Assistant** control appears only when AI is configured and your role has `agent:use`. It may send authorized workspace context and your message to the operator-selected provider. Do not submit secrets or sensitive material without understanding that policy. Review any proposed task fields, list and workspace, then explicitly save the reviewed proposal if you want the change. A chat response alone must not apply a mutation. Decline or close unwanted proposals; AI may be wrong or unavailable, and manual task editing remains the fallback.

Closing the assistant or switching workspace cancels its pending browser request and discards that panel's conversation. Resizing the window does not cancel it. Hopya stops its provider HTTP work when the disconnect reaches the API, but cannot guarantee that a remote provider stops computing or charging, or retract data already sent. A busy assistant asks you to retry; stalled provider requests are bounded to 45 seconds and never automatically create a task.

## Administration

Site administrators use the separate `/admin` page to create local users, manage administrator/disabled status, inspect service status and read restricted audit records. Disabling an account revokes its access and clears assignments, even for a sole workspace owner; ownership records remain for recovery. The last active site administrator is protected. Administration is not a substitute for joining a workspace with an appropriate role.

Provider credentials, `APP_URL`, the operator landing-page gate, registration and SSO provisioning are environment settings, not ordinary user preferences. The public landing page is disabled by default and requires `LANDING_ENABLED=true` before the administrator control can enable it. A service status flag means configured, not necessarily reachable or tested.

## Integrations And Automations

Members with workspace-management permission find **Webhooks &amp; automations** in the account menu. Webhooks push `item.*`, `node.*` and `field.changed` events to up to 20 endpoints per workspace as signed JSON (`x-hopya-signature: sha256=HMAC(secret, body)`); the secret is shown once at creation and can be rotated later. Automations (up to 50 per workspace) react to one event with 1-20 ordered `webhook`, `http`, `email`, or non-mutating `log` steps. Use `{{event}}` for event JSON and `{{steps.1.output}}` in a later step to reference bounded output from step 1. Email requires operator `SMTP_URL`. Runs are transactionally queued with triggering mutations, execute sequentially, survive restarts, and stop after a failed step. The job monitor shows recent run and step status with sanitized bounded output/logs; failures never roll back the triggering task change. Public machine-readable API documentation is served at `/api/v1/openapi.json`. **API docs** renders endpoint details without nested disclosures; its sticky controls search individual operations and filter by method or category.

Site administrators manage the optional public landing page and branding from `/admin`: disable or enable a landing page allowed by the operator, or upload a custom logo (PNG, JPEG, WebP or SVG up to 300 KB) shown in the navigation and sign-in areas. The landing page renders the operator-editable `apps/web/src/landing.json` template.

## Field Management

Open **Field management** from the account menu for the full-page field workspace, titled **Field Management**. Pick a workspace, then filter the project/folder/list tree (kind glyphs plus full hierarchy paths) and select a target; the summary card confirms the selection. Folders resolve to their owning project for field assignment while list targets keep list-status override behavior. The right panel reuses the same assignment, creation, status and concurrency semantics as the in-context field dialog, including the permission notice when you lack management rights.

## Import And Export

Open **Import &amp; export** from the account menu. Download the CSV or JSON template, fill up to 500 rows, choose the destination list (imports always target one list), and map each detected column or key to a field: title (exactly one required), description, status, priority, dates, tags, assignee, any workspace custom field, keep-as-is, or ignore. Unmapped `custom:<Name>` columns pass through and fail the import if the field does not exist; the server validates every row before writing anything, so a failed import creates zero tasks.

Export from the same page by workspace, scope (all tasks or one list), status, search text and format; the file downloads as `hopya-export-*.csv` or `*.json`. CSV flattens custom fields to `custom:<Name>` columns, while JSON retains the API-shaped, field-ID-keyed `customFields` object.

In **OIDC identities**, choose the intended account to view or link SSO identities. Verify the exact issuer URL and OIDC subject in your trusted provider before checking the confirmation box; do not infer identity from email. Provider subject strategies differ; the supplied Ory client uses public subjects based on the Kratos identity ID.

**Unlink** asks for confirmation because it revokes every session and personal token for that Hopya account. Its local password remains usable; a passwordless account must retain another identity for the currently configured issuer. An identity for a different/inactive issuer is not a recovery method on this instance, and disabled SSO does not qualify. Verify recovery sign-in before unlinking; the server cannot prove an operator-linked upstream subject exists. Unlinking yourself signs you out. To quarantine access, disable the Hopya/upstream account and review auto-provisioning; unlinking alone is not a permanent upstream enrollment ban.

## Troubleshooting

- **Origin not allowed:** use the exact instance URL the operator configured, including scheme and port. `localhost` and `127.0.0.1` are different origins.
- **Permission denied:** check the workspace and ask an owner to review your membership/role. A personal token cannot bypass permissions.
- **Too many attempts:** wait for the indicated retry window. Login limits distinguish accounts but also cap total attempts from one IP; shared NATs and incorrectly configured outer proxies can share aggregate login and SSO limits. Ask the operator if it persists.
- **No tasks visible:** check workspace, selected hierarchy, search, status and calendar month.
- **New SSO identity rejected:** provisioning may be disabled; a matching local email is deliberately not enough to link identities.
- **Service/provider failure:** report the action and time privately to your operator. Do not post browser cookies, API tokens or complete prompts with diagnostics.
