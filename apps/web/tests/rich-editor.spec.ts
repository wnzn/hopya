import { expect, test } from "@playwright/test";
import type { Item } from "../src/lib/api";
import { fixture, task, wid } from "./fixture";

// One-test contract for the TipTap rich editor: toolbar formatting must
// reach the API as markdown and survive a reload as formatted output.
test("toolbar bold and list formatting persist as markdown through save and reload", async ({ page }) => {
  const { errors } = await fixture(page, {
    items: [{ ...task, description: "" }],
  });
  const patches: Record<string, unknown>[] = [];
  let current: Item = { ...task, description: "" };
  await page.route(`**/api/v1/workspaces/${wid}/items/${task.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON();
    patches.push(body);
    current = { ...current, ...body, updatedAt: "2026-09-07T00:00:00.001Z" };
    return route.fulfill({ json: current });
  });
  await page.route(`**/api/v1/workspaces/${wid}/items/page?*`, (route) =>
    route.fulfill({ json: { items: [current], nextCursor: null } }),
  );
  await page.goto("/app");
  await page.getByRole("button", { name: task.title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Task details", exact: true });
  await expect(dialog).toBeVisible();
  const editor = dialog.getByRole("textbox", { name: "Body", exact: true });
  await editor.click();
  await expect(editor).toHaveAttribute("aria-readonly", "false");
  await page.keyboard.type("Release notes intro ");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await page.keyboard.type("highlighted");
  // Enter ends the paragraph; the bulleted toolbar toggle opens a list item.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Bulleted list", exact: true }).click();
  await page.keyboard.type("First ship item");
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(dialog).toBeVisible();
  const patch = patches.find((body) => "description" in body);
  expect(patch?.description).toBe(
    "Release notes intro **highlighted**\n\n- First ship item",
  );
  // Reload: the saved markdown renders with live formatting, not raw markers.
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: task.title, exact: true }).click();
  const view = page.getByRole("textbox", { name: "Body", exact: true });
  await expect(view).toHaveAttribute("aria-readonly", "true");
  await expect(view).toContainText("Release notes intro");
  const strong = view.locator("strong");
  await expect(strong).toHaveText("highlighted");
  await expect(view.locator("li")).toHaveText("First ship item");
  expect(errors).toEqual([]);
});
