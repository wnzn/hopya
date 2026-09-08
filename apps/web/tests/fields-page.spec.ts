import { expect, test, type Page } from "@playwright/test";
import type { Detail } from "../src/lib/api";
import { detail, fixture, wid } from "./fixture";

const pid = detail.nodes[0].id;
const lid = detail.nodes[1].id;

async function setup(page: Page, permissions = detail.permissions) {
  const original = await fixture(page);
  const metadata: Detail = structuredClone({
    ...detail,
    permissions,
    projectFields: [
      { projectId: pid, fieldIds: ["effort"], builtInFields: ["priority"], updatedAt: "config-1" },
    ],
    listStatusConfigs: [
      { listId: lid, updatedAt: "list-config-1", inheritedProjectUpdatedAt: "config-1" },
    ],
  });
  await page.route(`**/api/v1/workspaces/${wid}`, route => route.fulfill({ json: metadata }));
  await page.route(`**/api/v1/workspaces/${wid}/projects/*/fields`, async route => {
    const projectId = new URL(route.request().url()).pathname.split("/").at(-2);
    const config = metadata.projectFields!.find(value => value.projectId === projectId)!;
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      Object.assign(config, body, { updatedAt: `${config.updatedAt}-next` });
    }
    await route.fulfill({ json: config });
  });
  await page.route(`**/api/v1/workspaces/${wid}/lists/*/statuses`, async route => {
    const listId = new URL(route.request().url()).pathname.split("/").at(-2);
    const config = metadata.listStatusConfigs!.find(value => value.listId === listId)!;
    await route.fulfill({ json: config });
  });
  return { ...original, metadata };
}

test("field management renders the target picker with an empty-target prompt", async ({ page }) => {
  await setup(page);
  await page.goto("/fields");
  await expect(page.getByRole("heading", { name: "Field Management", exact: true })).toBeVisible();
  await expect(page.getByLabel("Filter targets")).toBeVisible();
  await expect(page.getByRole("button", { name: /◇ Test project/ })).toBeVisible();
  await expect(page.getByText("Select a project, folder, or list to manage its fields and statuses.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Effort Number", exact: true })).toHaveCount(0);
});

test("selecting a list shows its inherited statuses and field checkboxes", async ({ page }) => {
  await setup(page);
  await page.goto("/fields");
  await page.getByRole("button", { name: /≡ Test list/ }).click();
  await expect(page.getByRole("checkbox", { name: "Effort Number", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "List statuses", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Use project statuses" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save list statuses", exact: true })).toBeVisible();
});

test("read-only access shows the field-management permission notice", async ({ page }) => {
  await setup(page, ["items:read"]);
  await page.goto("/fields");
  await page.getByRole("button", { name: /◇ Test project/ }).click();
  await expect(page.getByText("You need permission to manage project fields.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Effort Number", exact: true })).toHaveCount(0);
});
