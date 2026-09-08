import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { optionalBuiltIns } from "../src/lib/project-fields";
import type { Detail, Item } from "../src/lib/api";
import { detail, fixture, task, wid } from "./fixture";

const projectId = detail.nodes[0].id;
const fields: Detail["fields"] = [
  ...detail.fields,
  { id: "date", name: "Check date", type: "date" },
  { id: "formula", name: "Total", type: "formula" },
  { id: "text", name: "Note", type: "text" },
];
const configured: Detail = {
  ...detail, fields,
  projectFields: [{ projectId, fieldIds: fields.map(field => field.id), builtInFields: optionalBuiltIns.map(field => field.id), updatedAt: task.updatedAt }],
};

async function stateful(page: Page, metadata = structuredClone(configured), initial: Item[] = [{ ...task, tags: ["comma, literal", " padded "], customFields: { ...task.customFields, date: "2026-09-04", formula: "{{Effort}} * 2", text: "keep me" } }]) {
  const { errors } = await fixture(page);
  const state = { items: structuredClone(initial), patches: [] as Record<string, unknown>[], reads: 0, pages: 0, fail: 0, delay: 0, metadata };
  await page.route(`**/api/v1/workspaces/${wid}`, route => route.fulfill({ json: state.metadata }));
  await page.route(`**/api/v1/workspaces/${wid}/items/**`, async route => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/").pop();
    if (id === "page") {
      state.pages++;
      return route.fulfill({ json: { items: state.items, nextCursor: null } });
    }
    const index = state.items.findIndex(item => item.id === id);
    if (index < 0) return route.fallback();
    if (request.method() === "GET") {
      state.reads++;
      return route.fulfill({ json: state.items[index] });
    }
    if (request.method() !== "PATCH") return route.fallback();
    const body = request.postDataJSON() as Record<string, unknown>;
    state.patches.push(body);
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    if (state.fail || body.expectedUpdatedAt !== state.items[index].updatedAt)
      return route.fulfill({ status: state.fail || 409, json: { error: state.fail === 403 ? "Permission denied" : "Task changed. Reload current task." } });
    const { expectedUpdatedAt: _, ...changes } = body;
    // Match the API: customFields REPLACES the map, and every save advances the version.
    state.items[index] = { ...state.items[index], ...changes, updatedAt: new Date(Date.parse(state.items[index].updatedAt) + 1).toISOString() } as Item;
    return route.fulfill({ json: state.items[index] });
  });
  await page.goto("/app");
  await expect(page.locator(`[data-task-id="${task.id}"]`).first()).toBeVisible();
  return { state, errors };
}
const cellButton = (page: Page, name: string, title = task.title) => page.getByRole("button", { name: `Edit ${title} ${name}`, exact: true });
async function save(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".task-cell-editor")).toHaveCount(0);
}

