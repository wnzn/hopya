import { expect, test, type Page } from "@playwright/test";
import type { Detail, Field } from "../src/lib/api";
import { detail, fixture, task, wid } from "./fixture";

async function setup(page: Page) {
  const fields: Field[] = [
    { id: "check", name: "Release checks", type: "checklist", options: ["Build", "Review"] },
    { id: "rating", name: "Confidence", type: "rating", settings: { maxRating: 7 } },
    { id: "time", name: "Meeting", type: "datetime", settings: { dateFormat: "MMMM d, yyyy" } },
    { id: "date", name: "Launch", type: "date" },
  ];
  const original = await fixture(page, { fields, items: [{ ...task, customFields: { ...task.customFields, check: ["Build"], rating: 4, time: "2026-09-07T04:30:00.000Z", date: "2026-09-09" } }] });
  const metadata: Detail = structuredClone({ ...detail, fields, projectFields: [{ projectId: detail.nodes[0].id, fieldIds: fields.map(field => field.id), builtInFields: [], updatedAt: "v1", dateFormat: "dd/MM/yyyy", statuses: [{ id: "todo", name: "Ready", color: "#ffffff", completed: false }, { id: "shipped", name: "Released", color: "#000000", completed: true }] }], listStatusConfigs: [{ listId: task.nodeId, updatedAt: "list-v1", inheritedProjectUpdatedAt: "v1" }] });
  const writes: Record<string, unknown>[] = [];
  await page.route(`**/api/v1/workspaces/${wid}`, route => {
    const listConfig = metadata.listStatusConfigs![0];
    if (listConfig.statuses === undefined) listConfig.inheritedProjectUpdatedAt = metadata.projectFields![0].updatedAt;
    return route.fulfill({ json: metadata });
  });
  await page.route(`**/api/v1/workspaces/${wid}/projects/*/fields`, async route => {
    const config = metadata.projectFields![0];
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON(); writes.push(body);
      if (body.expectedUpdatedAt !== config.updatedAt) return route.fulfill({ status: 409, json: { error: "Stale project" } });
      Object.assign(config, body, { updatedAt: `${config.updatedAt}-next` });
    }
    await route.fulfill({ json: config });
  });
  await page.route(`**/api/v1/workspaces/${wid}/lists/*/statuses`, async route => {
    const config = metadata.listStatusConfigs![0];
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON(); writes.push(body);
      if (body.expectedUpdatedAt !== config.updatedAt) return route.fulfill({ status: 409, json: { error: "Stale list" } });
      if (config.statuses === undefined && body.statuses !== null && body.expectedProjectUpdatedAt !== config.inheritedProjectUpdatedAt)
        return route.fulfill({ status: 409, json: { error: "Stale project" } });
      if (body.statuses === null) delete config.statuses;
      else config.statuses = body.statuses;
      config.updatedAt = `${config.updatedAt}-next`;
    }
    await route.fulfill({ json: config });
  });
  await page.route(`**/api/v1/workspaces/${wid}/fields/*`, async route => {
    const body = route.request().postDataJSON(); writes.push(body);
    const field = metadata.fields.find(field => route.request().url().endsWith(field.id))!;
    Object.assign(field, body); await route.fulfill({ json: field });
  });
  await page.route(`**/api/v1/workspaces/${wid}/fields`, async route => {
    const body = route.request().postDataJSON(); writes.push(body);
    const field = { ...body, id: `new-field-${writes.length}` } as Field;
    metadata.fields.push(field);
    if (body.projectId) { metadata.projectFields![0].fieldIds.push(field.id); metadata.projectFields![0].updatedAt += "-created"; }
    await route.fulfill({ json: field });
  });
  return { ...original, metadata, writes };
}

