import { test, expect, type Page } from "@playwright/test";
import { permissions, type Detail, type Item } from "../src/lib/api";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
async function workspaces(page: Page, access: string[] = [...permissions]) {
  const user = {
    id: "user",
    name: "Workspace member",
    email: "member@example.test",
    isAdmin: false,
  };
  const details = [firstId, secondId].map((id, index): Detail => {
    const role = {
      id: `role-${id}`,
      name: "Scoped manager",
      permissions: access,
      isOwner: false,
    };
    return {
      workspace: {
        id,
        name: index === 0 ? "First workspace" : "Second workspace",
      },
      role,
      permissions: access,
      nodes:
        access.includes("items:read") || access.includes("structure:write")
          ? [
              {
                id: `project-${id}`,
                name: "Project",
                kind: "project",
                parentId: null,
              },
              {
                id: `list-${id}`,
                name: "List",
                kind: "list",
                parentId: `project-${id}`,
              },
            ]
          : [],
      fields: [],
      members:
        access.includes("items:read") || access.includes("members:manage")
          ? [
              {
                userId: user.id,
                name: index === 0 ? "First colleague" : "Second colleague",
                email:
                  index === 0 ? "first@example.test" : "second@example.test",
                roleId: role.id,
                disabled: false,
              },
            ]
          : [],
      roles: [role],
    };
  });
  const requests: {
    path: string;
    method: string;
    body?: Record<string, unknown>;
  }[] = [];
  const errors: string[] = [];
  const holds = new Map<string, { started: () => void; wait: Promise<void> }>();
  function hold(path: string, method = "GET") {
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    holds.set(`${method} ${path}`, { started, wait });
    return { requested, release };
  }
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const method = route.request().method();
    const body = route.request().postDataJSON() as Record<
      string,
      unknown
    > | null;
    requests.push({ path, method, ...(body ? { body } : {}) });
    const delay = holds.get(`${method} ${path}`);
    if (delay) {
      holds.delete(`${method} ${path}`);
      delay.started();
      await delay.wait;
    }
    if (path === "/config") return route.fulfill({ json: { aiEnabled: true } });
    if (path === "/auth/me") return route.fulfill({ json: user });
    if (path === "/auth/tokens") return route.fulfill({ json: [] });
    if (path === "/workspaces")
      return route.fulfill({ json: details.map((d) => d.workspace) });
    const detail = details.find((d) =>
      path.startsWith(`/workspaces/${d.workspace.id}`),
    );
    if (!detail)
      return route.fulfill({
        status: 404,
        json: { error: "Unknown test route" },
      });
    const suffix = path.slice(`/workspaces/${detail.workspace.id}`.length);
    if (!suffix) {
      if (method === "PATCH") {
        detail.workspace.name = String(body!.name);
        return route.fulfill({ json: detail.workspace });
      }
      return route.fulfill({ json: detail });
    }
    if (suffix === "/items/page") {
      if (!access.includes("items:read"))
        return route.fulfill({
          status: 403,
          json: { error: "Task read denied" },
        });
      const item: Item = {
        id: `task-${detail.workspace.id}`,
        workspaceId: detail.workspace.id,
        nodeId: detail.nodes[1].id,
        title: `${detail.workspace.name} task`,
        description: "",
        status: "todo",
        priority: "none",
        tags: [],
        customFields: {},
        startDate: null,
        dueDate: null,
        assigneeId: null,
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
      };
      return route.fulfill({ json: { items: [item], nextCursor: null } });
    }
    if (suffix === "/roles" && method === "POST")
      detail.roles.push({
        id: "new-role",
        name: String(body!.name),
        permissions: body!.permissions as string[],
        isOwner: false,
      });
    else if (suffix === "/members" && method === "POST")
      detail.members.push({
        userId: "new-member",
        name: "Added colleague",
        email: String(body!.email),
        roleId: String(body!.roleId),
        disabled: false,
      });
    else if (suffix === "/fields" && method === "POST")
      detail.fields.push({
        id: "new-field",
        name: String(body!.name),
        type: "text",
      });
    else
      return route.fulfill({
        status: 404,
        json: { error: "Unknown test mutation" },
      });
    await route.fulfill({ json: { success: true } });
  });
  return { requests, errors, hold };
}

