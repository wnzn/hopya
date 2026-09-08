import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import type { Detail, Item, TreeNode } from "../src/lib/api";
import { detail, fixture, listId, task, wid } from "./fixture";

const sourceId = detail.nodes[0].id;
const destinationId = "destination";
const folderId = "folder";
const nestedId = "nested";
const targetId = "target";
const secondId = "second-workspace";

async function hierarchy(page: Page, access = detail.permissions) {
  const base = await fixture(page);
  const state: Detail = structuredClone(detail);
  const items = [structuredClone(task)];
  state.permissions = [...access];
  state.nodes.push(
    { id: nestedId, name: "Nested", kind: "folder", parentId: folderId },
    { id: folderId, name: "Shared", kind: "folder", parentId: sourceId },
    { id: destinationId, name: "Destination", kind: "project", parentId: null },
    { id: targetId, name: "Shared", kind: "folder", parentId: destinationId },
  );
  const second: Detail = {
    ...structuredClone(state),
    workspace: { id: secondId, name: "Other workspace" },
    nodes: [
      {
        id: "foreign-project",
        name: "Foreign project",
        kind: "project",
        parentId: null,
      },
      {
        id: "foreign-list",
        name: "Foreign list",
        kind: "list",
        parentId: "foreign-project",
      },
    ],
  };
  const patches: { id: string; body: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  await page.route("**/api/v1/workspaces", (route) =>
    route.fulfill({ json: [state.workspace, second.workspace] }),
  );
  await page.route("**/api/v1/workspaces/*", (route) => {
    const current = route.request().url().endsWith(wid) ? state : second;
    return route.fulfill({
      json: {
        ...current,
        nodes: current.permissions.some(
          (p) => p === "items:read" || p === "structure:write",
        )
          ? current.nodes
          : [],
      },
    });
  });
  await page.route("**/api/v1/workspaces/*/items", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      base.mutations.push({
        path: `/workspaces/${wid}/items`,
        method: "POST",
        body,
      });
      const created = {
        ...task,
        ...body,
        id: `created-${items.length}`,
      } as Item;
      items.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    reads.push(route.request().url());
    return route.fulfill({
      json: route.request().url().includes(wid) ? items : [],
    });
  });
  await page.route("**/api/v1/workspaces/*/items/page?*", (route) => {
    reads.push(route.request().url());
    return route.fulfill({
      json: {
        items: route.request().url().includes(wid) ? items : [],
        nextCursor: null,
      },
    });
  });
  await page.route(`**/api/v1/workspaces/${wid}/nodes`, (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON() as Record<string, unknown>;
    base.mutations.push({
      path: `/workspaces/${wid}/nodes`,
      method: "POST",
      body,
    });
    const created = {
      ...body,
      id: `created-node-${state.nodes.length}`,
    } as TreeNode;
    state.nodes.push(created);
    return route.fulfill({ status: 201, json: created });
  });
  await page.route(`**/api/v1/workspaces/${wid}/nodes/*`, async (route) => {
    expect(route.request().method()).toBe("PATCH");
    const id = route.request().url().split("/").at(-1)!;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    patches.push({ id, body });
    if (!state.permissions.includes("structure:write"))
      return route.fulfill({
        status: 403,
        json: { error: "Structure access denied" },
      });
    const node = state.nodes.find((n) => n.id === id)!;
    if ("expectedParentId" in body && body.expectedParentId !== node.parentId)
      return route.fulfill({
        status: 409,
        json: { error: "Location changed; reload before moving" },
      });
    if ("name" in body) node.name = String(body.name);
    if ("parentId" in body) node.parentId = String(body.parentId);
    await route.fulfill({ json: node });
  });
  return { ...base, state, second, patches, reads, items };
}

