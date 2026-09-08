import type { Page } from "@playwright/test";
import { permissions, type Detail, type Item } from "../src/lib/api";

// Test-only contract fixtures. The application itself never inserts sample data.
export const wid = "11111111-1111-4111-8111-111111111111";
export const listId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
export const user = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Test Owner",
  email: "owner@example.test",
  isAdmin: true,
};
const role = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Owner",
  permissions: [...permissions],
  isOwner: true,
};
export const detail: Detail = {
  workspace: { id: wid, name: "Contract test space" },
  role,
  permissions: [...permissions],
  members: [{ ...user, userId: user.id, roleId: role.id, disabled: false }],
  roles: [role],
  nodes: [
    { id: projectId, name: "Test project", kind: "project", parentId: null },
    { id: listId, name: "Test list", kind: "list", parentId: projectId },
  ],
  fields: [
    { id: "effort", name: "Effort", type: "number" },
    { id: "approved", name: "Approved", type: "checkbox" },
    {
      id: "category",
      name: "Category",
      type: "select",
      options: ["One", "Two"],
    },
  ],
};
export const task: Item = {
  id: "66666666-6666-4666-8666-666666666666",
  workspaceId: wid,
  nodeId: listId,
  title: "Verify the release",
  description: "Browser contract verification",
  status: "todo",
  priority: "high",
  startDate: "2026-09-03",
  dueDate: "2026-09-08",
  tags: ["verification"],
  customFields: { effort: 3, approved: false, category: "One" },
  assigneeId: user.id,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};
export async function fixture(
  page: Page,
  options: {
    authenticated?: boolean;
    setup?: boolean;
    items?: Item[];
    fields?: Detail["fields"];
  } = {},
) {
  let authenticated = options.authenticated !== false;
  const mutations: {
    path: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  let items = structuredClone(options.items ?? [task]);
  let attachments: {
    id: string;
    name: string;
    contentType: string;
    size: number;
  }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const method = request.method();
    const body =
      method === "GET" || method === "DELETE"
        ? {}
        : (request.postDataJSON() as Record<string, unknown>);
    if (method !== "GET") mutations.push({ path, method, body });
    let result: unknown;
    if (path === "/config")
      result = {
        landingEnabled: true,
        registrationEnabled: true,
        setupRequired: !!options.setup,
        ssoEnabled: true,
        aiEnabled: true,
        passwordResetEnabled: true,
      };
    else if (path === "/auth/me") {
      if (!authenticated)
        return route.fulfill({
          status: 401,
          json: { error: "Sign in required" },
        });
      result = user;
    } else if (path === "/auth/setup" || path === "/auth/login") {
      authenticated = true;
      result = user;
    } else if (path === "/workspaces") result = [detail.workspace];
    else if (path === `/workspaces/${wid}`)
      result = { ...detail, fields: options.fields ?? detail.fields };
    else if (path === `/workspaces/${wid}/agent`)
      result = {
        reply: "Here is a task suggestion to review.",
        proposal: {
          title: "Review this suggestion",
          description: "Not created yet.",
          nodeId: listId,
          dueDate: "2026-09-10",
          priority: "medium",
        },
      };
    else if (path.endsWith("/attachments") && method === "GET")
      result = attachments;
    else if (path.endsWith("/attachments") && method === "POST") {
      const attachment = {
        id: "attachment-1",
        name: String(body.name),
        contentType: String(body.contentType),
        size: 5,
      };
      attachments.push(attachment);
      result = attachment;
    } else if (path.includes("/attachments/") && method === "DELETE") {
      attachments = [];
      result = { success: true };
    } else if (path === `/workspaces/${wid}/items/page` && method === "GET") {
      const query = new URL(request.url()).searchParams;
      const offset = Number(query.get("cursor") || 0);
      const limit = Number(query.get("limit") || 200);
      result = {
        items: items.slice(offset, offset + limit),
        nextCursor:
          offset + limit < items.length ? String(offset + limit) : null,
      };
    } else if (path === `/workspaces/${wid}/items` && method === "POST") {
      const created = { ...task, ...body, id: `new-${items.length}` } as Item;
      items.push(created);
      result = created;
    } else if (
      path.startsWith(`/workspaces/${wid}/items/`) &&
      method === "PATCH"
    ) {
      items = items.map((i) =>
        path.endsWith(i.id) ? ({ ...i, ...body } as Item) : i,
      );
      result = items.find((i) => path.endsWith(i.id));
    } else if (
      path.startsWith(`/workspaces/${wid}/items/`) &&
      method === "DELETE"
    ) {
      items = items.filter((i) => !path.endsWith(i.id));
      result = { success: true };
    } else if (path === "/auth/tokens") result = [];
    else if (path === "/admin/users") result = [user];
    else if (path === "/admin/status")
      result = {
        status: "ok",
        database: "sqlite",
        users: 1,
        migrations: [{ name: "001_initial.sql" }],
      };
    else if (path === "/admin/audit")
      result = [
        {
          id: "audit-1",
          action: "item.create",
          actorId: user.id,
          workspaceId: wid,
          resourceId: task.id,
          createdAt: task.createdAt,
          details: {},
        },
      ];
    else
      return route.fulfill({
        status: 404,
        json: { error: `Unhandled test route: ${method} ${path}` },
      });
    await route.fulfill({ json: result });
  });
  return { mutations, errors };
}
