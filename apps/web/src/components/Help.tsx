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
                    the sidebar) links to Field management, Import &amp; export,
                    Webhooks &amp; automations, API docs, Help, Settings, and
                    Administration for site admins, plus Sign out.
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
                <p>Projects, folders, and lists give every task a home.</p>
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
                    <strong>Lists</strong> hold tasks. A list follows its
                    project&apos;s statuses unless it defines an override. Use a
                    node&apos;s Manage action to choose its shared icon and color;
                    list management also configures colors for exact tag names.
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
                    Open the compact <strong>Columns</strong> disclosure to show,
                    hide, or reorder List columns. Dragging and Move buttons
                    provide pointer and keyboard alternatives.
                  </li>
                  <li>
                    The <strong>list view</strong> can reorder its columns with
                    a drag-and-drop bar and matching Move buttons. When you
                    have permission to manage fields and the view covers a
                    single project, the order saves for that project; in mixed
                    or multi-project scopes the order lasts for the current
                    session only and resets when you leave.
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
                    dialog with the full editor: title, description, status,
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
                    assign workspace fields to the project without leaving the
                    task.
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
                <h2 id="help-descriptions-heading">Descriptions</h2>
                <p>Rich text for context and notes.</p>
              </div>
              <div className="stack">
                <ul>
                  <li>
                    The description editor toolbar offers bold, italic,
                    strikethrough, code, headings, bulleted and numbered lists,
                    links, and clear-formatting.
                  </li>
                  <li>Links are checked before they apply; unsafe targets are rejected.</li>
                </ul>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="help-fields-heading">
              <div className="section-intro">
                <h2 id="help-fields-heading">Fields &amp; Field Management</h2>
                <p>Custom data and status workflows, per project.</p>
              </div>
              <div className="stack">
                <ul>
                  <li>
                    <strong>Assignment:</strong> uncheck a field to remove it
                    from a project. Saved task values are retained, and core
                    task details remain available in the task editor.
                  </li>
                  <li>
                    <strong>Creation:</strong> creating a field in a project
                    dialog adds a workspace catalog field to that project only,
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
                    <strong>Exports</strong> bundle tasks, hierarchy, and custom
                    fields. Attachment files are not bundled, so keep the
                    download private: it contains workspace data.
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
                    happens. Add and reorder up to 20 sequential webhook,
                    HTTP, email, or non-mutating log steps. Email requires the
                    operator to provide SMTP.
                  </li>
                  <li>
                    Event templates cover task, node, and field-change events.
                    Use {"{{event}}"} in a body template to embed the event
                    JSON. Later steps can use {"{{steps.1.output}}"}, changing
                    the number to reference an earlier step. GET and other
                    bodyless requests ignore body templates. The job monitor
                    shows each run and its sanitized step output/log; a failed
                    step skips the remaining steps without changing tasks.
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
                    <strong>Profile:</strong> update your display name and, with
                    your current password, set a new one.
                  </li>
                  <li>
                    <strong>Tokens:</strong> personal access tokens act as you
                    and respect your workspace permissions. Copy a new token
                    immediately — it is shown only once.
                  </li>
                  <li>
                    <strong>Members &amp; roles:</strong> add an existing
                    account by email; this does not send an invitation. The last
                    owner cannot be removed or demoted. Administrative
                    permissions can grant broad access, so review them
                    carefully.
                  </li>
                  <li>
                    <strong>Site settings</strong> (admins) cover the instance
                    logo, public landing page, and the disabled-by-default MCP
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
                    <code>LANDING_ENABLED=false</code> in <code>.env</code> and
                    recreate the web service to send visitors directly to sign-in.
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
                    Column reorder and resize, board drag and drop, and menus
                    all have keyboard-accessible alternatives.
                  </li>
                  <li>
                    Press unmodified <strong>C</strong> from the workspace to
                    create a task in the selected or first available list. The
                    shortcut is disabled while typing or while a dialog is open.
                  </li>
                  <li>
                    Layouts adapt down to small phones, and appearance follows
                    your device unless you pick light or dark mode in Settings.
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
