export type User = {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  disabled?: boolean;
};
export type Config = {
  landingEnabled: boolean;
  logo?: string;
  registrationEnabled: boolean;
  setupRequired: boolean;
  ssoEnabled: boolean;
  aiEnabled: boolean;
  passwordResetEnabled: boolean;
};
export type WebhookEvent =
  | "item.created"
  | "item.updated"
  | "item.deleted"
  | "node.created"
  | "node.updated"
  | "node.deleted"
  | "field.changed";
export const webhookEvents: { id: WebhookEvent; label: string }[] = [
  { id: "item.created", label: "Task created" },
  { id: "item.updated", label: "Task updated" },
  { id: "item.deleted", label: "Task deleted" },
  { id: "node.created", label: "Project/folder/list created" },
  { id: "node.updated", label: "Project/folder/list updated" },
  { id: "node.deleted", label: "Project/folder/list deleted" },
  { id: "field.changed", label: "Field definition changed" },
];
export type Webhook = {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  secret?: string;
};
export type AutomationProvider = "webhook" | "email" | "http" | "log";
export type AutomationAction = {
  // Keep this open to render automations created by a provider no longer
  // available in the current frontend without silently rewriting the step.
  type: AutomationProvider | (string & {});
  config: Record<string, unknown>;
};
export type Automation = {
  id: string;
  workspaceId: string;
  name: string;
  event: WebhookEvent;
  version: number;
  steps: AutomationAction[];
  action?: AutomationAction;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
export type AutomationStepRun = {
  id: string;
  stepId: string;
  position: number;
  type: AutomationAction["type"];
  status: "pending" | "running" | "delivered" | "failed" | "skipped";
  output: string;
  log: string;
  startedAt: string | null;
  completedAt: string | null;
};
export type AutomationRun = {
  id: string;
  workspaceId: string;
  automationId: string | null;
  targetType: "automation" | "webhook";
  targetId: string;
  automationVersion: number | null;
  status: "pending" | "running" | "delivered" | "failed";
  detail: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  steps: AutomationStepRun[];
};
export type SiteSettings = {
  landingDisabled: boolean;
  mcpSseEnabled: boolean;
  logo: { updatedAt: string; url: string } | null;
};
export type OidcIdentity = {
  id: string;
  userId: string;
  issuer: string;
  subject: string;
  createdAt: string;
};
export const statuses = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
] as const;
export const priorities = ["none", "low", "medium", "high", "urgent"] as const;
export const nodeIcons = ["diamond", "briefcase", "target", "folder", "archive", "bookmark", "list", "checklist", "calendar", "flag"] as const;
export const nodeColors = ["slate", "orange", "amber", "green", "teal", "blue", "violet", "rose"] as const;
export const permissions = [
  "items:read",
  "items:write",
  "items:delete",
  "comments:manage",
  "structure:write",
  "members:manage",
  "roles:manage",
  "workspace:manage",
  "agent:use",
] as const;
export type Workspace = { id: string; name: string };
export type Role = {
  id: string;
  name: string;
  permissions: string[];
  isOwner: boolean;
};
export type Member = {
  userId: string;
  name: string;
  email: string;
  roleId: string;
  disabled: boolean;
};
export type TreeNode = {
  id: string;
  name: string;
  description?: string;
  kind: "project" | "folder" | "list";
  parentId: string | null;
  icon?: (typeof nodeIcons)[number] | null;
  color?: (typeof nodeColors)[number] | null;
};
export type Field = {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "datetime" | "checklist" | "rating" | "checkbox" | "select" | "formula";
  options?: string[];
  settings?: { dateFormat?: DateFormat; maxRating?: number; formula?: string };
};
export type DateFormat = "yyyy-MM-dd" | "MMM d, yyyy" | "MMMM d, yyyy" | "dd/MM/yyyy";
export type ProjectStatus = { id: string; name: string; color: string; completed: boolean };
export type BuiltInField = "priority" | "startDate" | "tags" | "description" | "nodeId" | "createdAt" | "updatedAt";
export type ListViewSettings = {
  view: "list";
  projectId: string | null;
  columnOrder: string[];
  hiddenColumns: string[];
  sort: { column: string; direction: "asc" | "desc" } | null;
  updatedAt: string | null;
};
export type ProjectFieldConfiguration = {
  projectId: string;
  fieldIds: string[];
  builtInFields: BuiltInField[];
  updatedAt: string;
  statuses?: ProjectStatus[];
  dateFormat?: DateFormat;
};
export type ListStatusConfiguration = {
  listId: string;
  statuses?: ProjectStatus[];
  updatedAt: string;
  inheritedProjectUpdatedAt?: string;
};
export type ListTagColorConfiguration = { listId: string; colors: Record<string, string>; updatedAt: string };
export type Detail = {
  workspace: Workspace;
  role: Role;
  permissions: string[];
  members: Member[];
  roles: Role[];
  nodes: TreeNode[];
  fields: Field[];
  projectFields?: ProjectFieldConfiguration[];
  listStatusConfigs?: ListStatusConfiguration[];
  listTagColorConfigs?: ListTagColorConfiguration[];
};
export type ChecklistEntry = { id: string; text: string; done: boolean };
export type Item = {
  id: string;
  workspaceId: string;
  nodeId: string;
  title: string;
  description: string;
  status: string;
  priority: (typeof priorities)[number];
  startDate: string | null;
  dueDate: string | null;
  tags: string[];
  customFields: Record<string, string | number | boolean | null | string[]>;
  assigneeId: string | null;
  checklist?: ChecklistEntry[];
  parentId?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};
