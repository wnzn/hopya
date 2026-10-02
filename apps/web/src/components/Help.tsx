import { ErrorNotice, Loading, Shell, useSession } from "./Shared";

export default function Help() {
  const { user, error: authError } = useSession();
  return (
    <Shell user={user} active="app" currentPage="Help">
      <div className="settings-body">
        <h1>Help</h1>
        <p className="muted">
          How to organize work, shape fields and statuses, and connect
          Hopya to your other tools.
        </p>
        <ErrorNotice error={authError} />
        {!user && !authError ? (
          <Loading />
        ) : (
          <>
            <section className="settings-section" aria-labelledby="help-start-heading">
              <div className="section-intro">
                <h2 id="help-start-heading">Getting started</h2>
                <p>Workspaces, the sidebar, and the account menu.</p>
              </div>
              <div className="stack">
                <ul>
                  <li>
                    A <strong>workspace</strong> is a shared space for tasks,
                    hierarchy, and fields. Switch workspaces from the sidebar
                    picker; your choice is remembered on this browser.
                  </li>
                  <li>
                    The <strong>sidebar</strong> holds the workspace picker,
                    project tree, and an All-tasks view on every signed-in page.
                    On narrow screens open it with the Menu button. Expand or
                    collapse branches with their disclosure controls; this
                    browser remembers collapsed branches per workspace.
                  </li>
                  <li>
                    The <strong>account menu</strong> (your avatar, bottom of
                    the sidebar) links to Account settings, Field management,
                    Import &amp; export, Webhooks &amp; automations, API docs, Help,
                    Workspace settings, and Administration for site admins, plus Sign out.
                  </li>
                  <li>
                    The workspace <strong>Inbox</strong> sits below the workspace
                    picker. It shows new assignments and user mentions, with
                    controls to mark entries read or unread and delete them.
                  </li>
                  <li>
                    The <strong>workspace assistant</strong> answers questions
                    about this workspace and can suggest a next step. Messages
                    are sent to your operator&apos;s configured AI provider, and
                    every task suggestion needs your confirmation before
                    anything is created.
                  </li>
                </ul>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="help-hierarchy-heading">
              <div className="section-intro">
                <h2 id="help-hierarchy-heading">Hierarchy</h2>
                <p>Projects, folders, lists, documents, and tables organize workspace information.</p>
              </div>
              <div className="stack">
                <ul>
                  <li>
                    <strong>Projects</strong> group related work. They hold the
                    field assignment and the default status workflow.
                  </li>
                  <li>
                    <strong>Folders</strong> nest inside projects to group
                    lists. Fields are assigned at the project level, so a
                    folder&apos;s tasks use its project&apos;s fields.
                  </li>
                  <li>
                    <strong>Lists</strong> hold tasks. A standalone list can sit
                    at the workspace root and owns its fields and statuses. A
                    list inside a project follows that project&apos;s statuses unless
                    it defines an override. Use a node&apos;s Manage action to choose
                    its shared icon and color; click the icon beside a page title
                    to change it directly. Document and Table icons use their
                    own write permissions. List management also configures
                    colors for exact tag names.
                  </li>
                  <li>
                    <strong>Tables</strong> are generic structured data beside lists
                    and documents. Add typed columns, then enter records directly in
                    the grid. Click a column title for ordering and permitted
                    rename/delete actions, or use Filters
                    to apply typed Match all conditions across the entire Table.
                    Use Calculate beneath a column for counts, numeric totals/averages,
                    date bounds or checkbox counts across all matching records.
                    Number headers also offer Number display for decimal places
                    and dot/comma/space separators, remembered in this browser.
                    These choices affect readability; stored and exported values
                    keep their precision.
                    The … menu contains Add column and Import / export; the refresh
                    icon reloads records.
                    Tables do not contain tasks or use task views.
                  </li>
                </ul>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="help-views-heading">
              <div className="section-intro">
                <h2 id="help-views-heading">Views</h2>
                <p>Five ways to look at the same tasks.</p>
              </div>
              <div className="stack">
                <ul>
                  <li>
                    <strong>List</strong> for scanning and spreadsheet-style
                    editing, <strong>board</strong> for status columns with drag
                    and drop, <strong>calendar</strong> for due dates, <strong>gallery</strong>{" "}
                    for cards, and <strong>timeline</strong> for start-to-due ranges.
                  </li>
                  <li>
                    Gallery uses the first body image as each task&apos;s cover.
                    Previous and next controls browse additional body images;
                    selecting the image or title opens the task.
                  </li>
                  <li>
                    Open the compact <strong>Columns</strong> disclosure to show,
                    hide, or reorder List columns. Dragging and Move buttons
                    provide pointer and keyboard alternatives.
                  </li>
                  <li>
                    List column order, visibility, and sorting are saved for
                    your account in the current workspace and project scope.
                  </li>
                  <li>
                    Each List section ends with an <strong>Add task</strong> row
                    that opens creation with that exact list selected.
                  </li>
                  <li>
                    In the <strong>calendar</strong>, tasks appear on their due
                    date (or start date if there is no due date). Tasks with
                    dates outside the shown month, or without any date, are
                    listed below the grid so nothing disappears. Use the month
                    arrows or Today to navigate.
                  </li>
                  <li>
                    In the <strong>timeline</strong>, tasks draw a bar from
                    start date to due date; tasks without a usable date range
                    are grouped underneath with an add-dates shortcut.
                  </li>
                </ul>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="help-tasks-heading">
              <div className="section-intro">
                <h2 id="help-tasks-heading">Tasks</h2>
                <p>Everything about a single piece of work.</p>
              </div>
              <div className="stack">
                <ul>
                  <li>
                    Select a task title to open its <strong>details</strong>{" "}
                    dialog with the full editor: title, Body, status,
                    priority, dates, assignee, tags, and custom fields.
                  </li>
                  <li>
                    In List, one click selects a text or number cell. Press
                    Enter or F2, or double-click, to edit it. Choice, checkbox,
                    and date-like cells open their suitable control directly.
                    Tab or selecting another cell saves and moves; selecting
                    outside the grid saves and clears the selection. Validation
                    or a conflict keeps the draft open.
                  </li>
                  <li>
                    Use <strong>Add fields</strong> (the options dialog) to
                    configure workspace fields for the task&apos;s project or
                    standalone list without leaving the task.
                  </li>
                  <li>
                    Track steps with <strong>checklists</strong> and break big
                    work down into <strong>subtasks</strong> nested under a
                    parent task.
                  </li>
                  <li>
                    The task <strong>Comments</strong> panel supports replies to
                    comments and replies plus emoji reactions. Authors can
                    delete their own comments; roles with comments:manage can
                    moderate the workspace discussion.
                  </li>
                  <li>
                    In a Body or comment, type <strong>@</strong> for members,
                    <strong> @@</strong> for tasks, or <strong> @@@</strong> for
                    projects, folders, and lists. Only member mentions create
                    Inbox notifications.
                  </li>
                  <li>
                    <strong>Statuses</strong> follow the project workflow or a
                    list override. <strong>Tags</strong> are free-form labels:
                    add one at a time — commas are part of a tag, not a
                    separator — and a task can carry up to 30.{" "}
                    <strong>Dates</strong> drive the calendar and timeline, and
                    the <strong>assignee</strong> is a workspace member. Tag
                    colors are configured independently for each list.
                  </li>
                  <li>
                    <strong>Checklist</strong> values are picked from a
                    searchable dropdown that stays open while you type and
                    closes with Escape.
                  </li>
                </ul>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="help-descriptions-heading">
              <div className="section-intro">
                <h2 id="help-descriptions-heading">Body</h2>
                <p>Rich text for context and notes.</p>
              </div>
              <div className="stack">
                <ul>
                  <li>
                    The Body editor toolbar offers bold, italic,
                    strikethrough, code, headings, bulleted and numbered lists,
                    quotes, code blocks, and links.
                  </li>
                  <li>Links are checked before they apply; unsafe targets are rejected.</li>
                  <li>
                    Task bodies, comments and replies support private images.
                    Choose the Add image icon, paste an image file or drop it into the editor.
                    PNG, JPEG, GIF and WebP files may be up to 10 MiB each.
                    A new task can include images before its first save.
                  </li>
                  <li>
                    Text drafts and uploaded image references recover in the same
                    browser tab. Failed uploads have retry controls, but pending
                    file bytes are lost on page reload. Unsaved uploads expire
                    after 24 hours and must then be uploaded again.
                  </li>
                </ul>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="help-fields-heading">
              <div className="section-intro">
                <h2 id="help-fields-heading">Fields &amp; Field Management</h2>
                <p>Custom data and status workflows for projects and standalone lists.</p>
              </div>
              <div className="stack">
                <ul>
                  <li>
                    <strong>Assignment:</strong> uncheck a field to remove it
                    from a project or standalone list. Saved task values are retained, and core
                    task details remain available in the task editor.
                  </li>
                  <li>
                    <strong>Creation:</strong> creating a field in the field
                    dialog adds a workspace catalog field to that field owner only,
                    with no default task values set.
                  </li>
                  <li>
                    <strong>Number templates</strong> such as Estimate or
                    Progress are ordinary number fields; their names do not
                    enforce units or a 0–100 range.
                  </li>
                  <li>
                    <strong>Formulas</strong> are defined once when the custom
                    field is created, then calculated read-only for each task. Reference
                    other fields with double braces around the field name, for
                    example {"{{Qty}} * {{Price}}"}, and combine them with
                    numbers, quoted strings, comparisons, and the SUM, AVERAGE,
                    MIN, MAX, ROUND, ABS, IF, and CONCAT functions. IF
                    evaluates only its chosen branch. Legacy formula fields
                    created before shared expressions remain editable per task
                    until their field definition is deliberately configured.
                  </li>
                  <li>
                    <strong>Status workflows:</strong> status IDs stay stable
                    when renamed. Move tasks out of a status before removing
                    it. Completed marks finished work independently of its name.
                  </li>
                  <li>
                    <strong>Overrides:</strong> a list follows status changes
                    made in Project settings unless it overrides statuses for
                    itself. Manage both from the Field Management page by
                    picking a target project, folder, or list.
                  </li>
                </ul>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="help-import-heading">
              <div className="section-intro">
                <h2 id="help-import-heading">Import &amp; export</h2>
                <p>Bring work in, take your data with you.</p>
              </div>
              <div className="stack">
                <ul>
                  <li>
                    Start from a <strong>template</strong>, then map each source
                    column to a task field — title, description, status,
                    priority, dates, tags, assignee, or a custom field — or skip
                    columns you do not need.
                  </li>
                  <li>
                    Imports accept <strong>CSV and JSON formats</strong>.
                  </li>
                  <li>
                    Choose <strong>Tables</strong> to create a local Table or append
                    records (500 rows / 1 MB per import). Each Table also has an
                    Import / export panel in its … menu. Table exports include every record;
                    JSON preserves types and empty values.
                  </li>
                  <li>
                    <strong>Live SQL databases</strong> connects PostgreSQL, MySQL,
                    or server-side SQLite. A credential manager configures the
                    connection; linked Table cells write to existing source rows.
                    The operator must enable the database destination first.
                  </li>
                  <li>
                    <strong>Task exports</strong> contain filtered tasks and
                    custom fields. Use <strong>Download workspace JSON</strong>
                    in Workspace settings for hierarchy, workspace configuration, and
                    attachment metadata. Neither export bundles attachment
                    files, so keep downloads private.
                  </li>
                </ul>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="help-integrations-heading">
              <div className="section-intro">
                <h2 id="help-integrations-heading">Integrations &amp; automations</h2>
                <p>React to workspace events, inside or outside Hopya.</p>
              </div>
              <div className="stack">
                <ul>
                  <li>
                    <strong>Webhooks</strong> push JSON events to an HTTP
                    endpoint you control, signed for verification.
                  </li>
                  <li>
                    <strong>Automations</strong> run when a chosen event
                    happens. Build a graph of HTTP, webhook, email, log and
                    task-update nodes, with conditions and switch branches.
                    Save the draft, preview its routing, then publish a version
                    to make it active. Email requires the operator to provide SMTP.
                  </li>
                  <li>
                    Event templates cover task, node, and field-change events.
                    Use upstream node outputs in templates; the editor lists
                    values available on the current path. Existing linear
                    automations retain their event and numbered-step templates.
                    Preview performs no external actions. A real test run can
                    contact configured services; graphs containing Update task
                    require a real task event. The run monitor shows sanitized
                    node results. A failed run stops later nodes; completed
                    actions are not rolled back.
                  </li>
                  <li>
                    The <strong>API docs</strong> page documents the REST API
                    for scripts and integrations, including parameters,
                    request/response schemas, status codes, and examples.
                  </li>
                </ul>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="help-settings-heading">
              <div className="section-intro">
                <h2 id="help-settings-heading">Settings &amp; administration</h2>
                <p>Your account, your workspace, and your instance.</p>
              </div>
              <div className="stack">
                <ul>
                  <li>
                    <strong>Account settings:</strong> manage your profile picture,
                    display name, sign-in email, local password, appearance and
                    personal access tokens. Credential changes require your
                    current password and revoke other sessions and tokens.
                  </li>
                  <li>
                    <strong>Tokens</strong> in Account settings act as you
                    and respect your workspace permissions. Copy a new token
                    immediately — it is shown only once.
                  </li>
                  <li>
                    <strong>Workspace settings:</strong> manage the selected
                    workspace&apos;s name, members, roles, fields and export.
                    Add an existing account by email; this does not send an invitation. The last
                    owner cannot be removed or demoted. Administrative
                    permissions can grant broad access, so review them
                    carefully.
                  </li>
                  <li>
                    <strong>Site settings</strong> (admins) cover the instance
                    logo, the By WNZN sidebar attribution, public landing page,
                    and the disabled-by-default MCP
                    SSE endpoint. MCP clients connect to
                    <code> /api/v1/mcp/sse</code> with a personal token in the
                    <code> Authorization: Bearer</code> header. Disabling it
                    disconnects active clients; site administration does not
                    grant access to workspace data.
                  </li>
                  <li>
                    <strong>Landing page content:</strong> edit{" "}
                    <code>apps/web/src/landing.json</code> in the installation,
                    keeping its four values as plain JSON strings. Docker
                    operators apply changes with{" "}
                    <code>docker compose up -d --build web</code>. Set{" "}
                    <code>LANDING_ENABLED=true</code> in <code>.env</code> and
                    recreate the API and web services to make the disabled-by-default
                    page available. Administrators can then disable or enable it here.
                  </li>
                  <li>
                    <strong>Administration</strong> (admins) manages accounts,
                    OIDC identities, and the audit trail. You cannot disable or
                    demote yourself there, and site administration does not
                    grant access to workspace task data.
                  </li>
                </ul>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="help-access-heading">
              <div className="section-intro">
                <h2 id="help-access-heading">Keyboard &amp; accessibility</h2>
                <p>Notes for keyboard and small-screen use.</p>
              </div>
              <div className="stack">
                <ul>
                  <li>
                    Skip to content from the skip link. Dialogs and menus close
                    with Escape and return focus to the control that opened
                    them.
                  </li>
                  <li>
                    Column reorder, board drag and drop, and menus all have
                    keyboard-accessible alternatives.
                  </li>
                  <li>
                    Press unmodified <strong>C</strong> from the workspace to
                    create a task in the selected or first available list. The
                    shortcut is disabled while typing or while a dialog is open.
                  </li>
                  <li>
                    Layouts adapt down to small phones, and appearance follows
                    your device unless you pick light or dark mode in Account settings.
                  </li>
                </ul>
              </div>
            </section>
          </>
        )}
      </div>
    </Shell>
  );
}