for (const width of [1280, 320]) {
  test(`list move updates active project filtering and is keyboard accessible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { patches, errors, state } = await hierarchy(page);
    await page.goto("/app");
    if (width === 320)
      await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByTitle("project: Test project", { exact: true }).click();
    const taskButton = page.getByRole("button", {
      name: task.title,
      exact: true,
    });
    await expect(taskButton).toBeVisible();
    const opener = page.getByRole("button", { name: "Manage Test list" });
    if (width === 320)
      await page.getByRole("button", { name: "Menu", exact: true }).click();
    await opener.focus();
    await page.keyboard.press("Enter");
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    await expect(name).toBeFocused();
    const parent = page.getByRole("combobox", {
      name: "Parent project or folder",
    });
    await expect(parent).toHaveValue(sourceId);
    await page.keyboard.press("Tab");
    await expect(parent).toBeFocused();
    // Native select type-ahead chooses Destination without a pointer.
    await page.keyboard.press("d");
    await expect(parent).toHaveValue(destinationId);
    await expect(
      page.getByText(
        "Moving keeps all contents and the same workspace permissions.",
      ),
    ).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
      .analyze();
    expect(results.violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const dialog = page.getByRole("dialog");
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Delete empty list" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Save changes" }),
    ).toBeFocused();
    state.nodes.find((n) => n.id === listId)!.name =
      "Concurrently renamed list";
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Test project", exact: true }),
    ).toBeVisible();
    await expect(taskButton).toHaveCount(0);
    expect(patches).toEqual([
      {
        id: listId,
        body: { parentId: destinationId, expectedParentId: sourceId },
      },
    ]);
    await page.getByTitle("project: Destination", { exact: true }).click();
    await expect(taskButton).toBeVisible();
    await page.reload();
    if (width === 320)
      await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page
      .getByRole("button", { name: "Manage Concurrently renamed list" })
      .click();
    await expect(parent).toHaveValue(destinationId);
    expect(errors).toEqual([]);
  });
}

test("populated folder subtree travels and cannot target itself or any descendant", async ({
  page,
}) => {
  const { state, patches, errors } = await hierarchy(page);
  state.nodes.find((n) => n.id === listId)!.parentId = nestedId;
  const before = structuredClone(state.nodes);
  await page.goto("/app");
  await page.getByTitle("project: Test project", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: task.title, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Manage Shared", exact: true })
    .first()
    .click();
  const parent = page.getByRole("combobox", {
    name: "Parent project or folder",
  });
  await expect(parent).toHaveValue(sourceId);
  expect(
    await parent
      .locator("option")
      .evaluateAll((options) =>
        options.map((o) => (o as HTMLOptionElement).value),
      ),
  ).toEqual(["", sourceId, destinationId, targetId]);
  await parent.selectOption(targetId);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: task.title, exact: true }),
  ).toHaveCount(0);
  await page.getByTitle("project: Destination", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: task.title, exact: true }),
  ).toBeVisible();
  expect(state.nodes).toEqual(
    before.map((n) => (n.id === folderId ? { ...n, parentId: targetId } : n)),
  );
  expect(patches).toEqual([
    { id: folderId, body: { parentId: targetId, expectedParentId: sourceId } },
  ]);
  expect(errors).toEqual([]);
});

test("parent paths disambiguate names and only use the current workspace detail", async ({
  page,
}) => {
  const { patches, errors, state } = await hierarchy(page);
  state.nodes.push({
    id: "duplicate",
    name: "Shared",
    kind: "folder",
    parentId: sourceId,
  });
  await page.goto("/app");
  await page.getByRole("button", { name: "Manage Test list" }).click();
  const parent = page.getByRole("combobox", {
    name: "Parent project or folder",
  });
  await expect(parent.locator(`option[value="${folderId}"]`)).toHaveText(
    `Test project / Shared (folder) [${folderId}]`,
  );
  await expect(parent.locator('option[value="duplicate"]')).toHaveText(
    "Test project / Shared (folder) [duplicate]",
  );
  await expect(parent.locator(`option[value="${targetId}"]`)).toHaveText(
    "Destination / Shared (folder)",
  );
  await expect(parent.locator('option[value="foreign-project"]')).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("combobox", { name: "WORKSPACE", exact: true })
    .selectOption(secondId);
  await page.getByRole("button", { name: "Manage Foreign list" }).click();
  await expect(parent).toHaveValue("foreign-project");
  await expect(parent.locator("option")).toHaveText([
    "Choose a parent",
    "Foreign project (project)",
  ]);
  expect(patches).toEqual([]);
  expect(errors).toEqual([]);
});

test("long parent ancestry fits a 320px move dialog", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const { state, errors } = await hierarchy(page);
  let parentId = destinationId;
  for (let depth = 1; depth <= 5; depth++) {
    const id = `long-${depth}`;
    state.nodes.push({
      id,
      name: `Level ${depth} ${"longname".repeat(14)}`,
      kind: "folder",
      parentId,
    });
    parentId = id;
  }
  await page.goto("/app");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "Manage Test list" }).click();
  const parent = page.getByRole("combobox", {
    name: "Parent project or folder",
  });
  await parent.selectOption(parentId);
  await expect(parent.locator(`option[value="${parentId}"]`)).toContainText(
    "Destination / Level 1",
  );
  await expect(parent.locator(`option[value="${parentId}"]`)).toContainText(
    "Level 5",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .getByRole("dialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeInViewport();
  expect(errors).toEqual([]);
});

test("projects stay at root and rename without any parent fields", async ({
  page,
}) => {
  const { patches, state } = await hierarchy(page);
  await page.goto("/app");
  await page.getByRole("button", { name: "Manage Test project" }).click();
  await expect(
    page.getByRole("combobox", { name: "Parent project or folder" }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Renamed project");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(patches).toEqual([
    { id: sourceId, body: { name: "Renamed project" } },
  ]);
  expect(state.nodes[0].parentId).toBeNull();
  await page
    .getByRole("button", { name: "Add project, folder, or list" })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Type", exact: true }),
  ).toHaveValue("project");
  await expect(
    page.getByRole("combobox", { name: "Parent project or folder" }),
  ).toHaveCount(0);
});

test("no-op closes without PATCH and rename does not undo a concurrent move", async ({
  page,
}) => {
  const { patches, state } = await hierarchy(page);
  await page.goto("/app");
  await page.getByRole("button", { name: "Manage Test list" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(patches).toEqual([]);
  await page.getByRole("button", { name: "Manage Test list" }).click();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("   ");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toContainText("Enter a name");
  expect(patches).toEqual([]);
  state.nodes.find((n) => n.id === listId)!.parentId = destinationId;
  await name.fill("Renamed list");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(patches).toEqual([{ id: listId, body: { name: "Renamed list" } }]);
  await page.getByRole("button", { name: "Manage Renamed list" }).click();
  await expect(
    page.getByRole("combobox", { name: "Parent project or folder" }),
  ).toHaveValue(destinationId);
});

test("rename and move submit exactly the three changed/conditional fields", async ({
  page,
}) => {
  const { patches } = await hierarchy(page);
  await page.goto("/app");
  await page.getByRole("button", { name: "Manage Test list" }).click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Moved list");
  await page
    .getByRole("combobox", { name: "Parent project or folder" })
    .selectOption(targetId);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(patches).toEqual([
    {
      id: listId,
      body: {
        name: "Moved list",
        parentId: targetId,
        expectedParentId: sourceId,
      },
    },
  ]);
});

test("stale move retains both drafts and never silently retries or overwrites", async ({
  page,
}) => {
  const { state, patches } = await hierarchy(page);
  await page.goto("/app");
  await page.getByRole("button", { name: "Manage Test list" }).click();
  state.nodes.find((n) => n.id === listId)!.parentId = folderId;
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  const parent = page.getByRole("combobox", {
    name: "Parent project or folder",
  });
  await name.fill("My retained draft");
  await parent.selectOption(targetId);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "cancel and reload the page",
    );
    await expect(name).toHaveValue("My retained draft");
    await expect(parent).toHaveValue(targetId);
    expect(patches).toHaveLength(attempt);
    expect(patches.at(-1)?.body).toEqual({
      name: "My retained draft",
      parentId: targetId,
      expectedParentId: sourceId,
    });
    expect(state.nodes.find((n) => n.id === listId)).toMatchObject({
      name: "Test list",
      parentId: folderId,
    });
  }
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Manage Test list" }).click();
  await expect(parent).toHaveValue(folderId);
  await parent.selectOption(targetId);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(patches.at(-1)?.body).toEqual({
    parentId: targetId,
    expectedParentId: folderId,
  });
});

for (const status of [400, 403]) {
  test(`move ${status} retains draft without a success refresh`, async ({
    page,
  }) => {
    await hierarchy(page);
    const error =
      status === 400
        ? "Moving this subtree would exceed the hierarchy depth limit"
        : "Structure access denied";
    await page.route(`**/api/v1/workspaces/${wid}/nodes/*`, (route) =>
      route.fulfill({ status, json: { error } }),
    );
    await page.goto("/app");
    await page.getByRole("button", { name: "Manage Test list" }).click();
    const parent = page.getByRole("combobox", {
      name: "Parent project or folder",
    });
    await parent.selectOption(targetId);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert")).toHaveText(error);
    await expect(parent).toHaveValue(targetId);
    await expect(
      page.getByRole("button", { name: "Save changes" }),
    ).toBeEnabled();
  });
}

for (const access of [["items:read"], ["items:write"], []]) {
  test(`role with ${access.join() || "no permissions"} cannot manage hierarchy`, async ({
    page,
  }) => {
    const { patches, reads } = await hierarchy(page, access);
    await page.goto("/app");
    await expect(
      page.getByRole("heading", {
        name: access.includes("items:read")
          ? "All tasks"
          : "Task access is not included in your role",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /^Manage |Add project, folder, or list/,
      }),
    ).toHaveCount(0);
    expect(patches).toEqual([]);
    if (!access.includes("items:read")) expect(reads).toEqual([]);
  });
}

test("structure-only manager can move without reading tasks", async ({
  page,
}) => {
  const { patches, reads } = await hierarchy(page, ["structure:write"]);
  await page.goto("/app");
  await page.getByRole("button", { name: "Manage Test list" }).click();
  await page
    .getByRole("combobox", { name: "Parent project or folder" })
    .selectOption(targetId);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "Task access is not included in your role",
    }),
  ).toBeVisible();
  expect(patches).toEqual([
    { id: listId, body: { parentId: targetId, expectedParentId: sourceId } },
  ]);
  expect(reads).toEqual([]);
});

test("ordinary creation uses descendant lists for project, nested folder and list selections", async ({
  page,
}) => {
  const { state, mutations, errors } = await hierarchy(page);
  state.nodes.push(
    {
      id: "destination-nested",
      name: "Destination nested",
      kind: "folder",
      parentId: targetId,
    },
    {
      id: "destination-list",
      name: "Destination list",
      kind: "list",
      parentId: "destination-nested",
    },
  );
  await page.goto("/app");
  for (const [index, selection] of [
    "project: Destination",
    "folder: Destination nested",
    "list: Destination list",
  ].entries()) {
    await page.getByTitle(selection, { exact: true }).click();
    await page
      .getByRole("button", {
        name: "+ New task",
        exact: true,
      })
      .click();
    const list = page.getByRole("combobox", { name: "List", exact: true });
    if (selection.startsWith("list:")) await expect(list).toHaveCount(0);
    else await expect(list).toHaveValue("destination-list");
    await page
      .getByLabel("Title", { exact: true })
      .fill(`Scoped task ${index}`);
    await page
      .getByRole("button", { name: "Create task", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `Scoped task ${index}`, exact: true }),
    ).toBeVisible();
    expect(mutations.at(-1)?.body.nodeId).toBe("destination-list");
  }
  await page.getByRole("button", { name: "All tasks 4", exact: true }).click();
  await page.getByRole("button", { name: "+ New task", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "List", exact: true }),
  ).toHaveValue(listId);
  expect(errors).toEqual([]);
});

test("moving the last list out disables source task creation and Add a list here restores scoped creation", async ({
  page,
}) => {
  const { patches, mutations, state, errors } = await hierarchy(page);
  await page.goto("/app");
  await page.getByTitle("project: Test project", { exact: true }).click();
  await page
    .getByRole("button", { name: "Manage Test list", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Parent project or folder" })
    .selectOption(destinationId);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "No lists in this project",
      exact: true,
    }),
  ).toBeVisible();
  const newTask = page.getByRole("button", { name: "+ New task", exact: true });
  await expect(newTask).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Create a task", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: task.title, exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add a list here", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Type", exact: true }),
  ).toHaveValue("list");
  await expect(
    page.getByRole("combobox", { name: "Parent project or folder" }),
  ).toHaveValue(sourceId);
  await page.getByLabel("Name", { exact: true }).fill("Replacement list");
  await page.getByRole("button", { name: "Create list", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations.at(-1)).toEqual({
    path: `/workspaces/${wid}/nodes`,
    method: "POST",
    body: { name: "Replacement list", kind: "list", parentId: sourceId },
  });
  await expect(newTask).toBeEnabled();
  await page
    .getByRole("button", { name: "+ New task", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "List", exact: true }),
  ).toHaveValue(state.nodes.at(-1)!.id);
  expect(patches).toEqual([
    {
      id: listId,
      body: { parentId: destinationId, expectedParentId: sourceId },
    },
  ]);
  expect(mutations.some((mutation) => mutation.path.endsWith("/items"))).toBe(
    false,
  );
  expect(errors).toEqual([]);
});

test("empty nested folder guides keyboard/mobile list creation while global Projects plus still creates a project", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const { mutations, errors } = await hierarchy(page);
  await page.goto("/app");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByTitle("folder: Nested", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "+ New task", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "No lists in this folder", exact: true }),
  ).toBeVisible();
  const add = page.getByRole("button", {
    name: "Add a list here",
    exact: true,
  });
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("combobox", { name: "Type", exact: true }),
  ).toHaveValue("list");
  await expect(
    page.getByRole("combobox", { name: "Parent project or folder" }),
  ).toHaveValue(nestedId);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  expect(results.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel("Name", { exact: true }).fill("Nested tasks");
  await page.getByRole("button", { name: "Create list", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations.at(-1)?.body).toEqual({
    name: "Nested tasks",
    kind: "list",
    parentId: nestedId,
  });
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page
    .getByRole("button", { name: "Add project, folder, or list", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Type", exact: true }),
  ).toHaveValue("project");
  await expect(
    page.getByRole("combobox", { name: "Parent project or folder" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("global Add a list starts with list type and requires an explicit parent", async ({
  page,
}) => {
  const { state } = await hierarchy(page);
  state.nodes = state.nodes.filter((node) => node.kind !== "list");
  await page.goto("/app");
  await page.getByRole("button", { name: "Add a list", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Type", exact: true }),
  ).toHaveValue("list");
  await expect(
    page.getByRole("combobox", { name: "Parent project or folder" }),
  ).toHaveValue("");
});

for (const writable of [false, true]) {
  test(`${writable ? "read/write member" : "viewer"} cannot create into an empty selection or manage its structure`, async ({
    page,
  }) => {
    const { state, mutations, errors } = await hierarchy(
      page,
      writable ? ["items:read", "items:write"] : ["items:read"],
    );
    state.nodes.push({
      id: "destination-list",
      name: "Destination list",
      kind: "list",
      parentId: destinationId,
    });
    await page.goto("/app");
    await page.getByTitle("folder: Nested", { exact: true }).click();
    const newTask = page.getByRole("button", {
      name: "+ New task",
      exact: true,
    });
    if (writable) await expect(newTask).toBeDisabled();
    else await expect(newTask).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Create a task", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Add a list here", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText(/Ask a workspace manager to add a list here/),
    ).toBeVisible();
    await page.getByTitle("project: Destination", { exact: true }).click();
    if (writable) {
      await expect(newTask).toBeEnabled();
      await page
        .getByRole("button", { name: "+ New task", exact: true })
        .click();
      await expect(
        page.getByRole("combobox", { name: "List", exact: true }),
      ).toHaveValue("destination-list");
    } else {
      await expect(newTask).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Create a task", exact: true }),
      ).toHaveCount(0);
    }
    expect(mutations).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("editing a task preserves its actual list rather than the first descendant default", async ({
  page,
}) => {
  const { state, items } = await hierarchy(page);
  state.nodes.push(
    {
      id: "first-descendant",
      name: "First descendant",
      kind: "list",
      parentId: destinationId,
    },
    {
      id: "actual-list",
      name: "Actual list",
      kind: "list",
      parentId: targetId,
    },
  );
  items.push({
    ...task,
    id: "existing-destination-task",
    title: "Existing destination task",
    nodeId: "actual-list",
  });
  await page.goto("/app");
  await page.getByTitle("project: Destination", { exact: true }).click();
  await page
    .getByRole("button", { name: "Existing destination task", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "List", exact: true }),
  ).toHaveValue("actual-list");
});

test("explicit AI review can still create in an authorized list outside the empty selected project", async ({
  page,
}) => {
  const { mutations, errors } = await hierarchy(page);
  await page.goto("/app");
  await page.getByTitle("project: Destination", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "+ New task", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Assistant", exact: false }).click();
  await page.getByLabel("Message the assistant").fill("Suggest a task");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByRole("button", { name: "Review suggestion", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Review suggested task" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "List", exact: true }),
  ).toHaveValue(listId);
  expect(
    mutations.filter((mutation) => mutation.path.endsWith("/items")),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Confirm and create", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations.at(-1)?.body.nodeId).toBe(listId);
  await expect(
    page.getByRole("heading", {
      name: "No lists in this project",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "+ New task", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "All tasks 2", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Review this suggestion", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
