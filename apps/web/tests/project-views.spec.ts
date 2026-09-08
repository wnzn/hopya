import { expect, test, type Page } from "@playwright/test";
import { detail, fixture, task, wid } from "./fixture";
import type { Item } from "../src/lib/api";

async function setup(page: Page, items: Item[] = [task]) {
  const base = await fixture(page, { items });
  const state = structuredClone(detail);
  state.nodes[0].description = "Project scope\nSecond line <not HTML>";
  state.nodes.push(
    { id: "folder", name: "Delivery", kind: "folder", parentId: state.nodes[0].id },
    { id: "nested-list", name: "Test list", kind: "list", parentId: "folder" },
    { id: "empty-list", name: "Empty list", kind: "list", parentId: "folder" },
    { id: "other-project", name: "Other project", kind: "project", parentId: null },
    { id: "other-list", name: "Other list", kind: "list", parentId: "other-project" },
  );
  await page.route(`**/api/v1/workspaces/${wid}`, route => route.fulfill({ json: state }));
  return { ...base, state };
}

test("project descriptions retain failed drafts, edit and clear without leaking to folders", async ({ page }) => {
  const { state } = await setup(page);
  const writes: Record<string, unknown>[] = [];
  let fail = true;
  await page.route(`**/api/v1/workspaces/${wid}/nodes/**`, route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    if (fail) return route.fulfill({ status: 409, json: { error: "Conflict" } });
    Object.assign(state.nodes[0], body);
    return route.fulfill({ json: state.nodes[0] });
  });
  await page.route(`**/api/v1/workspaces/${wid}/nodes`, route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  await page.goto("/app");
  await page.getByTitle("project: Test project", { exact: true }).click();
  await expect(page.locator(".project-description")).toHaveText(state.nodes[0].description!);
  await page.getByRole("button", { name: "Manage Test project", exact: true }).click();
  await page.getByRole("textbox", { name: "Project description", exact: true }).fill("Revised scope");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your draft is still here");
  await expect(page.getByRole("textbox", { name: "Project description", exact: true })).toHaveValue("Revised scope");
  fail = false;
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".project-description")).toHaveText("Revised scope");
  expect(writes.at(-1)).toEqual({ description: "Revised scope" });
  await page.getByRole("button", { name: "Manage Test project", exact: true }).click();
  await page.getByRole("textbox", { name: "Project description", exact: true }).fill("");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".project-description")).toHaveCount(0);
  expect(writes.at(-1)).toEqual({ description: "" });
  await page.getByRole("button", { name: "Add project, folder, or list", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("New folder");
  await page.getByRole("textbox", { name: "Project description", exact: true }).fill("Do not send");
  await page.getByRole("combobox", { name: "Type", exact: true }).selectOption("folder");
  await expect(page.getByLabel("Project description", { exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Parent project or folder" }).selectOption(state.nodes[0].id);
  await page.getByRole("button", { name: "Create folder", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes.at(-1)).not.toHaveProperty("description");
});

test("each hierarchy scope shows destination lists with one global limit", async ({ page }) => {
  const items = Array.from({ length: 105 }, (_, index) => ({ ...task, id: `task-${index}`, title: `Task ${index}` }));
  items.push({ ...task, id: "nested-task", nodeId: "nested-list", title: "Last nested task" });
  await setup(page, items);
  await page.goto("/app");
  await expect(page.locator(".list-section")).toHaveCount(4);
  await expect(page.locator(".grouped-lists > .section-heading")).toContainText("across 4 lists");
  await page.getByTitle("project: Test project", { exact: true }).click();
  await expect(page.locator(".list-section")).toHaveCount(3);
  await expect(page.locator(".list-path")).toHaveText(["Test project / Test list", "Test project / Delivery / Test list", "Test project / Delivery / Empty list"]);
  await expect(page.locator(".grouped-lists > .section-heading")).toContainText("Showing 100 of 106 tasks across 3 lists");
  await expect(page.locator(".task-table tbody tr")).toHaveCount(100);
  await expect(page.locator(".workspace-footer")).toContainText("106 tasks");
  await page.getByRole("button", { name: "Show more tasks", exact: true }).click();
  await expect(page.locator(".task-table tbody tr")).toHaveCount(106);
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("Last nested task");
  await expect(page.locator(".task-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".list-section")).toHaveCount(3);
  await expect(page.locator(".workspace-footer")).toContainText("1 task");
  await page.getByTitle("folder: Delivery", { exact: true }).click();
  await expect(page.locator(".list-section")).toHaveCount(2);
  await expect(page.locator(".list-section h2")).toContainText(["Test list list", "Empty list list"]);
});

test("configured statuses drive mixed-project columns, completion counts, filters and safe movement", async ({ page }) => {
  const { state, mutations } = await setup(page, [
    { ...task, status: "shipped" },
    { ...task, id: "nested-task", nodeId: "nested-list", title: "Nested task", status: "qa" },
    { ...task, id: "other-task", nodeId: "other-list", title: "Other task", status: "todo" },
  ]);
  state.projectFields = [{ projectId: state.nodes[0].id, fieldIds: [], builtInFields: [], updatedAt: "v1", statuses: [
    { id: "todo", name: "Ready", color: "#123456", completed: false },
    { id: "shipped", name: "Shipped", color: "#15803d", completed: true },
  ] }];
  state.listStatusConfigs = [
    { listId: task.nodeId, updatedAt: "list-v1", inheritedProjectUpdatedAt: "v1", statuses: [
      { id: "todo", name: "Ready", color: "#123456", completed: false },
      { id: "shipped", name: "Shipped", color: "#15803d", completed: true },
      { id: "planned", name: "Planned", color: "#64748b", completed: false },
    ] },
    { listId: "nested-list", updatedAt: "list-v2", inheritedProjectUpdatedAt: "v1", statuses: [
      { id: "qa", name: "QA", color: "#9333ea", completed: false },
      { id: "shipped", name: "Shipped", color: "#166534", completed: true },
    ] },
  ];
  await page.goto("/app");
  await expect(page.locator(".workspace-heading")).toContainText("1 complete");
  await page.getByTitle("folder: Delivery", { exact: true }).click();
  await expect(page.locator(".workspace-heading")).toContainText("0 complete");
  await page.getByRole("button", { name: "All tasks", exact: false }).click();
  await page.getByRole("tab", { name: "Board", exact: true }).click();
  const shipped = page.getByRole("region", { name: "Shipped (Test project / Test list, Test project / Delivery / Empty list)", exact: true });
  await expect(shipped).toContainText(task.title);
  await expect(shipped).toContainText("Available in Test project / Test list, Test project / Delivery / Empty list");
  await expect(page.getByRole("region", { name: "Shipped (Test project / Delivery / Test list)", exact: true })).toContainText("Available in Test project / Delivery / Test list");
  await expect(page.getByRole("region", { name: "Planned", exact: true })).toContainText("Nothing here yet");
  await expect(page.getByRole("region", { name: "QA", exact: true })).toContainText("Nested task");
  const ownMove = page.getByRole("combobox", { name: `Move ${task.title} to status` });
  await expect(ownMove.locator("option")).toHaveText(["Ready", "Shipped", "Planned"]);
  const otherMove = page.getByRole("combobox", { name: "Move Other task to status" });
  await expect(otherMove.locator('option[value="shipped"]')).toHaveCount(0);
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await dataTransfer.evaluate(data => data.setData("text/plain", "other-task"));
  await shipped.dispatchEvent("drop", { dataTransfer });
  expect(mutations.filter(m => m.method === "PATCH")).toHaveLength(0);
  await ownMove.selectOption("todo");
  await expect(page.getByRole("region", { name: "Ready", exact: true })).toContainText(task.title);
  await expect(page.locator(".workspace-heading")).toContainText("0 complete");
  expect(mutations.at(-1)?.body).toMatchObject({ status: "todo", expectedUpdatedAt: task.updatedAt });
  await page.getByTitle("project: Test project", { exact: true }).click();
  await expect(page.getByLabel("Filter status").locator("option")).toHaveText(["All statuses", "Ready", "Shipped", "Planned", "QA"]);
  await page.getByLabel("Filter status").selectOption("shipped");
  await expect(page.locator(".workspace-footer")).toContainText("0 tasks");
  await page.getByTitle("project: Other project", { exact: true }).click();
  await expect(page.getByLabel("Filter status")).toHaveValue("");
  await expect(page.locator(".workspace-footer")).toContainText("1 task");
});

test("list-view column reorder drives the table headers and persists through the order bar", async ({ page }) => {
  const { state } = await setup(page);
  state.projectFields = [{ projectId: state.nodes[0].id, fieldIds: [], builtInFields: ["description"], updatedAt: "v1" }];
  const patches: Record<string, unknown>[] = [];
  await page.route(`**/api/v1/workspaces/${wid}/projects/${state.nodes[0].id}/fields`, route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    patches.push(body);
    state.projectFields = [{ projectId: state.nodes[0].id, fieldIds: body.fieldIds as string[], builtInFields: body.builtInFields as typeof state.projectFields[number]["builtInFields"], updatedAt: "v2" }];
    return route.fulfill({ json: state.projectFields[0] });
  });
  await page.goto("/app");
  await page.getByTitle("project: Test project", { exact: true }).click();
  const names = page.locator(".list-section .task-table thead .task-column-name");
  await expect(names).toHaveText(["Task", "Status", "Assignee", "Due date", "Description"]);
  // Register the save listener before clicking: the mocked PATCH completes
  // within milliseconds of the reorder.
  const saveResponse = page.waitForResponse(`**/api/v1/workspaces/${wid}/projects/${state.nodes[0].id}/fields`);
  await page.getByRole("button", { name: "Move Description column left", exact: true }).click();
  // The applied bar order is the table's order source; a local-state-only
  // table would keep the old headers (the original no-op bug).
  await expect(names).toHaveText(["Task", "Status", "Assignee", "Description", "Due date"]);
  expect((await saveResponse).status()).toBe(200);
  await expect(page.locator(".column-order-list li > span")).toHaveText(["Task", "Status", "Assignee", "Description", "Due date"]);
  // The saved order must survive the metadata refresh remount, not just the
  // immediate render.
  await expect(names).toHaveText(["Task", "Status", "Assignee", "Description", "Due date"]);
  expect(patches[0]).toEqual({ fieldIds: [], builtInFields: ["title", "status", "assigneeId", "description", "dueDate"], expectedUpdatedAt: "v1" });
});

test("subtasks indent under their parent in list view with accessible ancestry", async ({ page }) => {
  await setup(page, [
    { ...task, id: "orphan-task", title: "Orphan task", parentId: "missing-parent" },
    { ...task, id: "child-task", title: "Child task", parentId: task.id },
    task,
    { ...task, id: "grandchild-task", title: "Grandchild task", parentId: "child-task" },
    { ...task, id: "cycle-a", title: "Cycle A", parentId: "cycle-b" },
    { ...task, id: "cycle-b", title: "Cycle B", parentId: "cycle-a" },
  ]);
  await page.goto("/app");
  const titles = page.locator(".list-section .task-table tbody .task-title");
  await expect(titles).toHaveText(["Orphan task", task.title, "Child task", "Grandchild task", "Cycle A", "Cycle B"]);
  const depths = await page.locator(".list-section .task-table tbody td[data-column='title']").evaluateAll(cells => cells.map(cell => cell.getAttribute("data-subtask-depth")));
  expect(depths).toEqual([null, null, "1", "2", "1", "1"]);
  await expect(page.locator(".list-section .task-table .sr-only")).toHaveText([
    "Subtask of Verify the release",
    "Subtask of Child task",
    "Subtask of Cycle B",
    "Subtask of Cycle A",
  ]);
  const indents = await page.locator(".list-section .task-table tbody td[data-column='title']").evaluateAll(cells => cells.map(cell => Number.parseFloat(getComputedStyle(cell).paddingLeft)));
  expect(indents[2]).toBeGreaterThan(indents[1]);
  expect(indents[3]).toBeGreaterThan(indents[2]);
});

test("desktop task containers fill available width", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await setup(page);
  await page.goto("/app");
  await expect(page.getByRole("button", { name: task.title, exact: true })).toBeVisible();
  for (const [view, selector] of [["List", ".task-table-scroll"], ["Gallery", ".gallery-grid"], ["Board", ".board"], ["Timeline", ".gantt-scroll"]]) {
    await page.getByRole("tab", { name: view, exact: true }).click();
    const container = page.locator(selector);
    await expect(container).toBeVisible();
    const sizes = await container.evaluate(element => ({
      width: element.clientWidth,
      panel: document.getElementById("task-view")!.clientWidth,
      page: document.documentElement.scrollWidth, viewport: window.innerWidth,
    }));
    expect(sizes.page).toBeLessThanOrEqual(sizes.viewport);
    expect(Math.abs(sizes.width - sizes.panel)).toBeLessThanOrEqual(2);
  }
});