test("full editor saves typed values, project status and unchanged sibling data", async ({ page }) => {
  const { mutations, errors } = await setup(page);
  await page.goto("/app"); await page.getByRole("button", { name: task.title, exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Task details", exact: true });
  await expect(editor.getByRole("combobox", { name: "Status", exact: true }).getByRole("option", { name: "Ready" })).toHaveCount(1);
  await editor.getByRole("combobox", { name: "Status", exact: true }).selectOption("shipped");
  await editor.getByRole("button", { name: "Release checks: Build", exact: true }).click();
  await editor.getByRole("checkbox", { name: "Review", exact: true }).check();
  await editor.getByRole("spinbutton", { name: "Confidence", exact: true }).fill("7");
  await editor.getByLabel("Meeting", { exact: true }).fill("2026-09-08T10:15");
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(mutations.at(-1)?.body).toMatchObject({ status: "shipped", expectedUpdatedAt: task.updatedAt, customFields: { ...task.customFields, check: ["Build", "Review"], rating: 7, date: "2026-09-09" } });
  expect(String((mutations.at(-1)?.body.customFields as Record<string, unknown>).time)).toMatch(/^2026-09-08T.*Z$/);
  expect(errors).toEqual([]);
});

test("List inline controls save checklist, rating and datetime with formatted display", async ({ page }) => {
  const { mutations, errors } = await setup(page);
  await page.goto("/app");
  await expect(page.getByRole("button", { name: `Edit ${task.title} Launch`, exact: true })).toHaveText("09/09/2026");
  await expect(page.getByRole("button", { name: `Edit ${task.title} Meeting`, exact: true })).toContainText("September 7, 2026");
  await page.getByRole("button", { name: `Edit ${task.title} Release checks`, exact: true }).click();
  await page.getByRole("button", { name: "Release checks: Build", exact: true }).click();
  await page.getByRole("checkbox", { name: "Review", exact: true }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: `Edit ${task.title} Confidence`, exact: true }).click();
  await page.getByRole("spinbutton", { name: "Confidence", exact: true }).fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: `Edit ${task.title} Meeting`, exact: true }).click();
  await page.getByLabel("Meeting", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: `Edit ${task.title} Meeting`, exact: true })).toHaveText("-");
  expect(mutations.at(-1)?.body.customFields).toMatchObject({ ...task.customFields, check: ["Build", "Review"], rating: null, time: null });
  expect(errors).toEqual([]);
});