export type ItemInput = Omit<
  Item,
  "id" | "workspaceId" | "createdAt" | "updatedAt"
>;
export type Comment = {
  id: string;
  workspaceId: string;
  itemId: string;
  authorId: string | null;
  authorName: string;
  body: string;
  parentId: string | null;
  reactions: { emoji: string; count: number; reactedByMe: boolean }[];
  createdAt: string;
  deletedAt: string | null;
};
export type Notification = {
  id: string;
  workspaceId: string;
  type: "assignment" | "mention";
  itemId: string;
  itemTitle: string;
  commentId: string | null;
  actorId: string | null;
  actorName: string;
  createdAt: string;
  readAt: string | null;
};
export type Proposal = {
  title: string;
  description?: string;
  nodeId?: string;
  dueDate?: string;
  priority?: Item["priority"];
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    signal,
    headers:
      body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(
      "The server returned an unexpected response. Please try again.",
      response.status,
    );
  }
  if (!response.ok)
    throw new ApiError(
      typeof data === "object" && data && "error" in data
        ? String(data.error)
        : `Request failed (${response.status}).`,
      response.status,
    );
  return data as T;
}
export function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
export function label(value: string) {
  if (value === "select") return "Dropdown";
  return value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}
export function workspacePath(id: string) {
  return `/workspaces/${encodeURIComponent(id)}`;
}
export { evaluateFormula, type FormulaValue } from "./formula";
export async function loadWorkspaceItems(
  wid: string,
  signal: AbortSignal,
  onProgress?: (count: number) => void,
): Promise<Item[]> {
  const items: Item[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const query = new URLSearchParams({ limit: "200" });
    if (cursor !== null) query.set("cursor", cursor);
    const page = await api<{ items: Item[]; nextCursor: string | null }>(
      `${workspacePath(wid)}/items/page?${query}`,
      "GET",
      undefined,
      signal,
    );
    signal.throwIfAborted();
    if (
      !page ||
      !Array.isArray(page.items) ||
      !(
        page.nextCursor === null ||
        (typeof page.nextCursor === "string" && page.nextCursor.length > 0)
      )
    )
      throw new Error("Invalid task page response. Please retry loading.");
    if (page.nextCursor !== null && cursors.has(page.nextCursor))
      throw new Error("Task pagination cursor repeated. Please retry loading.");
    for (const item of page.items) {
      if (!item || typeof item.id !== "string" || !item.id)
        throw new Error("Invalid task in page response. Please retry loading.");
      if (item.workspaceId !== wid)
        throw new Error(
          "Task page contains an unexpected workspace. Please retry loading.",
        );
      if (ids.has(item.id))
        throw new Error(
          "Task pages contain a duplicate task ID. Please retry loading.",
        );
      ids.add(item.id);
      items.push(item);
    }
    cursor = page.nextCursor;
    if (cursor !== null) cursors.add(cursor);
    onProgress?.(items.length);
  } while (cursor !== null);
  signal.throwIfAborted();
  return items;
}
export type ImportFormat = "csv" | "json";
export type ImportPayload = {
  nodeId: string;
  format: ImportFormat;
  data: string;
};
export type ImportResult = { imported?: number; count?: number };