for (const view of ["List"]) {
  test(`${view}: valid cells, consecutive typed patches, siblings and focus survive without page reload`, async ({ page }) => {
    const { state, errors } = await stateful(page);
    await page.getByRole("tab", { name: view, exact: true }).click();
    expect(await page.locator(".task-table tbody tr").evaluateAll(rows => rows.every(row => [...row.children].every(cell => cell.tagName === "TD")))) .toBe(true);
    await expect(page.locator(".task-table tbody tr td")).toHaveCount(await page.locator(".task-table thead th").count());
    await cellButton(page, "Effort").click();
    await page.getByRole("spinbutton", { name: "Effort", exact: true }).fill("4.5");
    await page.getByRole("spinbutton", { name: "Effort", exact: true }).press("Enter");
    await expect.soft(cellButton(page, "Effort")).toBeFocused();
    expect(state.patches[0]).toEqual({ expectedUpdatedAt: task.updatedAt, customFields: { effort: 4.5, approved: false, category: "One", date: "2026-09-04", formula: "{{Effort}} * 2", text: "keep me" } });
    await cellButton(page, "Check date").click();
    await page.getByLabel("Check date", { exact: true }).fill("2026-10-12");
    await save(page);
    expect(state.items[0].customFields.date).toBe("2026-10-12");
    expect(state.items[0].customFields.effort).toBe(4.5);
    expect(state.patches[1].expectedUpdatedAt).not.toBe(task.updatedAt);
    await cellButton(page, "Start date").click();
    await page.getByLabel("Start date", { exact: true }).fill("2026-09-02");
    await save(page);
    expect(state.patches[2]).toEqual({ expectedUpdatedAt: state.patches[2].expectedUpdatedAt, startDate: "2026-09-02" });
    await cellButton(page, "Due date").click();
    await page.getByLabel("Due date", { exact: true }).fill("");
    await save(page);
    expect(state.items[0].dueDate).toBeNull();
    await cellButton(page, "Effort").click();
    await page.getByRole("spinbutton", { name: "Effort" }).fill("");
    await save(page);
    expect(state.items[0].customFields.effort).toBeNull();
    expect(state.pages).toBe(1);
    expect(errors).toEqual([]);
  });
}

test("checkbox tri-state, exact select values and lossless literal tag chips", async ({ page }) => {
  const metadata = structuredClone(configured);
  metadata.fields.find(field => field.id === "category")!.options = ["One", "a_b, literal", ""];
  const { state } = await stateful(page, metadata);
  for (const [name, value] of [["Yes", true], ["No", false], ["Not set", null]] as const) {
    await cellButton(page, "Approved").click();
    await page.getByRole("combobox", { name: "Approved" }).selectOption({ label: name });
    await save(page);
    expect(state.items[0].customFields.approved).toBe(value);
  }
  await cellButton(page, "Category").click();
  await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "a_b, literal" });
  await save(page);
  expect(state.items[0].customFields.category).toBe("a_b, literal");
  await cellButton(page, "Tags").click();
  await page.getByRole("button", { name: "Remove tag comma, literal", exact: true }).click();
  await page.getByRole("textbox", { name: "New tag" }).fill(" one,two ");
  await page.getByRole("button", { name: "Add tag", exact: true }).click();
  await save(page);
  expect(state.items[0].tags).toEqual([" padded ", " one,two "]);
  expect(state.patches.at(-1)).toEqual({ expectedUpdatedAt: state.patches.at(-1)!.expectedUpdatedAt, tags: [" padded ", " one,two "] });
});

test("all mutable basic fields, formula raw draft/preview and valid workspace destinations", async ({ page }) => {
  const metadata = structuredClone(configured);
  metadata.nodes.push({ id: "folder", name: "Folder", parentId: projectId, kind: "folder" }, { id: "destination", name: "Test list", parentId: "folder", kind: "list" });
  const { state } = await stateful(page, metadata);
  await cellButton(page, "Total").click();
  await expect(page.getByRole("textbox", { name: "Total", exact: true })).toHaveValue("{{Effort}} * 2");
  await page.getByRole("textbox", { name: "Total", exact: true }).fill("{{Effort}} * 3");
  await expect(page.getByLabel("Formula preview")).toHaveText("9");
  await save(page);
  expect(state.items[0].customFields.formula).toBe("{{Effort}} * 3");
  for (const [name, option, key, value] of [["Status", "Done", "status", "done"], ["Priority", "Low", "priority", "low"], ["Assignee", "Unassigned", "assigneeId", null], ["List", "Test project / Folder / Test list", "nodeId", "destination"]] as const) {
    await cellButton(page, name).click();
    await page.getByRole("combobox", { name, exact: true }).selectOption({ label: option });
    await save(page);
    expect(state.items[0][key]).toBe(value);
    expect(Object.keys(state.patches.at(-1)!).sort()).toEqual(["expectedUpdatedAt", key].sort());
  }
  expect(state.items[0].customFields.text).toBe("keep me");
  await cellButton(page, "Description").click();
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("Inline description");
  await save(page);
  await cellButton(page, "Title").click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Renamed task");
  await save(page);
  await expect(page.locator(`[data-task-id="${task.id}"]`)).toHaveText("Renamed task");
  expect(state.items[0].description).toBe("Inline description");
});

