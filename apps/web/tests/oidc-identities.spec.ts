import { test, expect, type Page } from "@playwright/test";
import type { OidcIdentity } from "../src/lib/api";

const admin = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Administrator",
  email: "admin@example.test",
  isAdmin: true,
};
const account = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Account A",
  email: "a@example.test",
  isAdmin: false,
};
const other = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Account B",
  email: "b@example.test",
  isAdmin: false,
};
const identity: OidcIdentity = {
  id: "44444444-4444-4444-8444-444444444444",
  userId: account.id,
  issuer: `https://issuer.example.test/${"exact-case-".repeat(20)}Tenant/`,
  subject: `Subject-${"opaque-".repeat(25)}A`,
  createdAt: "2026-09-06T03:04:05.000Z",
};
const secret = "test-only-secret-must-not-render";
const endpoint = "/api/v1/admin/oidc-identities";

async function fixture(
  page: Page,
  access: "admin" | "member" | "guest" = "admin",
) {
  await page.addInitScript(() => {
    const observed = window as typeof window & { oidcAborts: string[] };
    observed.oidcAborts = [];
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).includes("/admin/oidc-identities"))
        init?.signal?.addEventListener(
          "abort",
          () => {
            observed.oidcAborts.push(`${init.method} ${String(input)}`);
          },
          { once: true },
        );
      return original(input, init);
    };
  });
  const state = {
    identities: [] as OidcIdentity[],
    listError: 0,
    linkError: 0,
    unlinkError: 0,
    requests: [] as { path: string; method: string; body: unknown }[],
    errors: [] as string[],
    logs: [] as string[],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  page.on("console", (entry) => state.logs.push(entry.text()));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postDataJSON();
    state.requests.push({ path: url.pathname + url.search, method, body });
    if (url.pathname.endsWith("/auth/me"))
      return route.fulfill(
        access === "guest"
          ? { status: 401, json: { error: "Sign in required" } }
          : { json: access === "admin" ? admin : account },
      );
    if (url.pathname.endsWith("/config"))
      return route.fulfill({
        json: {
          landingEnabled: true,
          registrationEnabled: false,
          setupRequired: false,
          ssoEnabled: true,
          aiEnabled: false,
        },
      });
    if (url.pathname.includes("/admin/") && access !== "admin")
      return route.fulfill({
        status: 403,
        json: { error: "Administrator access required" },
      });
    if (url.pathname.endsWith("/admin/users"))
      return route.fulfill({ json: [admin, account, other] });
    if (url.pathname.endsWith("/admin/status"))
      return route.fulfill({ json: { status: "ok", oidc: true } });
    if (url.pathname.endsWith("/admin/audit"))
      return route.fulfill({ json: [] });
    if (url.pathname === endpoint && method === "GET") {
      if (state.listError)
        return route.fulfill({
          status: state.listError,
          json: {
            error:
              state.listError === 403
                ? "Administrator access required"
                : "Identity listing unavailable",
          },
        });
      return route.fulfill({
        json: state.identities.filter(
          (row) => row.userId === url.searchParams.get("userId"),
        ),
      });
    }
    if (url.pathname === endpoint && method === "POST") {
      if (state.linkError)
        return route.fulfill({
          status: state.linkError,
          json: {
            error:
              "This issuer and subject are already linked to another account",
          },
        });
      state.identities.push({ ...identity, ...body });
      return route.fulfill({ status: 201, json: { id: identity.id } });
    }
    if (url.pathname.startsWith(`${endpoint}/`) && method === "DELETE") {
      if (state.unlinkError)
        return route.fulfill({
          status: state.unlinkError,
          json: {
            error: "Cannot unlink the last sign-in method without a password",
          },
        });
      state.identities = state.identities.filter(
        (row) =>
          row.id !==
          decodeURIComponent(url.pathname.slice(endpoint.length + 1)),
      );
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname.endsWith("/site/settings") && method === "GET")
      return route.fulfill({ json: { landingDisabled: false, logo: null } });
    state.errors.push(`Unexpected request: ${method} ${url.pathname}`);
    return route.fulfill({
      status: 404,
      json: { error: "Unhandled mock route" },
    });
  });
  return state;
}

async function chooseAccount(page: Page, id = account.id) {
  await page
    .getByRole("combobox", { name: "Identity account", exact: true })
    .selectOption(id);
}

async function fillIdentity(page: Page) {
  await page
    .getByLabel("Exact issuer URL", { exact: true })
    .fill(identity.issuer);
  await page
    .getByLabel("Exact OIDC subject (sub)", { exact: true })
    .fill(identity.subject);
  await page.getByRole("checkbox", { name: /I verified this issuer/ }).check();
}

