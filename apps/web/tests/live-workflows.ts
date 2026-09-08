import { randomBytes, randomUUID } from "node:crypto";
import { expect, type Browser, type Page } from "@playwright/test";
import type { Detail, Field, Item, ProjectFieldConfiguration, TreeNode, User, Workspace } from "../src/lib/api";

// All records belong to live-smoke's disposable database; no routes are mocked.
export async function runLiveWorkflows(browser: Browser, admin: Page, origin: string) {
  const apiUrl = `${origin}/api/v1`;
  const headers = { Origin: origin };
  const contexts = [];
  const errors: string[] = [];
  async function create<T>(page: Page, path: string, data: unknown): Promise<T> {
    const response = await page.request.post(`${apiUrl}${path}`, { headers, data });
    expect(response.status(), `Provision ${path}`).toBe(201);
    return response.json() as Promise<T>;
  }
  async function read<T>(page: Page, path: string): Promise<T> {
    const response = await page.request.get(`${apiUrl}${path}`);
    expect(response.status(), `Read ${path}`).toBe(200);
    return response.json() as Promise<T>;
  }
  const responseFor = (page: Page, path: string, method: string) =>
    page.waitForResponse((response) =>
      response.url() === `${apiUrl}${path}` && response.request().method() === method,
    );
  try {
    const accounts = [];
    for (const name of ["Disposable workflow owner", "Disposable workflow editor"]) {
      const credentials = {
        name,
        email: `workflow-${randomUUID()}@example.test`,
        password: randomBytes(24).toString("base64url"),
      };
      const user = await create<User>(admin, "/admin/users", credentials);
      const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
      contexts.push(context);
      context.setDefaultTimeout(10_000);
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/login`);
      await page.getByLabel("Email", { exact: true }).fill(credentials.email);
      await page.getByLabel("Password", { exact: true }).fill(credentials.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page).toHaveURL(/\/app$/);
      accounts.push({ ...credentials, user, page });
    }
    const [owner, editor] = accounts;
    const page = owner.page;
    const second = editor.page;
    const workspace = await create<Workspace>(page, "/workspaces", { name: "Disposable control workflows" });
    const base = `/workspaces/${workspace.id}`;
    const project = await create<TreeNode>(page, `${base}/nodes`, { name: "Workflow project", kind: "project" });
    const list = await create<TreeNode>(page, `${base}/nodes`, { name: "Workflow list", kind: "list", parentId: project.id });
    const detail = await read<Detail>(page, base);
    const memberRole = detail.roles.find((role) => role.name === "Member")!;
    const viewerRole = detail.roles.find((role) => role.name === "Viewer")!;
    await create(page, `${base}/members`, { email: editor.email, roleId: memberRole.id });
    const fields: Field[] = [];
    for (const type of ["text", "number", "date", "select", "checkbox"] as const) {
      fields.push(await create<Field>(page, `${base}/fields`, {
        name: `Workflow ${type}`, type, projectId: project.id, ...(type === "select" ? { options: ["First", "Second"] } : {}),
      }));
    }
    const configPath = `${base}/projects/${project.id}/fields`;
    const assigned = await page.request.patch(`${apiUrl}${configPath}`, {
      headers, data: { builtInFields: ["priority"] },
    });
    expect(assigned.status()).toBe(200);
    const description = Array.from({ length: 60 }, (_, index) => `Description line ${index + 1}: full read-only context.`).join("\n");
    const task = await create<Item>(page, `${base}/items`, {
      nodeId: list.id, title: "Disposable workflow task", description,
      customFields: Object.fromEntries(fields.map((field, index) => [field.id, ["Seed text", 12, "2026-09-06", "First", true][index]])),
    });
    const taskPath = `${base}/items/${task.id}`;
    for (const client of [page, second]) {
      await client.goto(`${origin}/app`);
      await client.getByRole("button", { name: task.title, exact: true }).click();
      expect(errors, "Opening the populated task must not crash React").toEqual([]);
      await expect(client.getByRole("dialog", { name: "Task details" })).toBeVisible();
      await expect(client.getByRole("textbox", { name: "Body", exact: true })).toHaveText(description, { useInnerText: true });
    }

    // Both real editors opened the same version before either sends a PATCH.
    await page.getByRole("button", { name: "Edit priority", exact: true }).click();
    await page.getByRole("combobox", { name: "Priority", exact: true }).selectOption("high");
    let saving = responseFor(page, taskPath, "PATCH");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    const firstSave = await saving;
    expect(firstSave.status()).toBe(200);
    expect(firstSave.request().postDataJSON()).toEqual({ priority: "high", expectedUpdatedAt: task.updatedAt });
    const winner = await firstSave.json() as Item;
    await expect(page.getByRole("button", { name: "Edit priority", exact: true })).toHaveText("High");
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await second.getByRole("button", { name: "Edit title", exact: true }).click();
    await second.getByLabel("Title", { exact: true }).fill("Unsaved conflicting title");
    saving = responseFor(second, taskPath, "PATCH");
    await second.getByRole("button", { name: "Save changes", exact: true }).click();
    const conflict = await saving;
    expect(conflict.status()).toBe(409);
    expect(conflict.request().postDataJSON()).toEqual({ title: "Unsaved conflicting title", expectedUpdatedAt: task.updatedAt });
    await expect(second.getByRole("alert")).toBeVisible();
    await expect(second.getByLabel("Title", { exact: true })).toHaveValue("Unsaved conflicting title");
    await expect(second.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    expect(await read<Item>(page, taskPath)).toEqual(winner);
    second.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("Discard your draft and reload the current task?");
      await dialog.dismiss();
    });
    await second.getByRole("button", { name: "Reload current task", exact: true }).click();
    await expect(second.getByLabel("Title", { exact: true })).toHaveValue("Unsaved conflicting title");
    second.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("Discard your draft and reload the current task?");
      await dialog.accept();
    });
    const reloading = responseFor(second, taskPath, "GET");
    await second.getByRole("button", { name: "Reload current task", exact: true }).click();
    expect((await reloading).status()).toBe(200);
    await expect(second.getByRole("button", { name: "Edit title", exact: true })).toHaveText(task.title);
    await expect(second.getByRole("button", { name: "Edit priority", exact: true })).toHaveText("High");
    await expect(second.getByRole("alert")).toHaveCount(0);
    await expect(second.getByRole("button", { name: "Reload current task", exact: true })).toHaveCount(0);
    let current = winner;
    for (const priority of ["urgent", "low"] as const) {
      await second.getByRole("button", { name: "Edit priority", exact: true }).click();
      await second.getByRole("combobox", { name: "Priority", exact: true }).selectOption(priority);
      saving = responseFor(second, taskPath, "PATCH");
      await second.getByRole("button", { name: "Save changes", exact: true }).click();
      const saved = await saving;
      expect(saved.status()).toBe(200);
      expect(saved.request().postDataJSON()).toEqual({ priority, expectedUpdatedAt: current.updatedAt });
      const next = await saved.json() as Item;
      expect(next.updatedAt > current.updatedAt).toBe(true);
      expect(next).toMatchObject({ title: task.title, description, priority });
      current = next;
      await expect(second.getByRole("button", { name: "Edit priority", exact: true })).toHaveText(priority === "urgent" ? "Urgent" : "Low");
    }
    await second.getByRole("button", { name: "Close dialog", exact: true }).click();
    expect(await read<Item>(page, taskPath)).toEqual(current);
    console.log("Live workflow passed: two-account editor conflict 409, draft retained, reload confirmation cancelled then accepted, latest version restored, two successive versioned UI saves persisted.");

    await page.reload();
    await page.getByRole("button", { name: task.title, exact: true }).click();
    for (const field of fields.filter((field) => field.type !== "checkbox")) {
      await page.getByRole("button", { name: `Edit ${field.name}`, exact: true }).click();
      if (field.type === "select") await page.getByRole("combobox", { name: field.name, exact: true }).selectOption("");
      else await page.getByLabel(field.name, { exact: true }).fill("");
    }
    const checkbox = fields.find((field) => field.type === "checkbox")!;
    await page.getByRole("button", { name: `Edit ${checkbox.name}`, exact: true }).click();
    await page.getByLabel(checkbox.name, { exact: true }).uncheck();
    const cleared = Object.fromEntries(fields.map((field) => [field.id, field.type === "checkbox" ? false : null]));
    saving = responseFor(page, taskPath, "PATCH");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await saving).status()).toBe(200);
    expect((await read<Item>(page, taskPath)).customFields).toEqual(cleared);
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: task.title, exact: true }).click();
    for (const field of fields.filter((field) => field.type !== "checkbox"))
      await expect(page.getByRole("button", { name: `Edit ${field.name}`, exact: true })).toHaveText("Not set");
    await expect(page.getByRole("button", { name: `Edit ${checkbox.name}`, exact: true })).toHaveText("No");
    await expect(page.locator(`[id="custom-${checkbox.id}-state"]`)).toHaveText("No");
    await page.getByRole("button", { name: `Edit ${checkbox.name}`, exact: true }).click();
    await page.getByRole("button", { name: `Clear ${checkbox.name}`, exact: true }).click();
    saving = responseFor(page, taskPath, "PATCH");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await saving).status()).toBe(200);
    expect((await read<Item>(page, taskPath)).customFields).toEqual({ ...cleared, [checkbox.id]: null });
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: task.title, exact: true }).click();
    await expect(page.locator(`[id="custom-${checkbox.id}-state"]`)).toHaveText("Not set");
    await page.getByRole("button", { name: `Edit ${checkbox.name}`, exact: true }).click();
    await expect(page.getByRole("button", { name: `Clear ${checkbox.name}`, exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    console.log("Live workflow passed: text/number/date/select cleared to null, unchecked checkbox persisted false/No, explicit Clear persisted null/Not set, verified after full reloads.");

    await page.getByTitle(`project: ${project.name}`, { exact: true }).click();
    await page.getByRole("button", { name: `Manage ${project.name}`, exact: true }).click();
    const projectDescription = "Project context persisted by the real browser and API.";
    await page.getByLabel("Project description", { exact: true }).fill(projectDescription);
    saving = responseFor(page, `${base}/nodes/${project.id}`, "PATCH");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await saving).status()).toBe(200);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(projectDescription, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add fields", exact: true }).click();
    const configuration = page.getByRole("dialog", { name: `Fields for ${project.name}`, exact: true });
    await configuration.getByRole("button", { name: "Add status", exact: true }).click();
    const newStatus = configuration.getByRole("group", { name: /^Status \d+$/ }).last();
    await newStatus.getByLabel("Status name", { exact: true }).fill("Accepted live");
    await newStatus.getByLabel("Status color", { exact: true }).fill("#12805c");
    await newStatus.getByRole("checkbox", { name: "Completed", exact: true }).check();
    saving = responseFor(page, configPath, "PATCH");
    await configuration.getByRole("button", { name: "Save project settings", exact: true }).click();
    expect((await saving).status()).toBe(200);
    await expect(configuration.getByRole("status").filter({ hasText: "Project settings saved." })).toBeVisible();
    const statuses = (await read<ProjectFieldConfiguration>(page, configPath)).statuses!;
    const accepted = statuses.find((status) => status.name === "Accepted live")!;
    expect(accepted).toMatchObject({ color: "#12805c", completed: true });

    await configuration.getByLabel("Field name", { exact: true }).fill("Workflow rating");
    await configuration.getByRole("combobox", { name: "Type", exact: true }).selectOption("rating");
    await configuration.getByLabel("Maximum rating", { exact: true }).fill("7");
    const creatingRating = responseFor(page, `${base}/fields`, "POST");
    await configuration.getByRole("button", { name: "Create field and add", exact: true }).click();
    const createdRating = await creatingRating;
    expect(createdRating.status()).toBe(201);
    const rating = await createdRating.json() as Field;
    expect(rating).toMatchObject({ name: "Workflow rating", type: "rating", settings: { maxRating: 7 } });
    await expect(configuration.getByRole("status").filter({ hasText: "Field created and added." })).toBeVisible();
    expect((await read<ProjectFieldConfiguration>(page, configPath)).fieldIds).toContain(rating.id);
    await configuration.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.getByRole("button", { name: task.title, exact: true }).click();
    const beforeTypedSave = await read<Item>(page, taskPath);
    await page.getByRole("button", { name: "Edit status", exact: true }).click();
    await page.getByRole("combobox", { name: "Status", exact: true }).selectOption({ label: accepted.name });
    await page.getByRole("button", { name: `Edit ${rating.name}`, exact: true }).click();
    await page.getByLabel(rating.name, { exact: true }).fill("6");
    saving = responseFor(page, taskPath, "PATCH");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    const typedSave = await saving;
    expect(typedSave.status()).toBe(200);
    expect(typedSave.request().postDataJSON()).toEqual({
      status: accepted.id, customFields: { ...beforeTypedSave.customFields, [rating.id]: 6 },
      expectedUpdatedAt: beforeTypedSave.updatedAt,
    });
    const typedTask = await read<Item>(page, taskPath);
    expect(typedTask).toMatchObject({ status: accepted.id, customFields: { ...beforeTypedSave.customFields, [rating.id]: 6 } });
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.reload();
    await page.getByTitle(`project: ${project.name}`, { exact: true }).click();
    await expect(page.getByText(projectDescription, { exact: true })).toBeVisible();
    await expect(page.getByText("1 complete", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: task.title, exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit status", exact: true })).toHaveText(accepted.name);
    await expect(page.getByRole("button", { name: `Edit ${rating.name}`, exact: true })).toHaveText("6");
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    console.log("Live workflow passed: UI project description, custom completed status/color and assigned rating(max 7); versioned status/rating 6 save preserves sibling values, description/status/rating and completion count survive reload.");

    await page.goto(`${origin}/settings`);
    let changing = responseFor(page, `${base}/members/${editor.user.id}`, "PATCH");
    await page.getByRole("combobox", { name: `Role for ${editor.name}`, exact: true }).selectOption(viewerRole.id);
    expect((await changing).status()).toBe(200);
    expect((await read<Detail>(second, base)).permissions).toEqual(["items:read"]);
    await second.reload();
    await second.getByRole("button", { name: task.title, exact: true }).focus();
    await second.keyboard.press("Enter");
    await expect(second.getByRole("dialog", { name: "Task details" })).toBeFocused();
    await second.keyboard.press("Tab");
    await second.keyboard.press("Tab");
    await second.keyboard.press("Tab");
    const readonlyDescription = second.getByRole("textbox", { name: "Body", exact: true });
    await expect(readonlyDescription).toBeFocused();
    await expect(readonlyDescription).toHaveAttribute("aria-readonly", "true");
    await expect(readonlyDescription).toHaveText(description, { useInnerText: true });
    await second.keyboard.press("Control+End");
    await expect.poll(() => readonlyDescription.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => readonlyDescription.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    await second.keyboard.press("Control+a");
    expect(await readonlyDescription.evaluate(() => window.getSelection()?.toString())).toContain("Description line 1");
    await second.keyboard.press("x");
    await expect(readonlyDescription).toHaveText(description, { useInnerText: true });
    await expect(second.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
    await second.getByRole("button", { name: "Task options", exact: true }).click();
    await expect(second.getByRole("menuitem", { name: "Delete task", exact: true })).toHaveCount(0);
    await second.getByRole("button", { name: "Task options", exact: true }).click();
    await second.keyboard.press("Escape");
    await expect(second.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Create role" }).click();
    await page.getByLabel("Role name").fill("Workflow custom reader");
    await page.getByRole("checkbox", { name: /^items:read / }).check();
    changing = responseFor(page, `${base}/roles`, "POST");
    await page.getByRole("button", { name: "Save role", exact: true }).click();
    expect((await changing).status()).toBe(201);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const role = (await read<Detail>(page, base)).roles.find((role) => role.name === "Workflow custom reader")!;
    changing = responseFor(page, `${base}/members/${editor.user.id}`, "PATCH");
    await page.getByRole("combobox", { name: `Role for ${editor.name}`, exact: true }).selectOption(role.id);
    expect((await changing).status()).toBe(200);
    await page.locator("li").filter({ has: page.getByText(role.name, { exact: true }) }).getByRole("button", { name: "Edit permissions" }).click();
    await page.getByRole("checkbox", { name: /^items:write / }).check();
    changing = responseFor(page, `${base}/roles/${role.id}`, "PATCH");
    await page.getByRole("button", { name: "Save role", exact: true }).click();
    expect((await changing).status()).toBe(200);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("combobox", { name: `Role for ${editor.name}`, exact: true })).toHaveValue(role.id);
    const updatedDetail = await read<Detail>(second, base);
    expect(updatedDetail.role.id).toBe(role.id);
    expect(updatedDetail.permissions.sort()).toEqual(["items:read", "items:write"]);
    await second.reload();
    await second.getByRole("button", { name: task.title, exact: true }).click();
    await second.getByRole("button", { name: "Edit priority", exact: true }).click();
    await second.getByRole("combobox", { name: "Priority", exact: true }).selectOption("medium");
    saving = responseFor(second, taskPath, "PATCH");
    await second.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await saving).status()).toBe(200);
    expect((await read<Item>(page, taskPath)).priority).toBe("medium");
    const memberRow = page.locator("li").filter({ has: page.getByText(editor.email, { exact: true }) });
    page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toBe(`Remove ${editor.name} from this workspace?`);
      await dialog.accept();
    });
    changing = responseFor(page, `${base}/members/${editor.user.id}`, "DELETE");
    await memberRow.getByRole("button", { name: "Remove", exact: true }).click();
    expect((await changing).status()).toBe(200);
    await expect(memberRow).toHaveCount(0);
    expect((await read<Detail>(page, base)).members.some((member) => member.userId === editor.user.id)).toBe(false);
    expect((await second.request.get(`${apiUrl}${taskPath}`)).status()).toBe(403);
    await page.reload();
    await expect(page.getByRole("heading", { name: "People", exact: true })).toBeVisible();
    await expect(memberRow).toHaveCount(0);
    console.log("Live workflow passed: Member reassigned to Viewer; keyboard opens, scrolls and selects full read-only description; custom role assigned and permissions edited, newly granted UI write persisted; confirmed member removal persists and denies task access.");

    await page.goto(`${origin}/app`);
    await page.getByRole("button", { name: task.title, exact: true }).click();
    await page.getByRole("button", { name: "Add attachment", exact: true }).click();
    const attachments = [];
    for (const name of ["delete-control.txt", "cascade-control.txt"]) {
      const fileInput = page.getByLabel("Attach a file", { exact: true });
      await expect(fileInput).toBeEnabled();
      const uploading = responseFor(page, `${taskPath}/attachments`, "POST");
      await fileInput.setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(`Disposable ${name}`) });
      const uploaded = await uploading;
      expect(uploaded.status()).toBe(201);
      attachments.push(await uploaded.json() as { id: string });
      await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
    }
    const attachmentPath = `${taskPath}/attachments/${attachments[0].id}`;
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toBe('Delete attachment "delete-control.txt"?');
      await dialog.dismiss();
    });
    await page.getByRole("button", { name: "Delete attachment delete-control.txt", exact: true }).click();
    expect((await page.request.get(`${apiUrl}${attachmentPath}`)).status()).toBe(200);
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toBe('Delete attachment "delete-control.txt"?');
      await dialog.accept();
    });
    let deleting = responseFor(page, attachmentPath, "DELETE");
    await page.getByRole("button", { name: "Delete attachment delete-control.txt", exact: true }).click();
    expect((await deleting).status()).toBe(200);
    await expect(page.getByRole("link", { name: "delete-control.txt", exact: true })).toHaveCount(0);
    expect((await page.request.get(`${apiUrl}${attachmentPath}`)).status()).toBe(404);
    await page.reload();
    await expect(page.getByRole("link", { name: "cascade-control.txt", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "delete-control.txt", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Task options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete task", exact: true }).click();
    await page.getByRole("button", { name: "Keep task", exact: true }).click();
    expect((await page.request.get(`${apiUrl}${taskPath}`)).status()).toBe(200);
    await page.getByRole("button", { name: "Task options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete task", exact: true }).click();
    deleting = responseFor(page, taskPath, "DELETE");
    await page.getByRole("button", { name: "Permanently delete", exact: true }).click();
    expect((await deleting).status()).toBe(200);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "Add task", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: task.title, exact: true })).toHaveCount(0);
    expect((await page.request.get(`${apiUrl}${taskPath}`)).status()).toBe(404);
    expect((await page.request.get(`${apiUrl}${taskPath}/attachments/${attachments[1].id}`)).status()).toBe(404);
    expect(await read<Item[]>(page, `${base}/items`)).toEqual([]);
    console.log("Live workflow passed: UI uploads, attachment delete cancellation/confirmation and reload absence, task Keep/cancel then permanent delete, task and remaining attachment return 404.");

    // Secret values stay in memory: no traces, screenshots or response-body logging.
    await page.goto(`${origin}/settings`);
    await page.getByLabel("Display name").fill("Renamed disposable owner");
    changing = responseFor(page, "/auth/profile", "PATCH");
    await page.getByRole("button", { name: "Save account", exact: true }).click();
    expect((await changing).status()).toBe(200);
    await expect(page.getByRole("status").filter({ hasText: "Your profile has been updated." })).toHaveText("Your profile has been updated.");
    await page.reload();
    await expect(page.getByLabel("Display name")).toHaveValue("Renamed disposable owner");
    expect((await read<User>(page, "/auth/me")).name).toBe("Renamed disposable owner");
    const tokens: string[] = [];
    for (const name of ["UI revoke verification", "Password revocation verification"]) {
      await page.getByLabel("Token name", { exact: true }).fill(name);
      changing = responseFor(page, "/auth/tokens", "POST");
      await page.getByRole("button", { name: "Create token", exact: true }).click();
      expect((await changing).status()).toBe(201);
      const reveal = page.getByLabel("New access token", { exact: true });
      await expect(reveal).toBeVisible();
      const token = await reveal.inputValue();
      expect(token.length > 20, "UI reveals a nonempty token").toBe(true);
      tokens.push(token);
      expect((await fetch(`${apiUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })).status).toBe(200);
      await page.getByRole("button", { name: "I saved it. Hide token.", exact: true }).click();
      await expect(reveal).toHaveCount(0);
    }
    const tokenList = await read<{ id: string; name: string }[]>(page, "/auth/tokens");
    const revoked = tokenList.find((token) => token.name === "UI revoke verification")!;
    const tokenRow = page.locator("li").filter({ has: page.getByText(revoked.name, { exact: true }) });
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain(`Revoke "${revoked.name}"?`);
      await dialog.dismiss();
    });
    await tokenRow.getByRole("button", { name: "Revoke", exact: true }).click();
    expect((await fetch(`${apiUrl}/auth/me`, { headers: { Authorization: `Bearer ${tokens[0]}` }, signal: AbortSignal.timeout(10_000) })).status).toBe(200);
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain(`Revoke "${revoked.name}"?`);
      await dialog.accept();
    });
    deleting = responseFor(page, `/auth/tokens/${revoked.id}`, "DELETE");
    await tokenRow.getByRole("button", { name: "Revoke", exact: true }).click();
    expect((await deleting).status()).toBe(200);
    await expect(tokenRow).toHaveCount(0);
    expect((await fetch(`${apiUrl}/auth/me`, { headers: { Authorization: `Bearer ${tokens[0]}` }, signal: AbortSignal.timeout(10_000) })).status).toBe(401);
    const oldCookie = (await page.context().cookies(origin)).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    expect((await fetch(`${apiUrl}/auth/me`, { headers: { Cookie: oldCookie }, signal: AbortSignal.timeout(10_000) })).status).toBe(200);
    const newPassword = randomBytes(24).toString("base64url");
    await page.getByLabel("Current password", { exact: true }).fill(owner.password);
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    changing = responseFor(page, "/auth/profile", "PATCH");
    await page.getByRole("button", { name: "Save account", exact: true }).click();
    expect((await changing).status()).toBe(200);
    await expect(page.getByRole("status").filter({ hasText: "Account updated." })).toHaveText("Account updated. Other sessions and existing tokens have been revoked.");
    expect((await fetch(`${apiUrl}/auth/me`, { headers: { Cookie: oldCookie }, signal: AbortSignal.timeout(10_000) })).status).toBe(401);
    expect((await fetch(`${apiUrl}/auth/me`, { headers: { Authorization: `Bearer ${tokens[1]}` }, signal: AbortSignal.timeout(10_000) })).status).toBe(401);
    expect((await page.request.get(`${apiUrl}/auth/me`)).status()).toBe(200);
    expect(await read(page, "/auth/tokens")).toEqual([]);
    expect((await fetch(`${apiUrl}/auth/login`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ email: owner.email, password: owner.password }), signal: AbortSignal.timeout(10_000),
    })).status).toBe(401);
    await page.context().clearCookies();
    await page.goto(`${origin}/login`);
    await page.getByLabel("Email", { exact: true }).fill(owner.email);
    await page.getByLabel("Password", { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/app\?workspace=/);
    expect((await read<User>(page, "/auth/me")).id).toBe(owner.user.id);
    expect((await read<User>(admin, "/auth/me")).isAdmin).toBe(true);
    expect(errors).toEqual([]);
    console.log("Live workflow passed: UI profile rename survives reload; two UI-issued bearer tokens return 200, cancelled revoke preserves access, confirmed revoke returns 401; UI password change revokes old cookie and remaining token, rotated cookie stays 200, old password fails and new-password browser login succeeds. Original admin session preserved.");
  } finally {
    for (const context of contexts) await context.close();
  }
}