test("409 retains draft, blocks retries and explicitly reloads the new baseline after confirmation", async ({ page }) => {
  const { state } = await stateful(page);
  await cellButton(page, "Effort").click();
  await page.getByRole("spinbutton", { name: "Effort" }).fill("8");
  state.items[0].updatedAt = "2026-09-06T00:00:00Z";
  state.items[0].customFields.text = "server sibling";
  state.items[0].customFields.effort = 5;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Task changed");
  await expect(page.getByRole("spinbutton", { name: "Effort" })).toHaveValue("8");
  await page.getByRole("spinbutton", { name: "Effort" }).press("Enter");
  expect(state.patches).toHaveLength(1);
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "Reload current task" }).click();
  expect(state.reads).toBe(0);
  await expect(page.getByRole("spinbutton", { name: "Effort" })).toHaveValue("8");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Reload current task" }).click();
  await expect(page.getByRole("spinbutton", { name: "Effort" })).toHaveValue("5");
  await page.getByRole("spinbutton", { name: "Effort" }).fill("9");
  await save(page);
  expect(state.items[0].customFields).toMatchObject({ effort: 9, text: "server sibling" });
  expect(state.patches[1].expectedUpdatedAt).toBe("2026-09-06T00:00:00Z");
  expect(state.pages).toBe(1);
});

test("permission errors keep drafts; one editor, Escape and busy duplicate guards", async ({ page }) => {
  const { state } = await stateful(page);
  await cellButton(page, "Note").click();
  await expect(cellButton(page, "Effort")).toBeDisabled();
  await page.getByRole("textbox", { name: "Note", exact: true }).fill("retained draft");
  state.fail = 403;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Permission denied");
  await expect(page.getByRole("textbox", { name: "Note", exact: true })).toHaveValue("retained draft");
  await page.keyboard.press("Escape");
  await expect(cellButton(page, "Note")).toBeFocused();
  state.fail = 0;
  state.delay = 300;
  await cellButton(page, "Note").click();
  await page.getByRole("textbox", { name: "Note", exact: true }).fill("saved draft");
  await page.getByRole("textbox", { name: "Note", exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.keyboard.press("Enter");
  await expect(page.locator(".task-cell-editor")).toHaveCount(0);
  expect(state.patches).toHaveLength(2);
});

test("viewer has no edit controls, timestamps are read-only for writers", async ({ page }) => {
  const { state } = await stateful(page);
  await expect(cellButton(page, "Created")).toHaveCount(0);
  await expect(cellButton(page, "Updated")).toHaveCount(0);
  state.metadata.permissions = ["items:read"];
  await page.reload();
  await expect(page.locator(`[data-task-id="${task.id}"]`)).toBeVisible();
  await expect(page.locator(".task-cell-edit")).toHaveCount(0);
  await expect(page.locator('[data-column="createdAt"]')).toContainText(task.createdAt);
  expect(state.patches).toHaveLength(0);
});

test("project union hides unassigned stored values and selected projects use assigned List columns", async ({ page }) => {
  const metadata = structuredClone(configured);
  metadata.nodes.push({ id: "project-two", name: "Second project", kind: "project", parentId: null }, { id: "list-two", name: "Second list", kind: "list", parentId: "project-two" });
  metadata.projectFields![0].fieldIds = ["effort"];
  metadata.projectFields![0].builtInFields = ["priority"];
  metadata.projectFields!.push({ projectId: "project-two", fieldIds: ["text"], builtInFields: ["tags"], updatedAt: task.updatedAt });
  await stateful(page, metadata, [task, { ...task, id: "second", nodeId: "list-two", title: "Other task", customFields: { effort: 99, text: "visible" } }]);
  const first = page.locator(".task-table tbody tr").filter({ has: page.locator(`[data-task-id="${task.id}"]`) });
  await expect(first.locator('[data-column="tags"]')).toHaveText("-");
  await expect(cellButton(page, "Tags")).toHaveCount(0);
  await expect(cellButton(page, "Effort", "Other task")).toHaveCount(0);
  await page.getByRole("button", { name: "Test project", exact: true }).click();
  await expect(page.locator(".task-table thead th")).toHaveText(["Task", "Status", "Assignee", "Due date", "Priority", "Effort"]);
});

test("context switch aborts late saves and does not open an editor in the next view", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (init?.method === "PATCH") init.signal?.addEventListener("abort", () => {
        document.documentElement.dataset.tableFetchAborted = "true";
      });
      return original(input, init);
    };
  });
  const { state } = await stateful(page);
  state.delay = 500;
  await cellButton(page, "Note").click();
  await page.getByRole("textbox", { name: "Note", exact: true }).fill("old context");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("tab", { name: "Gallery", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-table-fetch-aborted", "true");
  await expect(page.locator(".task-cell-editor")).toHaveCount(0);
  await page.getByRole("tab", { name: "List", exact: true }).click();
  await expect(cellButton(page, "Note")).toHaveText("keep me");
  await expect.poll(() => state.items[0].customFields.text).toBe("old context");
  await expect(cellButton(page, "Note")).toHaveText("keep me");
});

