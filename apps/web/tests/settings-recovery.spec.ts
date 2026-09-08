import { test, expect, type Page } from "@playwright/test";
import { detail, fixture, user, wid } from "./fixture";
import type { Field, Role } from "../src/lib/api";

const secondId = "77777777-7777-4777-8777-777777777777";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settingsFixture(page: Page) {
  const base = await fixture(page);
  const spaces = [wid, secondId].map((id, index) => {
    const space = structuredClone(detail);
    space.workspace = { id, name: index ? "Workspace B" : "Workspace A" };
    space.roles.push({
      id: `editor-${id}`,
      name: "Editor",
      permissions: ["items:read", "items:write"],
      isOwner: false,
    });
    space.members.push({
      userId: `member-${id}`,
      name: "Colleague",
      email: "colleague@example.test",
      roleId: `editor-${id}`,
      disabled: false,
    });
    return space;
  });
  const requests: {
    path: string;
    method: string;
    body: Record<string, unknown> | null;
  }[] = [];
  const renameStarted = deferred();
  const releaseRename = deferred();
  const state = { holdRename: false };
  await page.route("**/api/v1/workspaces**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const method = request.method();
    const body = request.postDataJSON();
    requests.push({ path, method, body });
    if (path === "/workspaces")
      return route.fulfill({ json: spaces.map((s) => s.workspace) });
    const space = spaces.find((s) =>
      path.startsWith(`/workspaces/${s.workspace.id}`),
    );
    if (!space)
      return route.fulfill({
        status: 404,
        json: { error: "Unknown workspace" },
      });
    const suffix = path.slice(`/workspaces/${space.workspace.id}`.length);
    if (!suffix) {
      if (method === "PATCH") {
        space.workspace.name = body.name;
        if (state.holdRename) {
          renameStarted.resolve();
          await releaseRename.promise;
        }
        return route.fulfill({ json: space.workspace });
      }
      return route.fulfill({ json: space });
    }
    if (suffix === "/roles" && method === "POST") {
      space.roles.push({ id: "created-role", ...body, isOwner: false } as Role);
    } else if (suffix.startsWith("/roles/") && method === "PATCH") {
      Object.assign(
        space.roles.find((r) => suffix.endsWith(r.id))!,
        body,
      );
    } else if (suffix === "/fields" && method === "POST") {
      space.fields.push({ id: "created-field", ...body } as Field);
    } else if (suffix === "/members" && method === "POST") {
      space.members.push({
        userId: "created-member",
        name: "New colleague",
        disabled: false,
        ...body,
      });
    } else if (suffix.startsWith("/members/") && method === "PATCH") {
      Object.assign(
        space.members.find((m) => suffix.endsWith(m.userId))!,
        body,
      );
    } else if (suffix.startsWith("/members/") && method === "DELETE") {
      space.members = space.members.filter((m) => !suffix.endsWith(m.userId));
    } else
      return route.fulfill({
        status: 404,
        json: { error: "Unknown mutation" },
      });
    await route.fulfill({ json: { success: true } });
  });
  return { ...base, state, spaces, requests, renameStarted, releaseRename };
}

