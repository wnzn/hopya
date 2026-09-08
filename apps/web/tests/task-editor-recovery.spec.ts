import { test, expect, type Page, type Route } from "@playwright/test";
import type { Detail, Item } from "../src/lib/api";
import { detail, fixture, listId, task, wid } from "./fixture";

const itemPath = `**/api/v1/workspaces/${wid}/items/${task.id}`;
const attachmentPath = `${itemPath}/attachments`;
const fields: Detail["fields"] = [
  ...detail.fields,
  { id: "note", name: "Reference", type: "text" },
  { id: "checkDate", name: "Check date", type: "date" },
];
const oldAttachment = {
  id: "old-attachment", name: "old.txt", contentType: "text/plain", size: 3,
};
const newAttachment = {
  id: "new-attachment", name: "new.txt", contentType: "text/plain", size: 3,
};

async function openTask(page: Page, title = task.title) {
  await page.goto("/app");
  await page.getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible();
}

test("conflict recovery confirms discard, retains drafts on failed GET, and saves against the fetched version", async ({ page }) => {
  const { errors } = await fixture(page);
  const patches: Record<string, unknown>[] = [];
  let gets = 0;
  let reload: Route | undefined;
  let current: Item = {
    ...task, title: "Another writer's title", description: "Another writer's context",
    updatedAt: "2026-09-06T12:00:00.001Z",
  };
  await page.route(itemPath, async (route) => {
    if (route.request().method() === "GET") {
      gets++;
      if (gets === 1)
        return route.fulfill({ status: 503, json: { error: "Current task unavailable" } });
      reload = route;
      return;
    }
    const body = route.request().postDataJSON();
    patches.push(body);
    if (body.expectedUpdatedAt !== current.updatedAt)
      return route.fulfill({ status: 409, json: { error: "Task changed. Reload the task before saving." } });
    current = { ...current, ...body, updatedAt: "2026-09-06T12:00:00.002Z" };
    return route.fulfill({ json: current });
  });
  await page.route(`**/api/v1/workspaces/${wid}/items/page?*`, (route) =>
    route.fulfill({ json: { items: [patches.length > 1 ? current : task], nextCursor: null } }),
  );
  await openTask(page);
  await page.getByLabel("Title", { exact: true }).fill("Unsaved local title");
  await page.getByRole("textbox", { name: "Body", exact: true }).fill("Unsaved local context");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Task changed");
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(gets).toBe(0);
  expect(patches).toHaveLength(1);
  await page.getByLabel("New tag", { exact: true }).fill("pending local tag");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toMatch(/discard/i);
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Reload current task" }).click();
  expect(gets).toBe(0);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Unsaved local title");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload current task" }).click();
  await expect(page.getByRole("alert")).toContainText("Current task unavailable");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Unsaved local title");
  await expect(page.getByRole("textbox", { name: "Body", exact: true })).toHaveText("Unsaved local context", { useInnerText: true });
  await expect(page.getByLabel("New tag", { exact: true })).toHaveValue("pending local tag");
  expect(patches).toHaveLength(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload current task" }).click();
  await expect.poll(() => gets).toBe(2);
  await expect(page.getByLabel("Title", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Unsaved local title");
  await expect(page.getByRole("button", { name: "Reloading...", exact: true })).toBeDisabled();
  await reload!.fulfill({ json: current });
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(current.title);
  await expect(page.getByRole("textbox", { name: "Body", exact: true })).toHaveText(current.description, { useInnerText: true });
  await expect(page.getByLabel("New tag", { exact: true })).toHaveValue("");
  await page.getByLabel("Title", { exact: true }).fill("Recovered edit");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(patches[1]).toEqual({ title: "Recovered edit", expectedUpdatedAt: "2026-09-06T12:00:00.001Z" });
  expect(gets).toBe(2);
  await page.getByRole("button", { name: "Recovered edit", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Body", exact: true })).toHaveText("Another writer's context", { useInnerText: true });
  expect(errors).toEqual([]);
});

test("same-named List destinations show full ancestry and IDs for equal paths", async ({ page }) => {
  const { mutations, errors } = await fixture(page);
  const nodes: Detail["nodes"] = [
    { id: "project-a", name: "Alpha", kind: "project", parentId: null },
    { id: "project-b", name: "Beta", kind: "project", parentId: null },
    { id: "folder-a", name: "Work", kind: "folder", parentId: "project-a" },
    { id: "folder-b", name: "Work", kind: "folder", parentId: "project-b" },
    { id: listId, name: "Tasks", kind: "list", parentId: "folder-a" },
    { id: "list-b", name: "Tasks", kind: "list", parentId: "folder-b" },
    { id: "list-c", name: "Tasks", kind: "list", parentId: "folder-b" },
  ];
  await page.route(`**/api/v1/workspaces/${wid}`, (route) => route.fulfill({ json: { ...detail, nodes } }));
  await openTask(page);
  const lists = page.getByRole("dialog").getByRole("combobox", { name: "List", exact: true });
  const labels = await lists.locator("option:not([disabled])").allTextContents();
  expect(labels).toEqual(["Alpha / Work / Tasks", "Beta / Work / Tasks (list-b)", "Beta / Work / Tasks (list-c)"]);
  expect(new Set(labels).size).toBe(labels.length);
  await lists.selectOption({ label: "Beta / Work / Tasks (list-c)" });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations.at(-1)?.body).toEqual({ nodeId: "list-c", expectedUpdatedAt: task.updatedAt });
  expect(errors).toEqual([]);
});

test("new-task 409 preserves its draft and permits an explicit corrected creation", async ({ page }) => {
  const { mutations, errors } = await fixture(page);
  const attempts: Record<string, unknown>[] = [];
  await page.route(`**/api/v1/workspaces/${wid}/items`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1)
      return route.fulfill({ status: 409, json: { error: "Creation conflict. Review the task and try again." } });
    return route.fallback();
  });
  await page.goto("/app");
  await page.getByRole("button", { name: "New task", exact: false }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title", { exact: true }).fill("Initial creation draft");
  await dialog.getByRole("textbox", { name: "Body", exact: true }).fill("Keep this context");
  await dialog.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Creation conflict");
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("Initial creation draft");
  await expect(dialog.getByRole("textbox", { name: "Body", exact: true })).toHaveText("Keep this context", { useInnerText: true });
  await expect(dialog.getByRole("button", { name: "Reload current task" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Create task", exact: true })).toBeEnabled();
  expect(attempts).toHaveLength(1);
  await dialog.getByLabel("Title", { exact: true }).fill("Corrected creation draft");
  await dialog.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Corrected creation draft", exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toMatchObject({ title: "Corrected creation draft", description: "Keep this context" });
  expect(attempts[1]).not.toHaveProperty("expectedUpdatedAt");
  expect(mutations.filter((mutation) => mutation.method === "POST")).toHaveLength(1);
  expect(errors).toEqual([]);
});

for (const width of [1280, 320]) {
test(`read-only viewers can keyboard-select and scroll full text at ${width}px without changing any field`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const title = "Long task title ".repeat(18);
  const description = Array.from({ length: 240 }, (_, index) => `Line ${index}: complete task context`).join("\n");
  const note = "Full custom reference ".repeat(80);
  const { mutations, errors } = await fixture(page, { fields, items: [{ ...task, title, description, customFields: { ...task.customFields, note } }] });
  await page.route(`**/api/v1/workspaces/${wid}`, (route) => route.fulfill({ json: { ...detail, fields, permissions: ["items:read"] } }));
  await openTask(page, title);
  const titleInput = page.getByLabel("Title", { exact: true });
  await expect(titleInput).toBeFocused();
  for (const [name, value] of [["Title", title], ["Body", description], ["Reference", note]]) {
    const input = page.getByRole("textbox", { name, exact: true });
    await expect(input).toBeEnabled();
    if (name === "Body") {
      // The rich editor keeps a caret for viewers so text stays
      // keyboard-selectable and scrollable, while mutations stay blocked.
      await expect(input).toHaveAttribute("contenteditable", "true");
      await expect(input).toHaveAttribute("aria-readonly", "true");
      await titleInput.press("Tab");
      await expect(input).toBeFocused();
      await expect(input).toHaveText(description, { useInnerText: true });
      await expect.poll(() => input.evaluate((element) => element.scrollTop)).toBe(0);
      for (let scrolled = 0; scrolled < 40; scrolled++) {
        const done = await input.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop <= 1);
        if (done) break;
        await input.press("PageDown");
      }
      await expect.poll(() => input.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
      await expect(input).toHaveText(description, { useInnerText: true });
      await input.press("Control+a");
      expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(value);
      await input.press("Backspace");
      await input.press("x");
      await expect(input).toHaveText(description, { useInnerText: true });
      await input.press("Meta+ArrowUp");
      await input.press("Meta+ArrowDown");
      await expect(input).toHaveText(description, { useInnerText: true });
      await input.press("Meta+a");
      expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(value);
      await expect(input).toHaveText(description, { useInnerText: true });
      continue;
    }
    await expect(input).toHaveAttribute("readonly", "");
    await input.focus();
    await input.press("Control+Home");
    expect(await input.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => element.selectionStart)).toBe(0);
    await input.press("Control+End");
    expect(await input.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => element.selectionEnd)).toBe(value.length);
    await input.press("Control+a");
    expect(await input.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => element.value.slice(element.selectionStart!, element.selectionEnd!))).toBe(value);
    await input.press("Backspace");
    await input.press("x");
    await expect(input).toHaveValue(value);
    await input.press("Meta+ArrowUp");
    await input.press("Meta+ArrowDown");
    expect(await input.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([value.length, value.length]);
    await input.press("Meta+a");
    expect(await input.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => element.value.slice(element.selectionStart!, element.selectionEnd!))).toBe(value);
  }
  for (const name of ["List", "Status", "Priority", "Assignee", "Category"])
    await expect(page.getByRole("dialog").getByRole("combobox", { name, exact: true })).toBeDisabled();
  await expect(page.getByLabel("Approved", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
  expect(await page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});
}

test("delayed initial attachments serialize with upload and cannot replace the distinct post-upload or post-delete snapshot", async ({ page }) => {
  const { errors } = await fixture(page);
  const reads: Route[] = [];
  let uploads = 0;
  await page.route(attachmentPath, async (route) => {
    if (route.request().method() === "GET") { reads.push(route); return; }
    uploads++;
    await route.fulfill({ json: newAttachment });
  });
  await openTask(page);
  await expect.poll(() => reads.length).toBe(1);
  await expect(page.getByText("Loading attachments...", { exact: true })).toBeVisible();
  await expect(page.getByText("No attachments yet.", { exact: true })).toHaveCount(0);
  const upload = page.getByLabel("Attach a file");
  await expect(upload).toBeDisabled();
  expect(uploads).toBe(0);
  await reads[0].fulfill({ json: [oldAttachment] });
  await expect(page.getByRole("link", { name: "old.txt", exact: true })).toBeVisible();
  await expect(upload).toBeEnabled();
  await upload.setInputFiles({ name: "new.txt", mimeType: "text/plain", buffer: Buffer.from("new") });
  await expect.poll(() => reads.length).toBe(2);
  await expect(upload).toBeDisabled();
  await expect(page.getByRole("link", { name: "new.txt", exact: true })).toHaveCount(0);
  await reads[1].fulfill({ json: [oldAttachment, newAttachment] });
  await expect(page.getByRole("link", { name: "new.txt", exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete attachment old.txt", exact: true }).click();
  await expect(page.getByRole("link", { name: "old.txt", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "new.txt", exact: true })).toBeVisible();
  expect(uploads).toBe(1);
  expect(reads).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("failed attachment GET is not empty and has an explicit retry", async ({ page }) => {
  const { errors } = await fixture(page);
  let gets = 0;
  await page.route(attachmentPath, (route) => {
    gets++;
    return gets === 1
      ? route.fulfill({ status: 503, json: { error: "Attachment listing unavailable" } })
      : route.fulfill({ json: [newAttachment] });
  });
  await openTask(page);
  await expect(page.getByRole("alert")).toContainText("Attachment listing unavailable");
  await expect(page.getByText("No attachments yet.", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Attach a file")).toBeDisabled();
  await page.getByRole("button", { name: "Retry attachments" }).click();
  await expect(page.getByRole("link", { name: "new.txt", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Attach a file")).toBeEnabled();
  expect(gets).toBe(2);
  expect(errors).toEqual([]);
});

test("closing a pending attachment read cannot leak its snapshot into a reopened task", async ({ page }) => {
  const { errors } = await fixture(page);
  const reads: Route[] = [];
  await page.route(attachmentPath, (route) => { reads.push(route); });
  await openTask(page);
  await expect.poll(() => reads.length).toBe(1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: task.title, exact: true }).click();
  await expect.poll(() => reads.length).toBe(2);
  await reads[1].fulfill({ json: [newAttachment] });
  await expect(page.getByRole("link", { name: "new.txt", exact: true })).toBeVisible();
  await reads[0].fulfill({ json: [oldAttachment] });
  await expect(page.getByRole("link", { name: "old.txt", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "new.txt", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("failed post-upload listing retries only the read and does not report an empty list", async ({ page }) => {
  const { errors } = await fixture(page);
  let gets = 0;
  let uploads = 0;
  await page.route(attachmentPath, (route) => {
    if (route.request().method() === "POST") {
      uploads++;
      return route.fulfill({ json: newAttachment });
    }
    gets++;
    if (gets === 2)
      return route.fulfill({ status: 503, json: { error: "Refresh unavailable after upload" } });
    return route.fulfill({ json: gets === 1 ? [] : [newAttachment] });
  });
  await openTask(page);
  await expect(page.getByText("No attachments yet.", { exact: true })).toBeVisible();
  await page.getByLabel("Attach a file").setInputFiles({ name: "new.txt", mimeType: "text/plain", buffer: Buffer.from("new") });
  await expect(page.getByRole("alert")).toContainText("Refresh unavailable after upload");
  await expect(page.getByText("No attachments yet.", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Attach a file")).toBeDisabled();
  await page.getByRole("button", { name: "Retry attachments" }).click();
  await expect(page.getByRole("link", { name: "new.txt", exact: true })).toBeVisible();
  await expect(page.getByLabel("Attach a file")).toBeEnabled();
  expect(gets).toBe(3);
  expect(uploads).toBe(1);
  expect(errors).toEqual([]);
});

test("custom fields clear to null while an explicit unchecked checkbox remains false", async ({ page }) => {
  const { mutations, errors } = await fixture(page, {
    fields,
    items: [{ ...task, customFields: { effort: 0, approved: true, category: "One", note: "Reference text", checkDate: "2026-09-06" } }],
  });
  await openTask(page);
  await page.getByLabel("Approved", { exact: true }).uncheck();
  await page.getByLabel("Effort", { exact: true }).fill("");
  await page.getByLabel("Reference", { exact: true }).fill("");
  await page.getByLabel("Check date", { exact: true }).fill("");
  await page.getByRole("textbox", { name: "Body", exact: true }).fill("");
  await page.getByLabel("Start date", { exact: true }).fill("");
  await page.getByLabel("Due date", { exact: true }).fill("");
  await page.getByRole("combobox", { name: "Assignee", exact: true }).selectOption("");
  await page.getByRole("button", { name: "Remove tag verification", exact: true }).click();
  await page.getByRole("combobox", { name: "Category", exact: true }).selectOption("");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations.at(-1)?.body.customFields).toEqual({ effort: null, approved: false, category: null, note: null, checkDate: null });
  expect(mutations.at(-1)?.body).toMatchObject({ description: "", startDate: null, dueDate: null, assigneeId: null, tags: [] });
  await page.getByRole("button", { name: task.title, exact: true }).click();
  await expect(page.getByLabel("Approved", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Approved", { exact: true })).toHaveAccessibleDescription("No");
  await expect(page.getByRole("textbox", { name: "Body", exact: true })).toHaveText("", { useInnerText: true });
  await expect(page.getByLabel("Start date", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Due date", { exact: true })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Assignee", exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Clear Approved", exact: true }).click();
  await expect(page.getByLabel("Approved", { exact: true })).toHaveAccessibleDescription("Not set");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations.at(-1)?.body.customFields).toEqual({ effort: null, approved: null, category: null, note: null, checkDate: null });
  await page.getByRole("button", { name: task.title, exact: true }).click();
  await expect(page.getByRole("button", { name: "Clear Approved", exact: true })).toBeDisabled();
  await page.getByLabel("Approved", { exact: true }).check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((mutations.at(-1)?.body.customFields as Record<string, unknown>).approved).toBe(true);
  expect(errors).toEqual([]);
});
