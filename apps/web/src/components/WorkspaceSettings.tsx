import { useEffect, useState, type SubmitEvent } from "react";
import {
  api,
  label,
  message,
  permissions,
  workspacePath,
  type Detail,
  type Field,
  type Role,
  type Workspace,
} from "../lib/api";
import { ErrorNotice, Modal } from "./Shared";
import ProjectFields from "./ProjectFields";
import { FieldEditor, FieldSettings, fieldSettings } from "./FieldSettings";
import Select from "./Select";

export default function WorkspaceSettings({
  detail: incomingDetail,
  onSaved,
  onDeleted,
}: {
  detail: Detail;
  onSaved: (workspaceId: string, workspace?: Workspace) => void;
  onDeleted: (workspaceId: string) => void;
}) {
  const [detail, setDetail] = useState(incomingDetail);
  useEffect(() => setDetail(incomingDetail), [incomingDetail]);
  const [fieldsChanged, setFieldsChanged] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [roleEditor, setRoleEditor] = useState<{ role?: Role } | null>(null);
  const [fieldType, setFieldType] = useState<Field["type"]>("text");
  const [settings, setSettings] = useState<NonNullable<Field["settings"]>>({});
  const [fieldEditor, setFieldEditor] = useState<Field>();
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const base = workspacePath(detail.workspace.id);
  const can = (permission: string) => detail.permissions.includes(permission);
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      const result = await api<Workspace>(`${base}${path}`, method, body);
      onSaved(detail.workspace.id, path === "" ? result : undefined);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function deleteWorkspace() {
    const confirmation = window.prompt(
      `Permanently delete "${detail.workspace.name}" and all of its tasks? Type the workspace name to confirm.`,
    );
    if (confirmation !== detail.workspace.name) return;
    setBusy(true);
    setError("");
    try {
      await api(base, "DELETE");
      onDeleted(detail.workspace.id);
    } catch (cause) {
      setError(message(cause));
      setBusy(false);
    }
  }
  function submit(
    event: SubmitEvent<HTMLFormElement>,
    action: (data: FormData) => void,
  ) {
    event.preventDefault();
    action(new FormData(event.currentTarget));
  }
  return (
    <>
      <ErrorNotice error={error} />
      {can("workspace:manage") && (
        <section className="settings-section">
          <div className="section-intro">
            <h2>Workspace name</h2>
            <p>A familiar name for this shared space.</p>
          </div>
          <form
            className="inline-form"
            onSubmit={(e) =>
              submit(
                e,
                (data) => void mutate("", "PATCH", { name: data.get("name") }),
              )
            }
          >
            <label>
              Name
              <input
                name="name"
                defaultValue={detail.workspace.name}
                required
                maxLength={120}
              />
            </label>
            <button disabled={busy}>Rename workspace</button>
          </form>
        </section>
      )}
      {detail.role.isOwner && (
        <section className="settings-section" aria-labelledby="delete-workspace-heading">
          <div className="section-intro">
            <h2 id="delete-workspace-heading">Delete workspace</h2>
            <p>Permanently remove this workspace, including its tasks, hierarchy, members, fields, and automation history.</p>
          </div>
          <div>
            <button type="button" className="danger" disabled={busy} onClick={() => void deleteWorkspace()}>
              Delete workspace
            </button>
          </div>
        </section>
      )}
      {can("members:manage") && (
        <section className="settings-section">
          <div className="section-intro">
            <h2>People</h2>
            <p>
              Add an existing account by email. This does not send an invitation
              email or create an account.
            </p>
          </div>
          <div className="stack">
            <form
              className="form-grid"
              onSubmit={(e) =>
                submit(
                  e,
                  (data) =>
                    void mutate("/members", "POST", {
                      email: data.get("email"),
                      roleId: data.get("roleId"),
                    }),
                )
              }
            >
              <label>
                Existing user's email
                <input
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                  placeholder="teammate@example.com"
                />
              </label>
              <label>
                Role
                <Select name="roleId" required defaultValue="">
                  <option value="" disabled>
                    Choose a role
                  </option>
                  {detail.roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </label>
              <div>
                <button className="primary" disabled={busy}>
                  Add member
                </button>
              </div>
            </form>
            <ul className="record-list">
              {detail.members.map((member) => (
                <li key={member.userId}>
                  <div>
                    <strong>{member.name}</strong>
                    <small>{member.email}</small>
                  </div>
                  <label>
                    <span className="sr-only">Role for {member.name}</span>
                    <Select
                      value={member.roleId}
                      disabled={busy}
                      onChange={(e) =>
                        void mutate(`/members/${member.userId}`, "PATCH", {
                          roleId: e.target.value,
                        })
                      }
                    >
                      {detail.roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove ${member.name} from this workspace?`,
                        )
                      )
                        void mutate(`/members/${member.userId}`, "DELETE");
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {can("roles:manage") && (
        <section className="settings-section">
          <div className="section-intro">
            <h2>Roles & permissions</h2>
            <p>
              Grant only the access each person needs. The Owner role is
              protected.
            </p>
          </div>
          <div className="stack">
            <div>
              <button onClick={() => setRoleEditor({})}>+ Create role</button>
            </div>
            <ul className="record-list">
              {detail.roles.map((role) => (
                <li key={role.id}>
                  <div>
                    <strong>{role.name}</strong>
                    <small>{role.permissions.length} permissions</small>
                  </div>
                  <button
                    disabled={role.isOwner || busy}
                    onClick={() => setRoleEditor({ role })}
                  >
                    Edit permissions
                  </button>
                  <button
                    className="danger"
                    disabled={role.isOwner || busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete the ${role.name} role? Reassign its members first.`,
                        )
                      )
                        void mutate(`/roles/${role.id}`, "DELETE");
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {can("structure:write") && (
        <section className="settings-section">
          <div className="section-intro">
            <h2>Custom fields</h2>
            <p>
              Workspace field catalog. Creating here does not add a field to any project.
              Delete permanently removes a field and its task values; removing it from a project retains values.
            </p>
          </div>
          <div className="stack">
            <button type="button" disabled={busy} onClick={() => setFieldsOpen(true)}>Project fields</button>
            <form
              className="form-grid"
              onSubmit={(e) =>
                submit(
                  e,
                  (data) =>
                    void mutate("/fields", "POST", {
                      name: data.get("name"),
                      type: fieldType,
                      ...(["date", "datetime", "rating", "formula"].includes(fieldType) ? { settings: fieldSettings(fieldType, settings) } : {}),
                      ...(["select", "checklist"].includes(fieldType)
                        ? {
                            options: [
                              ...new Set(
                                String(data.get("options"))
                                  .split("\n")
                                  .map((v) => v.trim())
                                  .filter(Boolean),
                              ),
                            ],
                          }
                        : {}),
                    }),
                )
              }
            >
              <label>
                Field name
                <input
                  name="name"
                  required
                  maxLength={120}
                  placeholder="e.g. Effort"
                />
              </label>
              <label>
                Type
                <Select
                  value={fieldType}
                  onChange={(e) =>
                    setFieldType(e.target.value as Field["type"])
                  }
                >
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="date">Date</option>
                  <option value="datetime">Date and time</option>
                  <option value="checklist">Checklist</option>
                  <option value="rating">Rating</option>
                  <option value="checkbox">Checkbox</option>
                  <option value="select">Dropdown</option>
                  <option value="formula">Formula</option>
                </Select>
              </label>
              <FieldSettings type={fieldType} settings={settings} onChange={setSettings} />
              {["select", "checklist"].includes(fieldType) && (
                <label className="full-width">
                  Options, one per line
                  <textarea
                    name="options"
                    required
                    maxLength={4000}
                    rows={4}
                    placeholder={"Small\nMedium\nLarge"}
                  />
                </label>
              )}
              <div>
                <button disabled={busy}>Create field</button>
              </div>
            </form>
            {detail.fields.length === 0 ? (
              <p className="muted">
                No custom fields yet. Start with something useful to your team.
              </p>
            ) : (
              <ul className="record-list">
                {detail.fields.map((field) => (
                  <li key={field.id}>
                    <div>
                      <strong>{field.name}</strong>
                      <small>
                        {label(field.type)}
                        {field.options?.length
                          ? ` · ${field.options.join(", ")}`
                          : ""}
                      </small>
                    </div>
                    <button type="button" disabled={busy} onClick={() => setFieldEditor(field)}>Edit field {field.name}</button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete the ${field.name} field and its task values? Export your workspace first if you need them.`,
                          )
                        )
                          void mutate(`/fields/${field.id}`, "DELETE");
                      }}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      {fieldEditor && can("structure:write") && <FieldEditor key={`${detail.workspace.id}:${fieldEditor.id}`} field={fieldEditor} base={base} onClose={() => setFieldEditor(undefined)} onSaved={() => { setFieldEditor(undefined); onSaved(detail.workspace.id); }} />}
      {fieldsOpen && can("structure:write") && <ProjectFields key={detail.workspace.id} detail={detail}
        onClose={() => {
          setFieldsOpen(false);
          if (fieldsChanged) { setFieldsChanged(false); onSaved(detail.workspace.id); }
        }} onUpdated={fresh => { setDetail(fresh); setFieldsChanged(true); }} />}
      {roleEditor && (
        <RoleEditor
          base={base}
          role={roleEditor.role}
          onClose={() => setRoleEditor(null)}
          onSaved={() => {
            setRoleEditor(null);
            onSaved(detail.workspace.id);
          }}
        />
      )}
    </>
  );
}
function RoleEditor({
  base,
  role,
  onClose,
  onSaved,
}: {
  base: string;
  role?: Role;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState(role?.permissions || []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const descriptions: Record<string, string> = {
    "items:read": "Read tasks and export workspace data",
    "items:write": "Create and edit tasks",
    "items:delete": "Delete tasks and attachments",
    "comments:manage": "Delete any comment in the workspace",
    "structure:write": "Manage projects, folders, lists, and fields",
    "members:manage": "Add, remove, and change member roles",
    "roles:manage": "Create roles and change permissions",
    "workspace:manage": "Change workspace settings",
    "agent:use": "Use the optional workspace assistant",
  };
  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    setBusy(true);
    setError("");
    try {
      await api(
        `${base}/roles${role ? `/${role.id}` : ""}`,
        role ? "PATCH" : "POST",
        { name, permissions: selected },
      );
      onSaved();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={role ? `Edit ${role.name}` : "Create a role"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <ErrorNotice error={error} />
      <form className="stack" onSubmit={save}>
        <label>
          Role name
          <input
            autoFocus
            name="name"
            required
            maxLength={80}
            defaultValue={role?.name || ""}
          />
        </label>
        <fieldset className="permissions">
          <legend>Permissions</legend>
          {permissions.map((permission) => (
            <label key={permission}>
              <input
                type="checkbox"
                checked={selected.includes(permission)}
                onChange={(e) =>
                  setSelected((current) =>
                    e.target.checked
                      ? [...current, permission]
                      : current.filter((p) => p !== permission),
                  )
                }
              />
              <span>
                <strong>{permission}</strong>
                <small>{descriptions[permission]}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <button className="primary" disabled={busy}>
          {busy ? "Saving..." : "Save role"}
        </button>
      </form>
    </Modal>
  );
}
