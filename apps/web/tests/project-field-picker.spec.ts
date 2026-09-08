import { expect, test, type Page, type Route } from "@playwright/test";
import type { Detail, Field, Item } from "../src/lib/api";
import { detail, fixture, task, wid } from "./fixture";

const pid = detail.nodes[0].id;
async function setup(page: Page, permissions = detail.permissions, items?: Item[]) {
  const original = await fixture(page, { items });
  const metadata: Detail = structuredClone({ ...detail, permissions,
    nodes: [...detail.nodes,
      { id: "project-b", name: "Second project", kind: "project", parentId: null },
      { id: "folder-b", name: "Nested folder", kind: "folder", parentId: "project-b" },
      { id: "list-b", name: "Second list", kind: "list", parentId: "folder-b" }],
    fields: [...detail.fields, { id: "estimate", name: "Estimate (hours)", type: "number" }],
    projectFields: [
      { projectId: pid, fieldIds: ["effort"], builtInFields: ["priority", "startDate", "tags"], updatedAt: "config-1" },
      { projectId: "project-b", fieldIds: ["category"], builtInFields: [], updatedAt: "config-b" },
    ],
    listStatusConfigs: [
      { listId: task.nodeId, updatedAt: "list-config-1", inheritedProjectUpdatedAt: "config-1" },
      { listId: "list-b", updatedAt: "list-config-b", inheritedProjectUpdatedAt: "config-b" },
    ],
  });
  const writes: { method: string; projectId?: string; body: Record<string, unknown> }[] = [];
  await page.route(`**/api/v1/workspaces/${wid}`, route => route.fulfill({ json: metadata }));
  await page.route(`**/api/v1/workspaces/${wid}/projects/*/fields`, async route => {
    const projectId = new URL(route.request().url()).pathname.split("/").at(-2);
    const config = metadata.projectFields!.find(value => value.projectId === projectId)!;
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      writes.push({ method: "PATCH", projectId, body: structuredClone(body) });
      expect(body.expectedUpdatedAt).toBe(config.updatedAt);
      Object.assign(config, body, { updatedAt: `${config.updatedAt}-next` });
    }
    await route.fulfill({ json: config });
  });
  await page.route(`**/api/v1/workspaces/${wid}/lists/*/statuses`, async route => {
    const listId = new URL(route.request().url()).pathname.split("/").at(-2);
    const config = metadata.listStatusConfigs!.find(value => value.listId === listId)!;
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      if (body.statuses === null) delete config.statuses;
      else config.statuses = body.statuses;
      config.updatedAt += "-next";
    }
    await route.fulfill({ json: config });
  });
  await page.route(`**/api/v1/workspaces/${wid}/fields`, async route => {
    const body = route.request().postDataJSON();
    writes.push({ method: "POST", projectId: body.projectId, body });
    const field: Field = { id: `created-${writes.length}`, name: body.name, type: body.type, ...(body.options ? { options: body.options } : {}) };
    metadata.fields.push(field);
    const config = metadata.projectFields!.find(value => value.projectId === body.projectId)!;
    config.fieldIds.push(field.id);
    config.updatedAt += "-created";
    await route.fulfill({ json: field });
  });
  return { ...original, metadata, writes };
}
async function openTask(page: Page) {
  await page.goto("/app");
  await page.getByRole("button", { name: task.title, exact: true }).click();
  return page.getByRole("dialog", { name: "Task details", exact: true });
}
async function picker(page: Page) {
  await page.getByRole("dialog", { name: "Task details", exact: true })
    .getByRole("button", { name: "Add fields", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Project fields", exact: true });
  await expect(dialog.getByRole("button", { name: "Apply fields", exact: true })).toBeEnabled();
  return dialog;
}

test("create and assign preserve unsaved title, tags, hidden values and task version", async ({ page }) => {
  const { mutations, writes, errors } = await setup(page);
  const editor = await openTask(page);
  await editor.getByRole("button", { name: "Edit title", exact: true }).click();
  await editor.getByLabel("Title", { exact: true }).fill("Unsaved title");
  await editor.getByRole("button", { name: "Edit tags", exact: true }).click();
  await editor.getByLabel("New tag", { exact: true }).fill("local,tag");
  await editor.getByRole("button", { name: "Add tag", exact: true }).click();
  const dialog = await picker(page);
  await dialog.getByRole("checkbox", { name: "Approved Checkbox", exact: true }).check();
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect(dialog.getByText("Project fields updated.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Progress (%)", exact: true }).click();
  await dialog.getByRole("button", { name: "Create field and add", exact: true }).click();
  await expect(dialog.getByText(/Field created and added/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Edit title", exact: true })).toHaveText("Unsaved title");
  await expect(editor.getByText("local,tag", { exact: true })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Edit Approved", exact: true })).toHaveText("No");
  await editor.getByRole("button", { name: "Edit Progress (%)", exact: true }).click();
  await editor.getByLabel("Progress (%)", { exact: true }).fill("125");
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes[1].body).toEqual({ name: "Progress (%)", type: "number", projectId: pid });
  expect(mutations.at(-1)?.body).toEqual({ title: "Unsaved title", tags: [...task.tags, "local,tag"],
    customFields: { ...task.customFields, "created-2": 125 }, expectedUpdatedAt: task.updatedAt });
  expect(errors).toEqual([]);
});

test("templates reuse catalog fields and select options stay one per line", async ({ page }) => {
  const { writes } = await setup(page);
  await openTask(page);
  const dialog = await picker(page);
  await dialog.getByRole("button", { name: "Estimate (hours)", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Estimate (hours) Number", exact: true })).toBeChecked();
  expect(writes).toHaveLength(0);
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect(dialog.getByText("Project fields updated.", { exact: true })).toBeVisible();
  await dialog.getByLabel("Field name", { exact: true }).fill("Size");
  await dialog.getByRole("combobox", { name: "Type", exact: true }).selectOption("select");
  await dialog.getByLabel("Options, one per line", { exact: true }).fill("Small\nLarge\nSmall");
  await dialog.getByRole("button", { name: "Create field and add", exact: true }).click();
  await expect(dialog.getByText(/Field created and added/)).toBeVisible();
  expect(writes[0].body.fieldIds).toEqual(["effort", "estimate"]);
  expect(writes[1].body.options).toEqual(["Small", "Large"]);
});

test("draft destination controls fields and moving across projects preserves every saved value", async ({ page }) => {
  const { metadata, mutations } = await setup(page);
  metadata.listStatusConfigs![0].statuses = [
    { id: "shipped", name: "Shipped", color: "#15803d", completed: true },
    { id: "todo", name: "Todo", color: "#2563eb", completed: false },
  ];
  metadata.listStatusConfigs![1].statuses = [
    { id: "qa", name: "QA", color: "#9333ea", completed: false },
    { id: "todo", name: "Todo", color: "#2563eb", completed: false },
  ];
  const editor = await openTask(page);
  await editor.getByText("Other saved fields", { exact: true }).click();
  await expect(editor.getByText("Approved", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Edit status", exact: true }).click();
  await editor.getByRole("combobox", { name: "Status", exact: true }).selectOption("shipped");
  await editor.getByRole("button", { name: "Edit list", exact: true }).click();
  await editor.getByRole("combobox", { name: "List", exact: true }).selectOption("list-b");
  await expect(editor.getByRole("button", { name: "Edit status", exact: true })).toHaveText("QA");
  await expect(editor.getByRole("button", { name: "Edit priority", exact: true })).toHaveText("High");
  await expect(editor.getByRole("button", { name: "Edit start date", exact: true })).toHaveText("2026-09-03");
  await expect(editor.getByText("verification", { exact: true })).toBeVisible();
  await expect(editor.getByText("Category", { exact: true })).toBeVisible();
  await editor.getByRole("combobox", { name: "List", exact: true }).selectOption(task.nodeId);
  await expect(editor.getByRole("button", { name: "Edit status", exact: true })).toHaveText("Shipped");
  await editor.getByRole("button", { name: "Edit status", exact: true }).click();
  await editor.getByRole("combobox", { name: "Status", exact: true }).selectOption("todo");
  await expect(editor.getByRole("button", { name: "Edit Effort", exact: true })).toHaveText("3");
  await editor.getByRole("button", { name: "Edit list", exact: true }).click();
  await editor.getByRole("combobox", { name: "List", exact: true }).selectOption("list-b");
  await expect(editor.getByText("Category", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(mutations.at(-1)?.body).toEqual({ nodeId: "list-b", expectedUpdatedAt: task.updatedAt });
  await page.getByRole("button", { name: "+ New task", exact: true }).click();
  const creator = page.getByRole("dialog", { name: "New task", exact: true });
  await creator.getByRole("combobox", { name: "Status", exact: true }).selectOption("todo");
  await creator.getByRole("combobox", { name: "List", exact: true }).selectOption("list-b");
  await expect(creator.getByRole("combobox", { name: "Status", exact: true })).toHaveValue("qa");
});

test("unassign retains values and adding the existing field restores editing", async ({ page }) => {
  await setup(page);
  const editor = await openTask(page);
  let dialog = await picker(page);
  await dialog.getByRole("checkbox", { name: "Effort Number", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect(dialog.getByText("Project fields updated.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Edit Effort", exact: true })).toHaveCount(0);
  await editor.getByText("Other saved fields", { exact: true }).click();
  await expect(editor.locator("dd").filter({ hasText: /^3$/ })).toBeVisible();
  dialog = await picker(page);
  await dialog.getByRole("checkbox", { name: "Effort Number", exact: true }).check();
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect(dialog.getByText("Project fields updated.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await editor.getByRole("button", { name: "Edit Effort", exact: true }).click();
  await expect(editor.getByLabel("Effort", { exact: true })).toHaveValue("3");
});

test("conflicts retain choices and create draft until explicit discard reload", async ({ page }) => {
  const { metadata } = await setup(page);
  await page.route(`**/api/v1/workspaces/${wid}/projects/${pid}/fields`, route => route.request().method() === "PATCH"
    ? route.fulfill({ status: 409, json: { error: "Stale" } })
    : route.fulfill({ json: metadata.projectFields![0] }));
  await openTask(page);
  const dialog = await picker(page);
  await dialog.getByLabel("Field name", { exact: true }).fill("Keep this draft");
  await dialog.getByRole("checkbox", { name: "Effort Number", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Reload and discard");
  await expect(dialog.getByRole("checkbox", { name: "Effort Number", exact: true })).not.toBeChecked();
  await expect(dialog.getByLabel("Field name", { exact: true })).toHaveValue("Keep this draft");
  page.once("dialog", prompt => prompt.dismiss());
  await dialog.getByRole("button", { name: "Reload project fields", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  page.once("dialog", prompt => prompt.accept());
  await dialog.getByRole("button", { name: "Reload project fields", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply fields", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("checkbox", { name: "Effort Number", exact: true })).toBeChecked();
  await expect(dialog.getByLabel("Field name", { exact: true })).toHaveValue("Keep this draft");
});

test("settings requires an explicit project and ignores late responses after switching", async ({ page }) => {
  const { metadata } = await setup(page);
  let pending: Route | undefined;
  await page.route(`**/api/v1/workspaces/${wid}/projects/${pid}/fields`, route => { pending = route; });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Project fields", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Project fields", exact: true });
  await expect(dialog.getByRole("combobox", { name: "Project or list", exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Apply fields", exact: true })).toHaveCount(0);
  await dialog.getByRole("combobox", { name: "Project or list", exact: true }).selectOption(pid);
  await expect.poll(() => !!pending).toBe(true);
  await dialog.getByRole("combobox", { name: "Project or list", exact: true }).selectOption("project-b");
  await expect(dialog.getByRole("button", { name: "Apply fields", exact: true })).toBeEnabled();
  await pending!.fulfill({ json: metadata.projectFields![0] });
  await expect(dialog.getByRole("checkbox", { name: "Category Dropdown", exact: true })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Effort Number", exact: true })).not.toBeChecked();
});

for (const manage of [true, false]) test(`read-only task access ${manage ? "with" : "without"} field-management permission`, async ({ page }) => {
  const { writes } = await setup(page, ["items:read", ...(manage ? ["structure:write"] : [])]);
  const editor = await openTask(page);
  await editor.getByRole("button", { name: "Edit title", exact: true }).click();
  await expect(editor.getByLabel("Title", { exact: true })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
  if (manage) {
    const dialog = await picker(page);
    await dialog.getByRole("checkbox", { name: "Approved Checkbox", exact: true }).check();
    await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
    await expect(dialog.getByText("Project fields updated.", { exact: true })).toBeVisible();
    expect(writes).toHaveLength(1);
  } else {
    await expect(editor.getByRole("button", { name: "Add fields", exact: true })).toHaveCount(0);
    expect(writes).toHaveLength(0);
  }
});

test("mobile dark picker supports keyboard close and restores unsaved task focus", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.addInitScript(() => localStorage.setItem("hopya-theme", "dark"));
  await setup(page);
  const editor = await openTask(page);
  const dialog = await picker(page);
  await dialog.getByRole("combobox", { name: "Type", exact: true }).selectOption("formula");
  await expect(dialog.getByRole("button", { name: "About formulas", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Create field and add", exact: true })).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(editor.getByRole("button", { name: "Add fields", exact: true })).toBeFocused();
  await expect(editor).toBeVisible();
});

test("denied creation retains the field draft and never reports success", async ({ page }) => {
  await setup(page);
  await page.route(`**/api/v1/workspaces/${wid}/fields`, route => route.fulfill({ status: 403, json: { error: "Field permission revoked" } }));
  await openTask(page);
  const dialog = await picker(page);
  await dialog.getByLabel("Field name", { exact: true }).fill("Retained reference");
  await dialog.getByRole("checkbox", { name: "Approved Checkbox", exact: true }).check();
  await dialog.getByRole("button", { name: "Create field and add", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Field permission revoked");
  await expect(dialog.getByLabel("Field name", { exact: true })).toHaveValue("Retained reference");
  await expect(dialog.getByRole("checkbox", { name: "Approved Checkbox", exact: true })).toBeChecked();
  await expect(dialog.getByText(/Field created and added/)).toHaveCount(0);
});

test("failed metadata refresh blocks duplicate creation and leaves task draft untouched", async ({ page }) => {
  const { writes } = await setup(page);
  const editor = await openTask(page);
  await editor.getByRole("button", { name: "Edit title", exact: true }).click();
  await editor.getByLabel("Title", { exact: true }).fill("Keep task draft");
  const dialog = await picker(page);
  await page.route(`**/api/v1/workspaces/${wid}`, route => route.fulfill({ status: 503, json: { error: "Metadata unavailable" } }));
  await dialog.getByLabel("Field name", { exact: true }).fill("Reference draft");
  await dialog.getByRole("button", { name: "Create field and add", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("may have saved");
  await expect(dialog.getByRole("button", { name: "Create field and add", exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("Field name", { exact: true })).toHaveValue("Reference draft");
  await expect(dialog.getByText(/Field created and added/)).toHaveCount(0);
  expect(writes).toHaveLength(1);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(editor.getByLabel("Title", { exact: true })).toHaveValue("Keep task draft");
});

test("late project mutation cannot publish metadata or success into another project", async ({ page }) => {
  const { metadata } = await setup(page);
  let pending: Route | undefined;
  await page.route(`**/api/v1/workspaces/${wid}/projects/${pid}/fields`, route => {
    if (route.request().method() === "PATCH") { pending = route; return; }
    return route.fulfill({ json: metadata.projectFields![0] });
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Project fields", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Project fields", exact: true });
  await dialog.getByRole("combobox", { name: "Project or list", exact: true }).selectOption(pid);
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect.poll(() => !!pending).toBe(true);
  await dialog.getByRole("combobox", { name: "Project or list", exact: true }).selectOption("project-b");
  await expect(dialog.getByRole("button", { name: "Apply fields", exact: true })).toBeEnabled();
  await pending!.fulfill({ json: metadata.projectFields![0] });
  await expect(dialog.getByRole("checkbox", { name: "Category Dropdown", exact: true })).toBeChecked();
  await expect(dialog.getByText("Project fields updated.", { exact: true })).toHaveCount(0);
});

for (const view of ["List"] as const) {
  for (const context of ["All tasks", "Second project", "Second list"] as const) {
    test(`${view} toolbar in ${context} assigns existing and creates new fields only for the chosen project`, async ({ page }) => {
      const secondTask: Item = { ...structuredClone(task), id: "second-task", nodeId: "list-b", title: "Second project task" };
      const { metadata, writes, mutations, errors } = await setup(page, detail.permissions, [task, secondTask]);
      const untouched = structuredClone(metadata.projectFields![0]);
      let taskReads = 0;
      let documents = 0;
      page.on("request", request => {
        if (new URL(request.url()).pathname.endsWith("/items/page")) taskReads++;
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
      });
      await page.goto("/app");
      await page.getByRole("tab", { name: view, exact: true }).click();
      if (context !== "All tasks") await page.getByRole("button", { name: context, exact: true }).click();
      const region = page.getByRole("region", { name: `${view} tasks`, exact: true });
      await expect(region.getByRole("button", { name: secondTask.title, exact: true })).toBeVisible();
      await expect(region.getByRole("columnheader", { name: /^Approved(?: Move Approved left Move Approved right)?(?: Resize Approved)?$/ })).toHaveCount(0);
      const readsBefore = taskReads;
      const documentsBefore = documents;
      await page.getByRole("button", { name: "Add fields", exact: true }).click();
      let dialog = page.getByRole("dialog", { name: "Project fields", exact: true });
      if (context === "All tasks") {
        await expect(dialog.getByRole("combobox", { name: "Project or list", exact: true })).toHaveValue("");
        await expect(dialog.getByRole("button", { name: "Apply fields", exact: true })).toHaveCount(0);
        expect(writes).toEqual([]);
        await dialog.getByRole("combobox", { name: "Project or list", exact: true }).selectOption("project-b");
      } else {
        await expect(dialog.getByRole("combobox", { name: "Project or list", exact: true })).toHaveCount(0);
        await expect(dialog.getByText(context === "Second list" ? "List: Second list" : "Project: Second project", { exact: true })).toBeVisible();
      }
      await expect(dialog.getByRole("checkbox", { name: "Category Dropdown", exact: true })).toBeChecked();
      await expect(dialog.getByRole("checkbox", { name: "Effort Number", exact: true })).not.toBeChecked();
      await dialog.getByRole("checkbox", { name: "Approved Checkbox", exact: true }).check();
      await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
      await expect(dialog.getByText("Project fields updated.", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
      await expect(region.getByRole("columnheader", { name: /^Approved(?: Move Approved left Move Approved right)?(?: Resize Approved)?$/ }).first()).toBeVisible();
      await expect(region.getByRole("button", { name: `Edit ${secondTask.title} Approved`, exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Add fields", exact: true }).click();
      dialog = page.getByRole("dialog", { name: "Project fields", exact: true });
      if (context === "All tasks") await dialog.getByRole("combobox", { name: "Project or list", exact: true }).selectOption("project-b");
      await expect(dialog.getByRole("button", { name: "Apply fields", exact: true })).toBeEnabled();
      await dialog.getByLabel("Field name", { exact: true }).fill("Project reference");
      await dialog.getByRole("button", { name: "Create field and add", exact: true }).click();
      await expect(dialog.getByText(/Field created and added/)).toBeVisible();
      await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
      await expect(region.getByRole("columnheader", { name: /^Project reference(?: Move Project reference left Move Project reference right)?(?: Resize Project reference)?$/ }).first()).toBeVisible();
      await expect(region.getByRole("button", { name: `Edit ${secondTask.title} Project reference`, exact: true })).toHaveText("-");
      expect(taskReads).toBe(readsBefore);
      expect(documents).toBe(documentsBefore);
      expect(writes).toEqual([
        { method: "PATCH", projectId: "project-b", body: { fieldIds: ["category", "approved"], builtInFields: [], expectedUpdatedAt: "config-b" } },
        { method: "POST", projectId: "project-b", body: { name: "Project reference", type: "text", projectId: "project-b" } },
      ]);
      expect(metadata.projectFields![0]).toEqual(untouched);
      expect(metadata.projectFields![1].fieldIds).toEqual(["category", "approved", "created-2"]);
      expect(mutations).toEqual([]);
      if (context === "All tasks") {
        const firstRow = region.getByRole("row").filter({ has: page.getByRole("button", { name: task.title, exact: true }) });
        await expect(firstRow.locator('[data-column="custom:approved"]')).toHaveText("-");
        await expect(firstRow.locator('[data-column="custom:created-2"]')).toHaveText("-");
        await expect(firstRow.getByRole("button", { name: /Approved|Project reference/ })).toHaveCount(0);
      }
      await page.getByRole("button", { name: "Test project", exact: true }).click();
      await expect(region.getByRole("columnheader", { name: /^Effort(?: Move Effort left Move Effort right)?(?: Resize Effort)?$/ })).toBeVisible();
      await expect(region.getByRole("columnheader", { name: /^Approved|^Project reference/ })).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }

  test(`${view} toolbar remains available with zero tasks and can assign and create fields`, async ({ page }) => {
    const { metadata, writes, mutations, errors } = await setup(page, detail.permissions, []);
    const untouched = structuredClone(metadata.projectFields![0]);
    await page.goto("/app");
    await page.getByRole("tab", { name: view, exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your next step starts here", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add fields", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Add fields", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Project fields", exact: true });
    await expect(dialog.getByRole("combobox", { name: "Project or list", exact: true })).toHaveValue("");
    await dialog.getByRole("combobox", { name: "Project or list", exact: true }).selectOption("project-b");
    await dialog.getByRole("checkbox", { name: "Approved Checkbox", exact: true }).check();
    await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
    await expect(dialog.getByText("Project fields updated.", { exact: true })).toBeVisible();
    await dialog.getByLabel("Field name", { exact: true }).fill("Empty project reference");
    await dialog.getByRole("button", { name: "Create field and add", exact: true }).click();
    await expect(dialog.getByText(/Field created and added/)).toBeVisible();
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your next step starts here", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Second list", exact: true }).click();
    await page.getByRole("button", { name: "Add fields", exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: "Project or list", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("checkbox", { name: "Approved Checkbox", exact: true })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "Empty project reference Text", exact: true })).toBeChecked();
    expect(writes.map(write => write.projectId)).toEqual(["project-b", "project-b"]);
    expect(metadata.projectFields![0]).toEqual(untouched);
    expect(mutations).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("creating a field preserves concurrent configuration and local checkbox intent", async ({ page }) => {
  const { metadata } = await setup(page);
  await openTask(page);
  const dialog = await picker(page);
  await dialog.getByRole("checkbox", { name: "Approved Checkbox", exact: true }).check();
  metadata.projectFields![0].fieldIds.push("category");
  metadata.projectFields![0].builtInFields.push("description");
  metadata.projectFields![0].updatedAt = "concurrent-manager-revision";
  await dialog.getByLabel("Field name", { exact: true }).fill("Concurrent safe field");
  await dialog.getByRole("button", { name: "Create field and add", exact: true }).click();
  await expect(dialog.getByText(/Field created and added/)).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Category Dropdown", exact: true })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Description Built-in", exact: true })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Approved Checkbox", exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect(dialog.getByText("Project fields updated.", { exact: true })).toBeVisible();
  expect(metadata.projectFields![0].fieldIds).toEqual(expect.arrayContaining(["effort", "category", "approved", "created-1"]));
  expect(metadata.projectFields![0].builtInFields).toContain("description");
});

for (const view of ["List"] as const) {
  test(`${view} keeps a removed column draft reachable until cancelled`, async ({ page }) => {
    await setup(page);
    await page.goto("/app");
    await page.getByRole("button", { name: "Test project", exact: true }).click();
    await page.getByRole("tab", { name: view, exact: true }).click();
    await page.getByRole("button", { name: `Edit ${task.title} Effort`, exact: true }).click();
    await page.getByRole("spinbutton", { name: "Effort", exact: true }).fill("9");
    await page.getByRole("button", { name: "Add fields", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Project fields", exact: true });
    await expect(dialog.getByRole("button", { name: "Apply fields", exact: true })).toBeEnabled();
    await dialog.getByRole("checkbox", { name: "Effort Number", exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
    await expect(dialog.getByText("Project fields updated.", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(page.getByText(/This field was removed from the view/)).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Effort", exact: true })).toHaveValue("9");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("button", { name: `Edit ${task.title} Status`, exact: true })).toBeEnabled();
  });
}

test("hiding Tags does not strand a pending tag or discard the task draft", async ({ page }) => {
  const { mutations } = await setup(page);
  const editor = await openTask(page);
  await editor.getByRole("button", { name: "Edit title", exact: true }).click();
  await editor.getByLabel("Title", { exact: true }).fill("Preserved title");
  await editor.getByRole("button", { name: "Edit tags", exact: true }).click();
  await editor.getByLabel("New tag", { exact: true }).fill("pending, literal");
  const dialog = await picker(page);
  await dialog.getByRole("checkbox", { name: "Tags Built-in", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect(dialog.getByText("Project fields updated.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(editor.getByLabel("New tag", { exact: true })).toHaveValue("pending, literal");
  await editor.getByRole("button", { name: "Add tag", exact: true }).click();
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(mutations.at(-1)?.body).toMatchObject({ title: "Preserved title", tags: [...task.tags, "pending, literal"] });
});

test("AI review exposes a suggested priority even when the project has not added that column", async ({ page }) => {
  const { mutations } = await setup(page);
  await page.route(`**/api/v1/workspaces/${wid}/agent`, route => route.fulfill({ json: {
    reply: "Review this proposal", proposal: { title: "Human-reviewed priority", nodeId: "list-b", priority: "urgent" },
  } }));
  await page.goto("/app");
  await page.getByRole("button", { name: "Assistant", exact: false }).click();
  await page.getByRole("textbox", { name: "Message the assistant", exact: true }).fill("Propose a task");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Review suggestion", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review suggested task" });
  await expect(review.getByRole("combobox", { name: "Priority", exact: true })).toHaveValue("urgent");
  await review.getByRole("combobox", { name: "Priority", exact: true }).selectOption("low");
  expect(mutations).toEqual([]);
  await review.getByRole("button", { name: "Confirm and create", exact: true }).click();
  await expect(review).not.toBeVisible();
  expect(mutations.at(-1)?.body).toMatchObject({ nodeId: "list-b", priority: "low" });
});