test("legacy metadata fallback and unchanged drafts do not mutate", async ({ page }) => {
  const metadata = structuredClone(configured);
  delete metadata.projectFields;
  const { state } = await stateful(page, metadata);
  await expect(cellButton(page, "Effort")).toBeVisible();
  await expect(cellButton(page, "Description")).toHaveCount(0);
  await cellButton(page, "Effort").click();
  await save(page);
  await expect(cellButton(page, "Effort")).toBeFocused();
  expect(state.patches).toHaveLength(0);
});

test("hidden project fields still feed formula display and preview without changing siblings", async ({ page }) => {
  const metadata = structuredClone(configured);
  metadata.projectFields![0].fieldIds = ["formula"];
  const { state, errors } = await stateful(page, metadata);
  const original = structuredClone(state.items[0].customFields);
  await page.getByRole("button", { name: "Test project", exact: true }).press("Enter");
  await expect(cellButton(page, "Effort")).toHaveCount(0);
  await expect(cellButton(page, "Total")).toHaveText("6");
  await cellButton(page, "Total").click();
  await page.getByRole("textbox", { name: "Total", exact: true }).fill("{{Effort}} * 3");
  await expect(page.getByLabel("Formula preview")).toHaveText("9");
  await save(page);
  expect(state.items[0].customFields).toEqual({ ...original, formula: "{{Effort}} * 3" });
  expect(state.pages).toBe(1);
  expect(errors).toEqual([]);
});

test("text, formula, custom date and select clear to NULL with every sibling preserved", async ({ page }) => {
  const { state } = await stateful(page);
  const expected = structuredClone(state.items[0].customFields);
  for (const [name, key] of [["Note", "text"], ["Total", "formula"], ["Check date", "date"], ["Category", "category"]]) {
    const baseline = state.items[0].updatedAt;
    await cellButton(page, name).click();
    if (key === "category") await page.getByRole("combobox", { name, exact: true }).selectOption({ label: "Not set" });
    else await page.getByLabel(name, { exact: true }).fill("");
    await save(page);
    expected[key] = null;
    expect(state.items[0].customFields).toEqual(expected);
    expect(state.patches.at(-1)).toEqual({ expectedUpdatedAt: baseline, customFields: expected });
  }
  expect(state.pages).toBe(1);
});