for (const width of [1280, 390, 320]) {
  test(`identity link/unlink contract, explicit verification and safe rendering at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await fixture(page);
    await page.goto("/admin");
    const section = page.getByRole("region", { name: "OIDC identities" });
    await expect(section).toBeVisible();
    expect(state.requests.filter((r) => r.path.startsWith(endpoint))).toEqual(
      [],
    );
    await chooseAccount(page);
    await expect(
      section.getByText("No linked identities for this account."),
    ).toBeVisible();
    await expect(
      page.getByLabel("Exact issuer URL", { exact: true }),
    ).toHaveValue("");
    await expect(
      page.getByLabel("Exact OIDC subject (sub)", { exact: true }),
    ).toHaveValue("");
    await expect(section).toContainText("Email is not proof of identity");
    await expect(section).toContainText("issuer is Hydra, not Kratos");
    await page
      .getByLabel("Exact issuer URL", { exact: true })
      .fill("http://issuer.example.test");
    await page
      .getByLabel("Exact OIDC subject (sub)", { exact: true })
      .fill(identity.subject);
    await page
      .getByRole("button", { name: "Link identity", exact: true })
      .click();
    expect(state.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    await page
      .getByLabel("Exact issuer URL", { exact: true })
      .fill(identity.issuer);
    await page
      .getByRole("button", { name: "Link identity", exact: true })
      .click();
    expect(state.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    await page
      .getByRole("checkbox", { name: /I verified this issuer/ })
      .check();
    await page
      .getByRole("button", { name: "Link identity", exact: true })
      .press("Enter");
    const list = page.getByRole("list", { name: "Linked identities" });
    await expect(list).toContainText(identity.issuer);
    await expect(list).toContainText(identity.subject);
    await expect(list.locator("time")).toHaveAttribute(
      "datetime",
      identity.createdAt,
    );
    await expect(
      page.getByRole("heading", { name: "Linked identities", exact: true }),
    ).toBeFocused();
    expect(state.requests.find((r) => r.method === "POST")).toEqual({
      path: endpoint,
      method: "POST",
      body: {
        userId: account.id,
        issuer: identity.issuer,
        subject: identity.subject,
      },
    });
    await expect(
      page.getByLabel("Exact OIDC subject (sub)", { exact: true }),
    ).toHaveValue("");
    await expect(
      page.getByRole("checkbox", { name: /I verified this issuer/ }),
    ).not.toBeChecked();

    // Even unexpected extra response fields must not become a raw JSON/secret viewer.
    state.identities = [
      {
        ...identity,
        passwordHash: secret,
        tokenHash: secret,
        clientSecret: secret,
      } as OidcIdentity,
    ];
    await page.getByRole("button", { name: "Refresh identities" }).click();
    await expect(list).toBeVisible();
    await expect(section).not.toContainText(secret);
    expect(state.logs.join("\n")).not.toContain(secret);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await section.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);

    const unlink = list.getByRole("button", { name: /^Unlink subject/ });
    await unlink.focus();
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain(account.email);
      expect(dialog.message()).toContain(identity.issuer);
      expect(dialog.message()).toContain(identity.subject);
      expect(dialog.message()).toContain(
        "ALL sessions and programmatic tokens",
      );
      await dialog.dismiss();
    });
    await unlink.press("Enter");
    await expect(unlink).toBeFocused();
    expect(state.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    page.once("dialog", (dialog) => dialog.accept());
    await unlink.press("Enter");
    await expect(
      section.getByText("No linked identities for this account."),
    ).toBeVisible();
    await expect(section.getByRole("status")).toContainText(
      "All sessions and programmatic tokens",
    );
    await expect(
      page.getByRole("heading", { name: "Linked identities", exact: true }),
    ).toBeFocused();
    expect(state.requests.filter((r) => r.method === "DELETE")).toEqual([
      { path: `${endpoint}/${identity.id}`, method: "DELETE", body: null },
    ]);
    expect(state.errors).toEqual([]);
  });
}

test("server link conflict preserves draft; last-method unlink conflict preserves identity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  state.linkError = 409;
  await page.goto("/admin");
  await chooseAccount(page);
  await expect(
    page.getByText("No linked identities for this account."),
  ).toBeVisible();
  await fillIdentity(page);
  await page
    .getByRole("button", { name: "Link identity", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "already linked to another account",
  );
  await expect(
    page.getByLabel("Exact OIDC subject (sub)", { exact: true }),
  ).toHaveValue(identity.subject);
  state.linkError = 0;
  await page
    .getByRole("button", { name: "Link identity", exact: true })
    .click();
  const unlink = page.getByRole("button", { name: /^Unlink subject/ });
  await expect(unlink).toBeVisible();
  state.unlinkError = 409;
  page.once("dialog", (dialog) => dialog.accept());
  await unlink.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Cannot unlink the last sign-in method without a password",
  );
  await expect(unlink).toBeEnabled();
  expect(state.identities).toHaveLength(1);
  await expect(
    page
      .getByRole("region", { name: "OIDC identities" })
      .getByRole("status"),
  ).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test("failed listing offers retry and surfaces server permission denial without an empty-list claim", async ({
  page,
}) => {
  const state = await fixture(page);
  state.listError = 503;
  await page.goto("/admin");
  await chooseAccount(page);
  await expect(page.getByRole("alert")).toHaveText(
    "Identity listing unavailable",
  );
  await expect(
    page.getByText("No linked identities for this account."),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Link identity", exact: true }),
  ).toBeDisabled();
  state.listError = 403;
  await page.getByRole("button", { name: "Refresh identities" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Administrator access required",
  );
  state.listError = 0;
  await page.getByRole("button", { name: "Refresh identities" }).click();
  await expect(
    page.getByText("No linked identities for this account."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Link identity", exact: true }),
  ).toBeEnabled();
  expect(state.errors).toEqual([]);
});

test("switching accounts cancels delayed reads, clears drafts and never displays another account's identities", async ({
  page,
}) => {
  const state = await fixture(page);
  state.identities = [identity];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**${endpoint}?userId=${account.id}`, async (route) => {
    started();
    await held;
    await route.fulfill({ json: [identity] });
  });
  await page.goto("/admin");
  await chooseAccount(page);
  await requested;
  await expect(page.getByText("Loading linked identities...")).toBeVisible();
  await fillIdentity(page);
  await chooseAccount(page, other.id);
  await expect(
    page.getByText("No linked identities for this account."),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as typeof window & { oidcAborts: string[] }).oidcAborts,
    ),
  ).toContain(`GET ${endpoint}?userId=${account.id}`);
  release();
  await expect(
    page.getByLabel("Exact issuer URL", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("Exact OIDC subject (sub)", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("checkbox", { name: /I verified this issuer/ }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("list", { name: "Linked identities" }),
  ).toHaveCount(0);
  // A mixed response is also defensively filtered, not trusted as authorization.
  await page.route(`**${endpoint}?userId=${other.id}`, (route) =>
    route.fulfill({ json: [identity] }),
  );
  await page.getByRole("button", { name: "Refresh identities" }).click();
  await expect(
    page.getByText("No linked identities for this account."),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Linked identities" }),
  ).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

for (const method of ["POST", "DELETE"]) {
  test(`switching accounts during ${method} isolates completion and prevents duplicate mutations`, async ({
    page,
  }) => {
    const state = await fixture(page);
    if (method === "DELETE") state.identities = [identity];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    let writes = 0;
    await page.route(`**${endpoint}**`, async (route) => {
      if (route.request().method() !== method) return route.fallback();
      writes++;
      started();
      await held;
      await route.fulfill({
        json: method === "POST" ? { id: identity.id } : { success: true },
      });
    });
    await page.goto("/admin");
    await chooseAccount(page);
    await expect(
      page.getByRole("button", { name: "Refresh identities" }),
    ).toBeEnabled();
    if (method === "POST") {
      await fillIdentity(page);
      await page
        .getByRole("button", { name: "Link identity", exact: true })
        .click();
    } else {
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: /^Unlink subject/ }).click();
    }
    await requested;
    await expect(
      page.getByRole("button", { name: "Saving...", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Refresh identities" }),
    ).toBeDisabled();
    await chooseAccount(page, other.id);
    await expect(
      page.getByText("No linked identities for this account."),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as typeof window & { oidcAborts: string[] }).oidcAborts,
      ),
    ).toContain(
      `${method} ${endpoint}${method === "DELETE" ? `/${identity.id}` : ""}`,
    );
    await page
      .getByLabel("Exact OIDC subject (sub)", { exact: true })
      .fill("Other-account-draft");
    release();
    await expect(
      page.getByLabel("Exact OIDC subject (sub)", { exact: true }),
    ).toHaveValue("Other-account-draft");
    await expect(
      page
        .getByRole("region", { name: "OIDC identities" })
        .getByRole("status"),
    ).toHaveCount(0);
    expect(writes).toBe(1);
    expect(state.errors).toEqual([]);
  });
}

test("unlinking the current administrator warns about own sign-out and returns to login", async ({
  page,
}) => {
  const state = await fixture(page);
  state.identities = [{ ...identity, userId: admin.id }];
  await page.goto("/admin");
  await chooseAccount(page, admin.id);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain(
      "This is your account. You will need to sign in again.",
    );
    await dialog.accept();
  });
  await page.getByRole("button", { name: /^Unlink subject/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(state.errors).toEqual([]);
});

for (const access of ["member", "guest"] as const) {
  test(`${access} cannot reveal identity management by navigating directly to admin`, async ({
    page,
  }) => {
    const state = await fixture(page, access);
    await page.goto("/admin");
    if (access === "guest") await expect(page).toHaveURL(/\/login$/);
    else
      await expect(
        page.getByRole("heading", { name: "Administrator access required" }),
      ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "OIDC identities" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Administration", exact: true }),
    ).toHaveCount(0);
    expect(
      state.requests.filter((r) => r.path.includes("/admin/")),
    ).toHaveLength(0);
    // Mock contract only: actual endpoint authorization belongs to backend integration tests.
    const denied = await page.evaluate(async (path) => {
      const response = await fetch(path);
      return { status: response.status, body: await response.json() };
    }, endpoint);
    expect(denied).toEqual({
      status: 403,
      body: { error: "Administrator access required" },
    });
    expect(state.errors).toEqual([]);
  });
}
