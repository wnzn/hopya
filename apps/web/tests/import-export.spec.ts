import { test, expect, type Page } from "@playwright/test";
import { permissions } from "../src/lib/api";

const wid = "11111111-1111-4111-8111-111111111111";
const projectId = "33333333-3333-4333-8333-333333333333";
const listId = "22222222-2222-4222-8222-222222222222";
const user = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Test Member",
  email: "member@example.test",
  isAdmin: false,
};
const role = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Member",
  permissions: [...permissions],
  isOwner: false,
};
const detail = {
  workspace: { id: wid, name: "Import test space" },
  role,
  permissions: [...permissions],
  members: [{ ...user, userId: user.id, roleId: role.id, disabled: false }],
  roles: [role],
  nodes: [
    { id: projectId, name: "Test project", kind: "project", parentId: null },
    { id: listId, name: "Test list", kind: "list", parentId: projectId },
  ],
  fields: [],
};

async function fixture(
  page: Page,
  options: { importStatus?: number; importError?: string } = {},
) {
  const state = {
    importRequests: [] as { body: unknown }[],
    errors: [] as string[],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = request.method();
    if (path === "/config")
      return route.fulfill({
        json: {
          landingEnabled: true,
          registrationEnabled: false,
          setupRequired: false,
          ssoEnabled: false,
          aiEnabled: false,
        },
      });
    if (path === "/auth/me") return route.fulfill({ json: user });
    if (path === "/workspaces" && method === "GET")
      return route.fulfill({ json: [detail.workspace] });
    if (path === `/workspaces/${wid}` && method === "GET")
      return route.fulfill({ json: detail });
    if (path === `/workspaces/${wid}/fields` && method === "GET")
      return route.fulfill({
        json: [{ id: "field-effort", name: "Effort", type: "text" }],
      });
    if (path === `/workspaces/${wid}/items/import` && method === "POST") {
      state.importRequests.push({ body: request.postDataJSON() });
      if (options.importStatus)
        return route.fulfill({
          status: options.importStatus,
          json: { error: options.importError ?? "Import failed" },
        });
      return route.fulfill({ json: { imported: 2 } });
    }
    if (path === `/workspaces/${wid}/items/export` && method === "GET")
      return route.fulfill({
        headers: {
          "Content-Disposition": 'attachment; filename="tasks.csv"',
          "Content-Type": "text/csv",
        },
        body: "title,description\nSample,Example\n",
      });
    return route.fulfill({
      status: 404,
      json: { error: `Unhandled mock route: ${method} ${path}` },
    });
  });
  return state;
}

test("import page renders template links and the import form on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.goto("/import");
  await expect(
    page.getByRole("heading", { name: "Import & export", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "tasks.csv" })).toHaveAttribute(
    "href",
    "/templates/tasks.csv",
  );
  await expect(page.getByRole("link", { name: "tasks.json" })).toHaveAttribute(
    "href",
    "/templates/tasks.json",
  );
  const importSection = page.getByRole("region", { name: "Import" });
  await expect(importSection.getByLabel("Workspace")).toBeVisible();
  await expect(importSection.getByLabel("Destination list")).toBeVisible();
  await expect(
    importSection.getByRole("button", { name: "Import", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(state.errors).toEqual([]);
});

test("server validation error displays without a success message", async ({
  page,
}) => {
  const state = await fixture(page, {
    importStatus: 400,
    importError: "Row 2: title is required",
  });
  await page.goto("/import");
  const importSection = page.getByRole("region", { name: "Import" });
  await importSection.getByLabel("Destination list").selectOption(listId);
  await importSection
    .getByLabel("Or paste file contents")
    .fill("title,description\n,Missing title");
  await importSection
    .getByRole("button", { name: "Import", exact: true })
    .click();
  await expect(importSection.getByRole("alert")).toContainText(
    "Row 2: title is required",
  );
  await expect(importSection.getByText(/Imported \d+ tasks/)).toHaveCount(0);
  expect(state.importRequests).toHaveLength(1);
  expect(state.importRequests[0].body).toMatchObject({
    nodeId: listId,
    format: "csv",
  });
  expect(state.errors).toEqual([]);
});

test("column mapping remaps a source column to a custom field", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/import");
  const importSection = page.getByRole("region", { name: "Import" });
  await importSection.getByLabel("Destination list").selectOption(listId);
  await importSection
    .getByLabel("Or paste file contents")
    .fill("Name,Work\nAlpha,5");
  await importSection.getByLabel("Map Name to").selectOption("title");
  await importSection.getByLabel("Map Work to").selectOption("custom:Effort");
  await importSection
    .getByRole("button", { name: "Import", exact: true })
    .click();
  await expect(importSection.getByText(/Imported \d+ tasks/)).toBeVisible();
  expect(state.importRequests).toHaveLength(1);
  const body = state.importRequests[0].body as {
    nodeId: string;
    format: string;
    data: string;
  };
  expect(body.nodeId).toBe(listId);
  expect(body.format).toBe("csv");
  expect(body.data.split("\n")[0]).toBe("title,custom:Effort");
  expect(state.errors).toEqual([]);
});

test("export download navigates to the filtered export URL", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/import");
  const exportSection = page.getByRole("region", { name: "Export" });
  await exportSection.getByLabel("Scope").selectOption(listId);
  await exportSection.getByLabel("Status").selectOption("todo");
  await exportSection.getByLabel("Search").fill("launch");
  await exportSection.getByRole("radio", { name: "JSON" }).check();
  const [request] = await Promise.all([
    page.waitForRequest("**/items/export*"),
    exportSection
      .getByRole("button", { name: "Download", exact: true })
      .click(),
  ]);
  const url = new URL(request.url());
  expect(url.pathname).toBe(`/api/v1/workspaces/${wid}/items/export`);
  expect(url.searchParams.get("format")).toBe("json");
  expect(url.searchParams.get("nodeId")).toBe(listId);
  expect(url.searchParams.get("status")).toBe("todo");
  expect(url.searchParams.get("search")).toBe("launch");
  expect(state.errors).toEqual([]);
});