test("project settings retain a conflicting draft and require explicit reload", async ({ page }) => {
  const { metadata, writes } = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings"); await page.getByRole("button", { name: "Project fields", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Project fields", exact: true });
  await dialog.getByRole("combobox", { name: "Project or list", exact: true }).selectOption(detail.nodes[0].id);
  await expect(dialog.getByRole("button", { name: "Save project settings", exact: true })).toBeEnabled();
  await dialog.getByRole("textbox", { name: "Status name", exact: true }).first().fill("In queue");
  metadata.projectFields![0].updatedAt = "remote-v2";
  await dialog.getByRole("button", { name: "Save project settings", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Your draft is kept");
  await expect(dialog.getByRole("textbox", { name: "Status name", exact: true }).first()).toHaveValue("In queue");
  page.once("dialog", prompt => prompt.accept());
  await dialog.getByRole("button", { name: "Reload project settings", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Save project settings", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("textbox", { name: "Status name", exact: true }).first()).toHaveValue("Ready");
  await dialog.getByRole("button", { name: "Save project settings", exact: true }).click();
  await expect(dialog.getByText("Project settings saved.", { exact: true })).toBeVisible();
  expect(writes.at(-1)).toMatchObject({ expectedUpdatedAt: "remote-v2" });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("workspace field editing persists settings and options", async ({ page }) => {
  const { writes } = await setup(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Edit field Confidence", exact: true }).click();
  let editor = page.getByRole("dialog", { name: "Edit field Confidence", exact: true });
  await editor.getByLabel("Maximum rating", { exact: true }).fill("10");
  await editor.getByRole("button", { name: "Save field", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes.at(-1)).toMatchObject({ settings: { maxRating: 10 } });
  await page.getByRole("button", { name: "Edit field Release checks", exact: true }).click();
  editor = page.getByRole("dialog", { name: "Edit field Release checks", exact: true });
  await editor.getByRole("textbox", { name: "Options, one per line", exact: true }).fill("Build\nReview\nPublish");
  await editor.getByRole("button", { name: "Save field", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes.at(-1)).toMatchObject({ options: ["Build", "Review", "Publish"] });
});

async function openConfiguration(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Project fields", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Project fields", exact: true });
  await dialog.getByRole("combobox", { name: "Project or list", exact: true }).selectOption(detail.nodes[0].id);
  await expect(dialog.getByRole("button", { name: "Apply fields", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Save project settings", exact: true })).toBeEnabled();
  return dialog;
}

for (const create of [false, true]) test(`${create ? "create-and-assign" : "apply fields"} advances settings revision without discarding status/date drafts`, async ({ page }) => {
  const { metadata, writes } = await setup(page);
  const dialog = await openConfiguration(page);
  await dialog.getByRole("textbox", { name: "Status name", exact: true }).first().fill("Triage draft");
  await dialog.getByRole("combobox", { name: "Project date format", exact: true }).selectOption("MMM d, yyyy");
  if (create) {
    await dialog.getByRole("textbox", { name: "Field name", exact: true }).fill("New checklist");
    await dialog.getByRole("combobox", { name: "Type", exact: true }).selectOption("checklist");
    await dialog.getByRole("textbox", { name: "Options, one per line", exact: true }).fill("One\nTwo\nOne");
    await dialog.getByRole("button", { name: "Create field and add", exact: true }).click();
    await expect(dialog.getByText(/Field created and added/)).toBeVisible();
    expect(writes.at(-1)).toMatchObject({ name: "New checklist", type: "checklist", projectId: detail.nodes[0].id, options: ["One", "Two"] });
  } else {
    await dialog.getByRole("checkbox", { name: "Confidence Rating", exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
    await expect(dialog.getByText("Project fields updated.", { exact: true })).toBeVisible();
  }
  const revision = metadata.projectFields![0].updatedAt;
  await expect(dialog.getByRole("textbox", { name: "Status name", exact: true }).first()).toHaveValue("Triage draft");
  await expect(dialog.getByRole("combobox", { name: "Project date format", exact: true })).toHaveValue("MMM d, yyyy");
  await dialog.getByRole("button", { name: "Save project settings", exact: true }).click();
  await expect(dialog.getByText("Project settings saved.", { exact: true })).toBeVisible();
  expect(writes.at(-1)).toMatchObject({ expectedUpdatedAt: revision, dateFormat: "MMM d, yyyy" });
  expect(metadata.projectFields![0].statuses![0].name).toBe("Triage draft");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("settings advances field revision while keeping assignment and creation drafts", async ({ page }) => {
  const { metadata, writes } = await setup(page);
  const dialog = await openConfiguration(page);
  await dialog.getByRole("checkbox", { name: "Confidence Rating", exact: true }).uncheck();
  await dialog.getByRole("checkbox", { name: "Priority Built-in", exact: true }).check();
  await dialog.getByRole("textbox", { name: "Field name", exact: true }).fill("Keep creation draft");
  await dialog.getByRole("textbox", { name: "Status name", exact: true }).first().fill("Queued");
  await dialog.getByRole("button", { name: "Save project settings", exact: true }).click();
  await expect(dialog.getByText("Project settings saved.", { exact: true })).toBeVisible();
  const revision = metadata.projectFields![0].updatedAt;
  await expect(dialog.getByRole("checkbox", { name: "Confidence Rating", exact: true })).not.toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Priority Built-in", exact: true })).toBeChecked();
  await expect(dialog.getByRole("textbox", { name: "Field name", exact: true })).toHaveValue("Keep creation draft");
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect(dialog.getByText("Project fields updated.", { exact: true })).toBeVisible();
  expect(writes.at(-1)).toMatchObject({ expectedUpdatedAt: revision, fieldIds: ["check", "time", "date"], builtInFields: ["priority"] });
  expect(metadata.projectFields![0].statuses![0].name).toBe("Queued");
});

test("list status override keeps its draft across field metadata refresh and a conflict", async ({ page }) => {
  const { metadata, writes } = await setup(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Project fields", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Project fields", exact: true });
  await dialog.getByRole("combobox", { name: "Project or list", exact: true }).selectOption(task.nodeId);
  await expect(dialog.getByRole("radio", { name: "Use project statuses", exact: true })).toBeChecked();
  metadata.projectFields![0].statuses![0].name = "Project rebased";
  await dialog.getByRole("checkbox", { name: "Confidence Rating", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await dialog.getByRole("radio", { name: "Override statuses for this list", exact: true }).check();
  await expect(dialog.getByRole("textbox", { name: "Status name", exact: true }).first()).toHaveValue("Project rebased");
  await dialog.getByRole("button", { name: "Move Project rebased down", exact: true }).click();
  await dialog.getByRole("button", { name: "Move Project rebased up", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Status name", exact: true }).first().fill("List queue");
  await dialog.getByRole("checkbox", { name: "Confidence Rating", exact: true }).check();
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Status name", exact: true }).first()).toHaveValue("List queue");
  metadata.listStatusConfigs![0].updatedAt = "list-remote";
  await dialog.getByRole("button", { name: "Save list statuses", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Your draft is kept");
  await expect(dialog.getByRole("textbox", { name: "Status name", exact: true }).first()).toHaveValue("List queue");
  page.once("dialog", prompt => prompt.accept());
  await dialog.getByRole("button", { name: "Reload list statuses", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Save list statuses", exact: true })).toBeEnabled();
  await dialog.getByRole("radio", { name: "Override statuses for this list", exact: true }).check();
  await dialog.getByRole("textbox", { name: "Status name", exact: true }).first().fill("List queue");
  await dialog.getByRole("button", { name: "Save list statuses", exact: true }).click();
  await expect(dialog.getByText("List statuses saved.", { exact: true })).toBeVisible();
  expect(writes.at(-1)).toMatchObject({ expectedUpdatedAt: "list-remote", expectedProjectUpdatedAt: "v1-next-next" });
  expect((writes.at(-1)!.statuses as { id: string; name: string }[])[0]).toMatchObject({ id: "todo", name: "List queue" });
  await dialog.getByRole("radio", { name: "Use project statuses", exact: true }).check();
  await dialog.getByRole("button", { name: "Save list statuses", exact: true }).click();
  await expect(dialog.getByText("List statuses saved.", { exact: true })).toBeVisible();
  expect(writes.at(-1)).toMatchObject({ statuses: null, expectedUpdatedAt: "list-remote-next" });
});

test("create-and-assign refresh does not rebase an overlapping external settings change", async ({ page }) => {
  const { metadata, writes } = await setup(page);
  const dialog = await openConfiguration(page);
  await dialog.getByRole("textbox", { name: "Status name", exact: true }).first().fill("Local status");
  metadata.projectFields![0].statuses![0].name = "Remote status";
  metadata.projectFields![0].updatedAt = "remote";
  await dialog.getByRole("textbox", { name: "Field name", exact: true }).fill("New date");
  await dialog.getByRole("combobox", { name: "Type", exact: true }).selectOption("date");
  await dialog.getByRole("combobox", { name: "Date display format", exact: true }).selectOption("MMM d, yyyy");
  await dialog.getByRole("button", { name: "Create field and add", exact: true }).click();
  await expect(dialog.getByText(/Field created and added/)).toBeVisible();
  expect(writes.at(-1)).toMatchObject({ name: "New date", type: "date", projectId: detail.nodes[0].id, settings: { dateFormat: "MMM d, yyyy" } });
  await dialog.getByRole("button", { name: "Save project settings", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("changed elsewhere");
  await expect(dialog.getByRole("textbox", { name: "Status name", exact: true }).first()).toHaveValue("Local status");
  expect(writes.at(-1)?.expectedUpdatedAt).toBe("v1");
  expect(metadata.projectFields![0].statuses![0].name).toBe("Remote status");
});

test("settings refresh does not rebase external assignments written after its PATCH", async ({ page }) => {
  const { metadata, writes } = await setup(page);
  const dialog = await openConfiguration(page);
  await dialog.getByRole("checkbox", { name: "Confidence Rating", exact: true }).uncheck();
  await page.route(`**/api/v1/workspaces/${wid}`, route => {
    metadata.projectFields![0].fieldIds = ["check", "rating"];
    metadata.projectFields![0].updatedAt = "external-assignment";
    return route.fulfill({ json: metadata });
  });
  await dialog.getByRole("button", { name: "Save project settings", exact: true }).click();
  await expect(dialog.getByText("Project settings saved.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("changed elsewhere");
  await expect(dialog.getByRole("checkbox", { name: "Confidence Rating", exact: true })).not.toBeChecked();
  expect(writes.at(-1)?.expectedUpdatedAt).toBe("v1");
  expect(metadata.projectFields![0].fieldIds).toEqual(["check", "rating"]);
});

test("invalid proposal destination uses actual destination's first status even when todo exists", async ({ page }) => {
  const { metadata, mutations } = await setup(page);
  metadata.projectFields![0].statuses!.unshift({ id: "triage", name: "Triage", color: "#64748b", completed: false });
  metadata.nodes.push({ id: "other-project", name: "Other project", kind: "project", parentId: null });
  metadata.projectFields!.push({ projectId: "other-project", fieldIds: [], builtInFields: [], updatedAt: "other-v1", statuses: [{ id: "other", name: "Other", color: "#64748b", completed: false }] });
  await page.goto("/app");
  await page.route(`**/api/v1/workspaces/${wid}/agent`, route => route.fulfill({ json: { reply: "Review", proposal: { title: "Proposed task", nodeId: "other-project" } } }));
  await page.getByRole("button", { name: "Assistant", exact: false }).click();
  await page.getByRole("textbox", { name: "Message the assistant", exact: true }).fill("Propose a task");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Review suggestion", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Review suggested task", exact: true });
  await expect(editor.getByRole("combobox", { name: "List", exact: true })).toHaveValue(task.nodeId);
  await expect(editor.getByRole("combobox", { name: "Status", exact: true })).toHaveValue("triage");
  await editor.getByRole("textbox", { name: "Title", exact: true }).fill("First status task");
  await editor.getByRole("button", { name: "Confirm and create", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(mutations.at(-1)?.body).toMatchObject({ nodeId: task.nodeId, status: "triage" });
});