for (const mobile of [false, true]) {
  test(`late A rename preserves B role, member and field drafts${mobile ? " on mobile" : ""}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const state = await settingsFixture(page);
    state.state.holdRename = true;
    await page.goto("/settings");
    await page.getByLabel("Name", { exact: true }).fill("Renamed A");
    await page.getByRole("button", { name: "Rename workspace" }).click();
    await state.renameStarted.promise;
    const selection = page.getByLabel("Selected workspace");
    await selection.selectOption(secondId);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      "Workspace B",
    );
    await page.getByLabel("Existing user's email").fill("draft@example.test");
    await page
      .getByRole("combobox", { name: "Role", exact: true })
      .selectOption(`editor-${secondId}`);
    await page.getByLabel("Field name").fill("B field draft");
    await page
      .getByRole("combobox", { name: "Type", exact: true })
      .selectOption("select");
    await page.getByLabel("Options, one per line").fill("Small\nLarge");
    await page.getByRole("button", { name: "Create role" }).click();
    await page.getByLabel("Role name").fill("B role draft");
    await page.getByRole("checkbox", { name: /items:read/ }).check();
    const readsBefore = state.requests.filter(
      (r) => r.method === "GET" && r.path.endsWith(secondId),
    ).length;
    state.releaseRename.resolve();
    await expect(selection.locator(`option[value="${wid}"]`)).toHaveText(
      "Renamed A",
    );
    await expect(page.getByLabel("Role name")).toHaveValue("B role draft");
    await expect(
      page.getByRole("checkbox", { name: /items:read/ }),
    ).toBeChecked();
    await page.getByLabel("Role name").press("Escape");
    await expect(page.getByLabel("Existing user's email")).toHaveValue(
      "draft@example.test",
    );
    await expect(
      page.getByRole("combobox", { name: "Role", exact: true }),
    ).toHaveValue(`editor-${secondId}`);
    await expect(page.getByLabel("Field name")).toHaveValue("B field draft");
    await expect(
      page.getByRole("combobox", { name: "Type", exact: true }),
    ).toHaveValue("select");
    await expect(page.getByLabel("Options, one per line")).toHaveValue(
      "Small\nLarge",
    );
    expect(
      state.requests.filter(
        (r) => r.method === "GET" && r.path.endsWith(secondId),
      ),
    ).toHaveLength(readsBefore);
    await page.getByRole("button", { name: "Create field" }).press("Enter");
    await expect(
      page.getByText("B field draft", { exact: true }),
    ).toBeVisible();
    expect(state.requests.filter((r) => r.method !== "GET")).toEqual([
      {
        path: `/workspaces/${wid}`,
        method: "PATCH",
        body: { name: "Renamed A" },
      },
      {
        path: `/workspaces/${secondId}/fields`,
        method: "POST",
        body: {
          name: "B field draft",
          type: "select",
          options: ["Small", "Large"],
        },
      },
    ]);
    expect(state.errors).toEqual([]);
  });
}

function auditRows(label: string, count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${label}-${i}`,
    action: `${label}.${i}`,
    actorId: user.id,
    workspaceId: wid,
    resourceId: null,
    createdAt: "2026-09-06T00:00:00Z",
    details: {},
  }));
}

async function auditFixture(page: Page) {
  const base = await fixture(page);
  await page.route("**/api/v1/admin/oidc-identities**", (route) =>
    route.fulfill({ json: [] }),
  );
  const state = {
    responses: new Map<
      string,
      { label?: string; count?: number; error?: string; wait?: Promise<void> }
    >(),
    requests: [] as string[],
  };
  await page.route("**/api/v1/admin/audit?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const key = `${query.get("workspaceId") || "all"}:${query.get("offset")}`;
    state.requests.push(key);
    const response = state.responses.get(key) || { label: key, count: 25 };
    if (response.wait) await response.wait;
    await route.fulfill(
      response.error
        ? { status: 503, json: { error: response.error } }
        : { json: auditRows(response.label || key, response.count ?? 1) },
    );
  });
  return { ...base, ...state };
}

test("initial audit failure is not empty success; retry clears only the audit error", async ({
  page,
}) => {
  const state = await auditFixture(page);
  state.responses.set("all:0", { error: "Initial audit unavailable" });
  await page.route("**/api/v1/admin/users", async (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({
        status: 409,
        json: { error: "Account already exists" },
      });
    await route.fallback();
  });
  await page.goto("/admin");
  await expect(
    page.getByRole("alert").filter({ hasText: "Initial audit unavailable" }),
  ).toBeVisible();
  await expect(page.getByText("No audit entries on this page.")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Audit trail table" }),
  ).toHaveCount(0);
  await page.getByLabel("Name", { exact: true }).fill("Duplicate");
  await page
    .getByLabel("Email", { exact: true })
    .fill("duplicate@example.test");
  await page.getByLabel("Initial password").fill("test-only-password");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByText("Account already exists", { exact: true }),
  ).toBeVisible();
  state.responses.set("all:0", { label: "recovered" });
  await page.getByRole("button", { name: "Retry audit" }).press("Enter");
  await expect(
    page.getByRole("rowheader", { name: "recovered.0", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Initial audit unavailable", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Account already exists", { exact: true }),
  ).toBeVisible();
  expect(state.requests).toEqual(["all:0", "all:0"]);
  expect(state.errors).toEqual([]);
});

