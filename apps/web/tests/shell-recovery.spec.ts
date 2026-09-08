import { expect, test, type Locator, type Page } from "@playwright/test";
import { detail, fixture, task, wid } from "./fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function tabTo(page: Page, target: Locator, key: "Tab" | "Shift+Tab" = "Tab") {
  for (let i = 0; i < 60; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

async function clickPadding(page: Page, dialog: Locator) {
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box!.x + 5, y: box!.y + 60 };
  expect(await dialog.evaluate((element, point) =>
    document.elementFromPoint(point.x, point.y) === element, point)).toBe(true);
  await page.mouse.click(point.x, point.y);
}

test("dialog interior padding preserves a dirty draft; backdrop, Escape and Cancel still close", async ({ page }) => {
  const { errors, mutations } = await fixture(page);
  await page.goto("/app");
  const opener = page.getByRole("button", { name: task.title, exact: true });
  const dialog = page.getByRole("dialog", { name: "Task details" });
  for (const close of ["backdrop", "Escape", "Cancel"]) {
    await opener.click();
    await page.getByLabel("Title", { exact: true }).fill(`Unsaved ${close}`);
    await clickPadding(page, dialog);
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(`Unsaved ${close}`);
    await dialog.locator(".modal-head h2").click();
    await expect(dialog).toBeVisible();
    if (close === "backdrop") await page.mouse.click(2, 2);
    else if (close === "Escape") await page.keyboard.press("Escape");
    else await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test("busy dialog ignores padding, backdrop, Escape and close without losing its failed-save draft", async ({ page }) => {
  const { errors } = await fixture(page);
  const pending = deferred();
  await page.route(`**/api/v1/workspaces/${wid}/items/${task.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await pending.promise;
    await route.fulfill({ status: 503, json: { error: "Save unavailable" } });
  });
  await page.goto("/app");
  await page.getByRole("button", { name: task.title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Task details" });
  await page.getByLabel("Title", { exact: true }).fill("Keep my busy draft");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await clickPadding(page, dialog);
  await page.mouse.click(2, 2);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(dialog).toBeVisible();
  pending.resolve();
  await expect(dialog.getByRole("alert")).toContainText("Save unavailable");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Keep my busy draft");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const view of ["List", "Gallery", "Board", "Calendar", "Timeline"]) {
  for (const rename of [false, true]) {
    test(`${view} restores the saved task identity after delayed refresh with ${rename ? "renamed" : "unchanged"} title`, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2026-09-06T12:00:00"));
      const { errors, mutations } = await fixture(page, {
        items: [{ ...task, id: "same-title-other-task" }, task],
      });
      const pending = deferred();
      let refreshing = false;
      await page.route(`**/api/v1/workspaces/${wid}/items/page*`, async (route) => {
        if (refreshing) await pending.promise;
        await route.fallback();
      });
      await page.goto("/app");
      await page.getByRole("tab", { name: view, exact: true }).click();
      const opener = page.locator(`#task-view button[data-task-id="${task.id}"]`).first();
      await opener.focus();
      await page.keyboard.press("Enter");
      if (rename) await page.getByLabel("Title", { exact: true }).fill("Renamed saved task");
      else await page.getByRole("textbox", { name: "Body", exact: true }).fill("Updated without renaming");
      refreshing = true;
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(opener).toHaveCount(0);
      pending.resolve();
      await expect(opener).toBeFocused();
      await expect(opener).toContainText(rename ? "Renamed saved task" : task.title);
      expect(mutations.filter((mutation) => mutation.method === "PATCH")).toHaveLength(1);
      expect(mutations[0].path).toBe(`/workspaces/${wid}/items/${task.id}`);
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Title", { exact: true })).toHaveValue(rename ? "Renamed saved task" : task.title);
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
}

for (const change of ["filter", "delete"]) {
  test(`task ${change} uses a stable focus fallback after refreshing`, async ({ page }) => {
    const { errors, mutations } = await fixture(page);
    await page.goto("/app");
    if (change === "filter") await page.getByLabel("Search tasks").fill(task.title);
    await page.getByRole("button", { name: task.title, exact: true }).click();
    if (change === "filter") {
      await page.getByLabel("Title", { exact: true }).fill("No longer matches the filter");
      await page.getByRole("button", { name: "Save changes" }).click();
    } else {
      await page.getByRole("button", { name: "Delete task", exact: true }).click();
      await page.getByRole("button", { name: "Permanently delete", exact: true }).click();
    }
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("#task-view")).toBeFocused();
    expect(mutations).toHaveLength(1);
    await page.reload();
    await expect(page.getByRole("button", { name: task.title, exact: true })).toHaveCount(0);
    if (change === "filter") await expect(page.getByRole("button", { name: "No longer matches the filter", exact: true })).toBeVisible();
    else await expect(page.getByRole("heading", { name: "Your next step starts here" })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const width of [1280, 320, 390]) {
  test(`assistant keyboard lifecycle and nested review at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors, mutations } = await fixture(page);
    await page.goto("/app");
    const opener = page.getByRole("button", { name: "Assistant", exact: false });
    await expect(opener).toBeVisible();
    await tabTo(page, opener);
    await page.keyboard.press("Enter");
    const panel = page.getByRole(width <= 760 ? "dialog" : "complementary", { name: "Workspace assistant" });
    const compose = page.getByLabel("Message the assistant");
    await expect(compose).toBeFocused();
    await page.keyboard.type("Suggest a next step");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Send message" })).toBeFocused();
    await page.keyboard.press("Enter");
    const review = page.getByRole("button", { name: "Review suggestion" });
    await expect(review).toBeVisible();
    if (width <= 760) {
      await page.locator("#task-view").evaluate((element) => element.focus());
      await expect(page.locator("#task-view")).not.toBeFocused();
      for (const key of ["Tab", "Shift+Tab"]) {
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press(key);
          const focus = await panel.evaluate((element) => ({
            inside: element.contains(document.activeElement),
            browserChrome: document.activeElement === document.body && !document.hasFocus(),
          }));
          expect(focus.inside || focus.browserChrome).toBe(true);
        }
      }
    }
    await tabTo(page, review);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Review suggested task" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(review).toBeFocused();
    await expect(panel).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(compose).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(review).toBeFocused();
    // Do not depend on browser-chrome wraparound after the last page control.
    const close = page.getByRole("button", { name: "Close assistant" });
    await tabTo(page, close, "Shift+Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(compose).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(mutations.filter((mutation) => mutation.path.endsWith("/items"))).toEqual([]);
    expect(errors).toEqual([]);
  });
}

for (const followup of [false, true]) {
  test(`delayed assistant failure ${followup ? "preserves a new compose draft" : "restores the original message when empty"}`, async ({ page }) => {
    const { errors } = await fixture(page);
    const pending = deferred();
    await page.route(`**/api/v1/workspaces/${wid}/agent`, async (route) => {
      await pending.promise;
      await route.fulfill({ status: 503, json: { error: "Assistant unavailable" } });
    });
    await page.goto("/app");
    await page.getByRole("button", { name: "Assistant", exact: false }).click();
    const compose = page.getByLabel("Message the assistant");
    await compose.fill("Original question");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Thinking...", { exact: true })).toBeVisible();
    if (followup) await compose.fill("A new follow-up draft");
    pending.resolve();
    await expect(page.getByRole("alert")).toContainText("Assistant unavailable");
    await expect(compose).toHaveValue(followup ? "A new follow-up draft" : "Original question");
    await expect(page.getByRole("log")).toContainText("Original question");
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 390]) {
  test(`120-character workspace and hierarchy names wrap without shell overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { errors } = await fixture(page);
    const workspace = { ...detail.workspace, name: "W".repeat(120) };
    const nodes = detail.nodes.map((node) => ({ ...node, name: (node.kind === "project" ? "P" : "L").repeat(120) }));
    await page.route(`**/api/v1/workspaces`, (route) => route.fulfill({ json: [workspace] }));
    await page.route(`**/api/v1/workspaces/${wid}`, (route) => route.fulfill({ json: { ...detail, workspace, nodes } }));
    await page.goto("/app");
    await expect(page.locator(".breadcrumb")).toContainText(workspace.name);
    for (const node of nodes) {
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page.locator(`button[title="${node.kind}: ${node.name}"]`).click();
      await expect(page.getByRole("heading", { name: node.name, exact: true })).toBeVisible();
      await expect(page.locator(".breadcrumb")).toContainText(node.name);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const selector of [".breadcrumb", ".workspace-heading", ".workspace-heading h1"]) {
        expect(await page.locator(selector).evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth;
        }), selector).toBe(true);
      }
    }
    await page.route(`**/api/v1/workspaces/${wid}`, (route) => route.fulfill({
      json: { ...detail, workspace, nodes, permissions: ["structure:write"] },
    }));
    await page.reload();
    await expect(page.getByRole("heading", { name: workspace.name, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("board status changes use actual keyboard selection and pointer drag with persisted fixture state", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const { errors, mutations } = await fixture(page);
  await page.goto("/app");
  await page.getByRole("tab", { name: "List", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Board" })).toBeFocused();
  const status = page.getByLabel(`Move ${task.title} to status`);
  await tabTo(page, status);
  // Native type-ahead selects by name without assuming configurable status order.
  await page.keyboard.press("i");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "In progress", exact: true }).locator(".task-card")).toContainText(task.title);
  expect(mutations[0].body).toEqual({ status: "in_progress", expectedUpdatedAt: task.updatedAt });
  await page.reload();
  await page.getByRole("tab", { name: "Board" }).click();
  await expect(status).toHaveValue("in_progress");
  await page.getByRole("region", { name: "Done", exact: true }).scrollIntoViewIfNeeded();
  const source = await page.locator(".board-task").boundingBox();
  const target = await page.getByRole("region", { name: "Done", exact: true }).boundingBox();
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();
  await page.mouse.move(source!.x + 20, source!.y + 20);
  await page.mouse.down();
  await page.mouse.move(source!.x + 35, source!.y + 30, { steps: 5 });
  await page.mouse.move(target!.x + target!.width / 2, target!.y + 100, { steps: 20 });
  await page.mouse.move(target!.x + target!.width / 2, target!.y + 110, { steps: 3 });
  await page.mouse.up();
  await expect(page.getByRole("region", { name: "Done", exact: true }).locator(".task-card")).toContainText(task.title);
  expect(mutations).toHaveLength(2);
  expect(mutations[1].body).toEqual({ status: "done", expectedUpdatedAt: task.updatedAt });
  await page.reload();
  await page.getByRole("tab", { name: "Board" }).click();
  await expect(status).toHaveValue("done");
  await expect(page.getByRole("region", { name: "Done", exact: true }).locator(".task-card")).toContainText(task.title);
  expect(errors).toEqual([]);
});