test("tag empty/duplicate/30-chip boundaries retain literal drafts without truncation", async ({ page }) => {
  const tags = Array.from({ length: 29 }, (_, index) => `tag-${index}`);
  const { state, errors } = await stateful(page, structuredClone(configured), [{ ...task, tags }]);
  await cellButton(page, "Tags").click();
  const input = page.getByRole("textbox", { name: "New tag" });
  const add = page.getByRole("button", { name: "Add tag", exact: true });
  await expect(add).toBeDisabled();
  await expect(input).toHaveAttribute("maxlength", "60");
  await input.fill("   ");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Enter a non-empty tag.");
  await expect(input).toHaveValue("   ");
  await input.fill(" tag-0 ");
  await add.click();
  await expect(page.getByRole("alert")).toHaveText("This tag already exists.");
  await expect(input).toHaveValue(" tag-0 ");
  const literal = `a,b${"x".repeat(57)}`;
  await input.fill(literal);
  await input.press("Enter");
  await expect(page.locator(".task-cell-editor li")).toHaveCount(30);
  await input.fill("thirty-first");
  await add.click();
  await expect(page.getByRole("alert")).toContainText("at most 30 tags");
  await expect(input).toHaveValue("thirty-first");
  await input.press("Enter");
  await expect(page.locator(".task-cell-editor li")).toHaveCount(30);
  expect(state.patches).toHaveLength(0);
  await page.getByRole("button", { name: "Remove tag tag-0", exact: true }).click();
  await add.click();
  await save(page);
  expect(state.items[0].tags).toEqual([...tags.slice(1), literal, "thirty-first"]);
  expect(errors).toEqual([]);
});

test("checklist progress shows done/total next to the title or description; absent checklists render nothing", async ({ page }) => {
  const withChecklist = { ...task, checklist: [
    { id: "check-1", text: "Build", done: true },
    { id: "check-2", text: "Review", done: true },
    { id: "check-3", text: "Ship", done: false },
  ] };
  const { state } = await stateful(page, structuredClone(configured), [
    withChecklist,
    { ...task, id: "no-checklist", title: "No checklist task" },
  ]);
  // The configured project assigns the Description built-in column, so the
  // count renders in the description cell; the title cell stays untouched so
  // accessible names of task buttons do not change.
  const count = page.locator("td[data-column='description'] .count");
  await expect(count).toHaveText("2/3");
  await expect(count).toHaveAttribute("title", "2 of 3 checklist items complete");
  // Task-level hierarchy/checklist fields may be absent on older payloads.
  await expect(page.locator(".task-name-cell", { hasText: "No checklist task" }).locator(".count")).toHaveCount(0);
  // Without the description column the count falls back to the title cell;
  // the count never enters the task button so accessible names are intact.
  await page.route(`**/api/v1/workspaces/${wid}/projects/*/fields`, route => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: state.metadata.projectFields![0] });
    const body = request.postDataJSON() as Record<string, unknown>;
    const config = { projectId, fieldIds: body.fieldIds as string[], builtInFields: body.builtInFields as NonNullable<Detail["projectFields"]>[number]["builtInFields"], updatedAt: `${configured.projectFields![0].updatedAt}-next` };
    state.metadata.projectFields = [config];
    return route.fulfill({ json: config });
  });
  await page.getByRole("button", { name: "Add fields", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Project fields", exact: true });
  await dialog.getByRole("combobox", { name: "Project or list", exact: true }).selectOption(projectId);
  await dialog.getByRole("checkbox", { name: "Description Built-in", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect(page.getByText("Project fields updated.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".task-name-cell .count")).toHaveText("2/3");
  await expect(page.locator("td[data-column='description'] .count")).toHaveCount(0);
});

for (const width of [320, 390]) {
  test(`${width}px dark mobile: internal overflow and accessible List editing`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => { localStorage.setItem("hopya-theme", "dark"); });
    await stateful(page);
    await cellButton(page, "Effort").click();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
    expect(results.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".task-table-scroll").evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.getByRole("spinbutton", { name: "Effort" }).press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