for (const permission of [
  "workspace:manage",
  "members:manage",
  "roles:manage",
  "structure:write",
]) {
  test(`${permission} without task read can bootstrap and use its settings`, async ({
    page,
  }) => {
    const { requests, errors } = await workspaces(page, [permission]);
    await page.goto("/app");
    await expect(
      page.getByRole("heading", {
        name: "Task access is not included in your role",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /New task|Create a task|Assistant/ }),
    ).toHaveCount(0);
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(
      page.getByText(
        /0 complete|0 tasks in this view|Your next step starts here/,
      ),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "Open workspace settings" }).click();
    await expect(page.getByText("Your role: Scoped manager")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Download workspace JSON" }),
    ).toHaveCount(0);
    if (permission === "workspace:manage") {
      await page
        .getByLabel("Name", { exact: true })
        .fill("Renamed without task read");
      await page.getByRole("button", { name: "Rename workspace" }).click();
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
        "Renamed without task read",
      );
    } else if (permission === "members:manage") {
      await page.getByLabel("Existing user's email").fill("new@example.test");
      await page
        .getByRole("combobox", { name: "Role", exact: true })
        .selectOption(`role-${firstId}`);
      await page
        .getByRole("button", { name: "Add member", exact: true })
        .click();
      await expect(
        page.getByText("Added colleague", { exact: true }),
      ).toBeVisible();
    } else if (permission === "roles:manage") {
      await page.getByRole("button", { name: "Create role" }).click();
      await page.getByLabel("Role name").fill("New scoped role");
      await page.getByRole("button", { name: "Save role" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.getByText("New scoped role", { exact: true }),
      ).toBeVisible();
    } else {
      await page.getByLabel("Field name").fill("New scoped field");
      await page.getByRole("button", { name: "Create field" }).click();
      await expect(
        page.getByText("New scoped field", { exact: true }),
      ).toBeVisible();
    }
    expect(
      requests.some((request) => /\/items(?:\/|$)/.test(request.path)),
    ).toBe(false);
    expect(requests.some((request) => request.method !== "GET")).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("workspace rename persists in both options after switching workspaces", async ({
  page,
}) => {
  const { errors } = await workspaces(page);
  await page.goto("/settings");
  const selection = page.getByRole("combobox", { name: "Selected workspace" });
  await page
    .getByLabel("Name", { exact: true })
    .fill("Renamed first workspace");
  await page.getByRole("button", { name: "Rename workspace" }).click();
  await expect(selection.locator(`option[value="${firstId}"]`)).toHaveText(
    "Renamed first workspace",
  );
  await selection.selectOption(secondId);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Second workspace",
  );
  await expect(selection.locator(`option[value="${firstId}"]`)).toHaveText(
    "Renamed first workspace",
  );
  await selection.selectOption(firstId);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Renamed first workspace",
  );
  await expect(selection.locator(`option[value="${secondId}"]`)).toHaveText(
    "Second workspace",
  );
  expect(errors).toEqual([]);
});

test("write and agent permissions without task read do not expose task actions", async ({
  page,
}) => {
  const { requests, errors } = await workspaces(page, [
    "items:write",
    "structure:write",
    "agent:use",
  ]);
  await page.goto("/app");
  await expect(
    page.getByRole("heading", {
      name: "Task access is not included in your role",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /New task|Create a task|Assistant/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add project, folder, or list" }),
  ).toBeVisible();
  expect(requests.some((request) => /\/items(?:\/|$)/.test(request.path))).toBe(
    false,
  );
  expect(errors).toEqual([]);
});

test("in-flight rename updates only its own option after a workspace switch", async ({
  page,
}) => {
  const { errors, hold } = await workspaces(page);
  await page.goto("/settings");
  const pending = hold(`/workspaces/${firstId}`, "PATCH");
  await page
    .getByLabel("Name", { exact: true })
    .fill("First renamed asynchronously");
  await page.getByRole("button", { name: "Rename workspace" }).click();
  await pending.requested;
  const selection = page.getByRole("combobox", { name: "Selected workspace" });
  await selection.selectOption(secondId);
  await expect(
    page.getByText("Second colleague", { exact: true }),
  ).toBeVisible();
  pending.release();
  await expect(selection.locator(`option[value="${firstId}"]`)).toHaveText(
    "First renamed asynchronously",
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Second workspace",
  );
  await expect(page.getByText("First colleague", { exact: true })).toHaveCount(
    0,
  );
  expect(errors).toEqual([]);
});

for (const path of ["/app", "/settings"]) {
  test(`${path} ignores late metadata from a previously selected workspace`, async ({
    page,
  }) => {
    const { errors, hold } = await workspaces(page);
    await page.goto(path);
    const selection = page.getByRole("combobox", {
      name: path === "/app" ? "WORKSPACE" : "Selected workspace",
      exact: true,
    });
    const current = page.getByText(
      path === "/app" ? "First workspace task" : "First colleague",
      { exact: true },
    );
    await expect(current).toBeVisible();
    const pending = hold(`/workspaces/${secondId}`);
    await selection.selectOption(secondId);
    await pending.requested;
    await expect(current).toHaveCount(0);
    await selection.selectOption(firstId);
    await expect(current).toBeVisible();
    pending.release();
    await expect(selection).toHaveValue(firstId);
    await expect(
      page.getByText(
        path === "/app" ? "Second workspace task" : "Second colleague",
        { exact: true },
      ),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