test("audit page and filter failures hide old datasets and retry the exact query", async ({
  page,
}) => {
  const state = await auditFixture(page);
  state.responses.set("all:25", { error: "Second page unavailable" });
  await page.goto("/admin");
  await expect(
    page.getByRole("rowheader", { name: "all:0.0", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByText("Second page unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Audit trail table" }),
  ).toHaveCount(0);
  await expect(page.getByText("No audit entries on this page.")).toHaveCount(0);
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  state.responses.set("all:25", { label: "page-two", count: 25 });
  await page.getByRole("button", { name: "Retry audit" }).click();
  await expect(
    page.getByRole("rowheader", { name: "page-two.0", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Second page unavailable", { exact: true }),
  ).toHaveCount(0);
  state.responses.set(`${secondId}:0`, { error: "Filtered audit unavailable" });
  await page.getByLabel("Workspace ID (optional)").fill(secondId);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(
    page.getByText("Filtered audit unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Audit trail table" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  state.responses.set(`${secondId}:0`, { label: "filtered" });
  await page.getByRole("button", { name: "Retry audit" }).click();
  await expect(
    page.getByRole("rowheader", { name: "filtered.0", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Filtered audit unavailable", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
  expect(state.requests).toEqual([
    "all:0",
    "all:25",
    "all:25",
    `${secondId}:0`,
    `${secondId}:0`,
  ]);
  expect(state.errors).toEqual([]);
});

for (const lateError of [false, true]) {
  test(`audit ignores late ${lateError ? "failure" : "success"} after rapid filter switches even if transport ignores abort`, async ({
    page,
  }) => {
    // Keep the stale response deliverable to exercise the completion guard, not just fetch cancellation.
    await page.addInitScript(() => {
      const original = window.fetch;
      window.fetch = (input, init) =>
        original(
          input,
          String(input).includes("/admin/audit?")
            ? { ...init, signal: undefined }
            : init,
        );
    });
    const state = await auditFixture(page);
    const pending = deferred();
    state.responses.set(`${wid}:0`, {
      wait: pending.promise,
      ...(lateError
        ? { error: "Stale filter failure" }
        : { label: "stale-filter" }),
    });
    state.responses.set(`${secondId}:0`, { label: "current-filter" });
    await page.goto("/admin");
    await expect(
      page.getByRole("rowheader", { name: "all:0.0", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Workspace ID (optional)").fill(wid);
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await expect.poll(() => state.requests.includes(`${wid}:0`)).toBe(true);
    await expect(
      page.getByRole("region", { name: "Audit trail table" }),
    ).toHaveCount(0);
    await page.getByLabel("Workspace ID (optional)").fill(secondId);
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await expect(
      page.getByRole("rowheader", { name: "current-filter.0", exact: true }),
    ).toBeVisible();
    state.responses.set(`${wid}:0`, { label: "returned-filter" });
    await page.getByLabel("Workspace ID (optional)").fill(wid);
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await expect(
      page.getByRole("rowheader", { name: "returned-filter.0", exact: true }),
    ).toBeVisible();
    const delivered = page.waitForResponse(
      (response) =>
        new URL(response.url()).searchParams.get("workspaceId") === wid,
    );
    pending.resolve();
    await (await delivered).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      page.getByRole("rowheader", { name: "returned-filter.0", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Stale filter failure", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("rowheader", { name: "stale-filter.0", exact: true }),
    ).toHaveCount(0);
    expect(state.errors).toEqual([]);
  });
}

test("successful filter change clears audit failure and only a successful empty result says empty", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await auditFixture(page);
  state.responses.set(`${wid}:0`, { error: "Filter unavailable" });
  state.responses.set(`${secondId}:0`, { label: "empty", count: 0 });
  await page.goto("/admin");
  await expect(
    page.getByRole("rowheader", { name: "all:0.0", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Workspace ID (optional)").fill(wid);
  await page
    .getByRole("button", { name: "Filter", exact: true })
    .press("Enter");
  await expect(
    page.getByText("Filter unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Audit trail table" }),
  ).toHaveCount(0);
  await expect(page.getByText("No audit entries on this page.")).toHaveCount(0);
  await page.getByLabel("Workspace ID (optional)").fill(secondId);
  await page
    .getByRole("button", { name: "Filter", exact: true })
    .press("Enter");
  await expect(page.getByText("No audit entries on this page.")).toBeVisible();
  await expect(
    page.getByText("Filter unavailable", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry audit" })).toHaveCount(
    0,
  );
  expect(state.errors).toEqual([]);
});

test("audit cancels superseded requests and keeps a returning query loading until its fresh response", async ({
  page,
}) => {
  const state = await auditFixture(page);
  const firstPending = deferred();
  const returnPending = deferred();
  await page.goto("/admin");
  await expect(
    page.getByRole("rowheader", { name: "all:0.0", exact: true }),
  ).toBeVisible();
  state.responses.set(`${wid}:0`, {
    label: "cancelled-filter",
    wait: firstPending.promise,
  });
  state.responses.set("all:0", {
    label: "fresh-all",
    wait: returnPending.promise,
  });
  await page.getByLabel("Workspace ID (optional)").fill(wid);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect.poll(() => state.requests.includes(`${wid}:0`)).toBe(true);
  const cancelled = page.waitForEvent(
    "requestfailed",
    (request) => new URL(request.url()).searchParams.get("workspaceId") === wid,
  );
  await page.getByLabel("Workspace ID (optional)").fill("");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await cancelled;
  await expect
    .poll(() => state.requests.filter((key) => key === "all:0").length)
    .toBe(2);
  firstPending.resolve();
  await expect(
    page.getByRole("region", { name: "Audit trail table" }),
  ).toHaveCount(0);
  await expect(page.getByText("No audit entries on this page.")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  returnPending.resolve();
  await expect(
    page.getByRole("rowheader", { name: "fresh-all.0", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("rowheader", { name: "cancelled-filter.0", exact: true }),
  ).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

for (const mobile of [false, true]) {
  test(`profile, password and token controls send exact contracts${mobile ? " on mobile" : ""}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const base = await fixture(page);
    const account = { ...user };
    let tokens: { id: string; name: string; createdAt: string }[] = [];
    let passwordError = true;
    const requests: { path: string; method: string; body: unknown }[] = [];
    await page.route("**/api/v1/auth/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace("/api/v1", "");
      const method = request.method();
      const body = request.postDataJSON();
      if (method !== "GET") requests.push({ path, method, body });
      if (path === "/auth/me") return route.fulfill({ json: account });
      if (path === "/auth/profile") {
        if (body.password && passwordError)
          return route.fulfill({
            status: 403,
            json: { error: "Current password is incorrect" },
          });
        account.name = body.name;
        if (body.password) tokens = [];
        return route.fulfill({ json: { success: true } });
      }
      if (path === "/auth/tokens") {
        if (method === "GET") return route.fulfill({ json: tokens });
        tokens.push({
          id: "created-token",
          name: body.name,
          createdAt: "2026-09-06T00:00:00Z",
        });
        return route.fulfill({ json: { token: "test-only-raw-token" } });
      }
      if (path === "/auth/tokens/created-token" && method === "DELETE") {
        tokens = [];
        return route.fulfill({ json: { success: true } });
      }
      await route.fallback();
    });
    await page.goto("/settings");
    await page.getByLabel("Display name").fill("Updated owner");
    await page.getByRole("button", { name: "Save profile" }).press("Enter");
    await expect(
      page.getByText("Your profile has been updated."),
    ).toBeVisible();
    await expect(page.getByLabel("Display name")).toHaveValue("Updated owner");
    expect(requests[0]).toEqual({
      path: "/auth/profile",
      method: "PATCH",
      body: { name: "Updated owner" },
    });
    await page.getByLabel("Token name").fill("Local client");
    await page.getByRole("button", { name: "Create token" }).press("Enter");
    await expect(page.getByLabel("New access token")).toHaveValue(
      "test-only-raw-token",
    );
    await expect(
      page.getByRole("button", { name: "Create token" }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "I saved it. Hide token." })
      .press("Enter");
    await expect(page.getByLabel("New access token")).toHaveCount(0);
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(
      page.getByText("Token revoked.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Local client", { exact: true })).toHaveCount(
      0,
    );
    await page.getByLabel("Token name").fill("Before password change");
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByLabel("New access token")).toBeVisible();
    await page
      .getByLabel("Current password", { exact: true })
      .fill("test-only-old-password");
    await page
      .getByLabel("New password", { exact: true })
      .fill("test-only-new-password");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(
      page.getByText("Current password is incorrect", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("New password", { exact: true })).toHaveValue(
      "test-only-new-password",
    );
    passwordError = false;
    await page.getByRole("button", { name: "Save profile" }).press("Enter");
    await expect(
      page.getByText(
        "Password updated. Other sessions and existing tokens have been revoked.",
      ),
    ).toBeVisible();
    await expect(
      page.getByLabel("Current password", { exact: true }),
    ).toHaveValue("");
    await expect(page.getByLabel("New password", { exact: true })).toHaveValue(
      "",
    );
    await expect(page.getByLabel("New access token")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Revoke", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Current password is incorrect", { exact: true }),
    ).toHaveCount(0);
    expect(requests.slice(1)).toEqual([
      { path: "/auth/tokens", method: "POST", body: { name: "Local client" } },
      { path: "/auth/tokens/created-token", method: "DELETE", body: null },
      {
        path: "/auth/tokens",
        method: "POST",
        body: { name: "Before password change" },
      },
      ...Array.from({ length: 2 }, () => ({
        path: "/auth/profile",
        method: "PATCH",
        body: {
          name: "Updated owner",
          currentPassword: "test-only-old-password",
          password: "test-only-new-password",
        },
      })),
    ]);
    expect(base.errors).toEqual([]);
  });

  test(`existing role edits and member reassignment/removal refresh server state${mobile ? " on mobile" : ""}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const state = await settingsFixture(page);
    await page.goto("/settings");
    const role = page
      .getByRole("listitem")
      .filter({ has: page.getByText("Editor", { exact: true }) });
    await role.getByRole("button", { name: "Edit permissions" }).click();
    await expect(
      page.getByRole("dialog", { name: "Edit Editor" }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: /items:write/ }),
    ).toBeChecked();
    await page.getByLabel("Role name").fill("Reviewer");
    await page.getByRole("checkbox", { name: /items:write/ }).uncheck();
    await page.getByRole("checkbox", { name: /items:delete/ }).check();
    await page.getByRole("button", { name: "Save role" }).press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const updatedRole = page
      .getByRole("listitem")
      .filter({ has: page.getByText("Reviewer", { exact: true }) });
    await updatedRole.getByRole("button", { name: "Edit permissions" }).click();
    await expect(page.getByLabel("Role name")).toHaveValue("Reviewer");
    await expect(
      page.getByRole("checkbox", { name: /items:read/ }),
    ).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: /items:write/ }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: /items:delete/ }),
    ).toBeChecked();
    await page.getByLabel("Role name").press("Escape");
    await page
      .getByRole("combobox", { name: "Role for Colleague" })
      .selectOption(detail.role.id);
    await expect(
      page.getByRole("combobox", { name: "Role for Colleague" }),
    ).toHaveValue(detail.role.id);
    const member = page
      .getByRole("listitem")
      .filter({ has: page.getByText("Colleague", { exact: true }) });
    page.once("dialog", (dialog) => dialog.dismiss());
    await member.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(member).toBeVisible();
    expect(state.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    page.once("dialog", (dialog) => dialog.accept());
    await member.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(member).toHaveCount(0);
    expect(state.requests.filter((r) => r.method !== "GET")).toEqual([
      {
        path: `/workspaces/${wid}/roles/editor-${wid}`,
        method: "PATCH",
        body: { name: "Reviewer", permissions: ["items:read", "items:delete"] },
      },
      {
        path: `/workspaces/${wid}/members/member-${wid}`,
        method: "PATCH",
        body: { roleId: detail.role.id },
      },
      {
        path: `/workspaces/${wid}/members/member-${wid}`,
        method: "DELETE",
        body: null,
      },
    ]);
    expect(state.errors).toEqual([]);
  });
}
