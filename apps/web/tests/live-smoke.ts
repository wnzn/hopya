import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import {
  createServer,
  request as forward,
  type ClientRequest,
} from "node:http";
import { connect } from "node:net";
import { chromium, expect, type Browser } from "@playwright/test";
import { runLiveWorkflows } from "./live-workflows";
import type {
  Detail,
  Field,
  Item,
  OidcIdentity,
  Role,
  TreeNode,
  User,
} from "../src/lib/api";

for (const [file, command] of [
  [
    new URL("../../api/build/adonisrc.js", import.meta.url),
    "npm run build -w @hopya/api",
  ],
  [
    new URL("../dist/server/entry.mjs", import.meta.url),
    "npm run build -w @hopya/web",
  ],
] as const) {
  await access(file).catch(() => {
    throw new Error(`Missing built artifact. Run ${command} first.`);
  });
}
const setupToken = randomBytes(32).toString("hex");
const password = randomBytes(24).toString("base64url");
let directory: string | undefined;
let browser: Browser | undefined;
let acquiring: Promise<unknown> = Promise.resolve();
const children: ChildProcess[] = [];
const ports: number[] = [];
const upstreams = new Set<ClientRequest>();
const abort = new AbortController();
let apiPort = 0;
let webPort = 0;
let serving = false;
const proxy = createServer((request, response) => {
  if (
    !serving ||
    children.some(
      (child) => child.exitCode !== null || child.signalCode !== null,
    )
  ) {
    response.writeHead(503).end();
    return;
  }
  const path = request.url || "/";
  const pathname = path.split("?")[0];
  const api =
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/health";
  // Stream bytes unchanged; preserve Host, Origin, Cookie, and Set-Cookie arrays.
  const upstream = forward(
    {
      hostname: "127.0.0.1",
      port: api ? apiPort : webPort,
      path,
      method: request.method,
      headers: request.headers,
      agent: false,
    },
    (incoming) => {
      response.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.on("error", () => response.destroy());
      incoming.pipe(response);
    },
  );
  upstreams.add(upstream);
  upstream.on("close", () => upstreams.delete(upstream));
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502).end();
    else response.destroy();
  });
  upstream.setTimeout(30_000, () => upstream.destroy());
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
});
proxy.requestTimeout = 30_000;
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return (cleanupPromise ||= (async () => {
    serving = false;
    // A signal may arrive while a directory or browser is still being created.
    await acquiring.catch(() => {});
    let browserClosed = true;
    await browser?.close().catch(() => {
      browserClosed = false;
    });
    for (const upstream of upstreams) upstream.destroy();
    await new Promise<void>((resolve) => {
      proxy.close(() => resolve());
      proxy.closeAllConnections();
    });
    await Promise.all(
      children.map(async (child) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null)
          return;
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    if (directory) await rm(directory, { recursive: true, force: true });
    if (!browserClosed) throw new Error("Fixture browser cleanup failed");
    for (const port of ports) {
      const closed = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(false);
        });
        socket.once("error", () => resolve(true));
        socket.setTimeout(1_000, () => {
          socket.destroy();
          resolve(false);
        });
      });
      if (!closed)
        throw new Error(
          `Fixture cleanup could not confirm port ${port} closed`,
        );
    }
    console.log(
      `Live fixture cleanup passed: ${ports.length} owned ports closed; temporary data removed.`,
    );
  })());
}
function interrupt(signal: NodeJS.Signals) {
  abort.abort();
  void cleanup().then(
    () => process.exit(signal === "SIGINT" ? 130 : 143),
    () => {
      console.error("Interrupted fixture cleanup failed");
      process.exit(1);
    },
  );
}
const onInterrupt = () => interrupt("SIGINT");
const onTerminate = () => interrupt("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);

async function start(service: "api" | "web", origin: string) {
  abort.signal.throwIfAborted();
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("./live-server.ts", import.meta.url)),
      service,
    ],
    {
      cwd: directory,
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "0",
        HOME: directory,
        TMPDIR: directory,
        TZ: "UTC",
        LOG_LEVEL: "silent",
        ASTRO_TELEMETRY_DISABLED: "1",
        ASTRO_NODE_AUTOSTART: "disabled",
        ASTRO_NODE_LOGGING: "disabled",
        LANDING_ENABLED: "true",
        ...(service === "api"
          ? {
              DATA_DIR: directory,
              SETUP_TOKEN: setupToken,
              APP_URL: origin,
              APP_KEY: randomBytes(32).toString("hex"),
              REGISTRATION_ENABLED: "false",
              STORAGE_DRIVER: "filesystem",
              TRUST_PROXY_HOPS: "0",
            }
          : {}),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  children.push(child);
  // Trust only this child's IPC, never a successful probe on a released port.
  return new Promise<number>((resolve, reject) => {
    const fail = () => {
      finish();
      reject(
        new Error(`${service} fixture failed before owned-listener readiness`),
      );
    };
    const ready = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const result = message as {
        type?: string;
        service?: string;
        port?: number;
      };
      if (result.type === "fixture-error") return fail();
      if (result.type !== "fixture-ready" || result.service !== service) return;
      if (
        !Number.isInteger(result.port) ||
        result.port! <= 0 ||
        result.port! > 65535 ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        return fail();
      ports.push(result.port!);
      finish();
      resolve(result.port!);
    };
    const timer = setTimeout(fail, 20_000);
    function finish() {
      clearTimeout(timer);
      child.off("message", ready);
      child.off("error", fail);
      child.off("exit", fail);
      abort.signal.removeEventListener("abort", fail);
    }
    child.on("message", ready);
    child.once("error", fail);
    child.once("exit", fail);
    abort.signal.addEventListener("abort", fail, { once: true });
  });
}

try {
  acquiring = mkdtemp(
    join(process.env.HOPYA_TEST_TMP_DIR || tmpdir(), "hopya-web-live-"),
  ).then(async (path) => {
    directory = path;
    await chmod(path, 0o700);
  });
  await acquiring;
  abort.signal.throwIfAborted();
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening", { signal: abort.signal });
  const address = proxy.address();
  if (!address || typeof address === "string")
    throw new Error("Proxy did not bind loopback");
  ports.push(address.port);
  const origin = `http://127.0.0.1:${address.port}`;
  apiPort = await start("api", origin);
  webPort = await start("web", origin);
  abort.signal.throwIfAborted();
  serving = true;
  const readinessSignal = AbortSignal.any([
    abort.signal,
    AbortSignal.timeout(5_000),
  ]);
  expect(
    (await fetch(`${origin}/health`, { signal: readinessSignal })).status,
  ).toBe(200);
  expect(
    await (
      await fetch(`${origin}/api/v1/config`, { signal: readinessSignal })
    ).json(),
  ).toMatchObject({ setupRequired: true, aiEnabled: false, ssoEnabled: false });
  console.log(
    `Owned compiled API, built Astro and same-origin proxy ready on loopback ports ${apiPort}, ${webPort}, ${address.port}.`,
  );
  abort.signal.throwIfAborted();
  acquiring = chromium
    .launch({
      timeout: 15_000,
      env: {
        PATH: process.env.PATH || "",
        HOME: directory,
        TMPDIR: directory,
        LANG: "en_US.UTF-8",
      },
    })
    .then((instance) => {
      browser = instance;
    });
  await acquiring;
  abort.signal.throwIfAborted();
  if (!browser) throw new Error("Fixture browser did not launch");
  const page = await browser.newPage({
    viewport: { width: 1440, height: 950 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dashboardReads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && /\/items(?:\/page)?$/.test(url.pathname))
      dashboardReads.push(url.pathname);
  });
  await page.goto(`${origin}/login`);
  await page.getByLabel("Your name").fill("Browser verification");
  await page
    .getByLabel("Email", { exact: true })
    .fill(`web-${randomUUID()}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Operator setup token").fill(setupToken);
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page
    .getByRole("button", { name: "Create your first workspace" })
    .click();
  await page.getByLabel("Workspace name").fill("Temporary verification space");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create a project", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Verification project");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.getByRole("button", { name: "Add a list", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Verification list");
  await page
    .getByRole("combobox", { name: "Type", exact: true })
    .selectOption("list");
  await page
    .getByRole("combobox", { name: "Parent project or folder" })
    .selectOption({ label: "Verification project (project)" });
  await page.getByRole("button", { name: "Create list", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a task", exact: true })
    .click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Verify real REST persistence");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Temporary browser integration verification.");
  await page.getByRole("dialog").getByRole("button", { name: "Add fields", exact: true }).click();
  const projectFields = page.getByRole("dialog", { name: "Project fields", exact: true });
  await projectFields.getByRole("checkbox", { name: "Start date Built-in", exact: true }).check();
  await projectFields.getByRole("button", { name: "Apply fields", exact: true }).click();
  await expect(projectFields.getByRole("status")).toHaveText("Project fields updated.");
  await projectFields.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByLabel("Start date", { exact: true }).fill("2026-09-03");
  await page.getByLabel("Due date", { exact: true }).fill("2026-09-08");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Verify real REST persistence",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Verify real REST persistence",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Board", exact: true }).click();
  await page
    .getByLabel("Move Verify real REST persistence to status")
    .selectOption("done");
  await expect(
    page.getByLabel("Move Verify real REST persistence to status"),
  ).toHaveValue("done");
  await page.screenshot({
    path: join(directory!, "live-board.png"),
    fullPage: true,
  });
  await page.goto(`${origin}/settings`);
  await expect(page.getByLabel("Display name")).toHaveValue(
    "Browser verification",
  );
  await expect(
    page.getByRole("heading", { name: "Roles & permissions" }),
  ).toBeVisible();
  expect(dashboardReads.length).toBeGreaterThan(0);
  expect(dashboardReads.every((path) => path.endsWith("/items/page"))).toBe(
    true,
  );
  // Native downloads bypass Playwright's mock routes in some engines; verify against the real server.
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).endsWith("/export"))
        throw new Error(
          "Workspace export must not be buffered by application fetch",
        );
      return fetch(input, init);
    };
  });
  const exporting = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Download workspace JSON" })
    .press("Enter");
  const exported = await exporting;
  expect(exported.suggestedFilename()).toMatch(/^hopya-.+\.json$/);
  expect(await exported.failure()).toBeNull();
  const exportChunks: Buffer[] = [];
  for await (const chunk of await exported.createReadStream())
    exportChunks.push(Buffer.from(chunk));
  const exportData = JSON.parse(Buffer.concat(exportChunks).toString()) as {
    items: Item[];
  };
  expect(exportData.items).toHaveLength(1);
  expect(exportData.items[0].title).toBe("Verify real REST persistence");
  await expect(page).toHaveURL(/\/settings$/);
  await page.goto(`${origin}/admin`);
  await expect(
    page.getByRole("heading", { name: "Instance status" }),
  ).toBeVisible();
  await expect(
    page.getByRole("rowheader", { name: "item.create", exact: true }),
  ).toBeVisible();

  const teammates = [
    {
      name: "First workspace colleague",
      email: `first-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
    },
    {
      name: "Second workspace colleague",
      email: `second-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
    },
  ];
  for (const teammate of teammates) {
    await page.getByLabel("Name", { exact: true }).fill(teammate.name);
    await page.getByLabel("Email", { exact: true }).fill(teammate.email);
    await page.getByLabel("Initial password").fill(teammate.password);
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(
      page.getByRole("rowheader", { name: teammate.name, exact: true }),
    ).toBeVisible();
  }
  const apiUrl = `${origin}/api/v1`;
  // Exercise the proxy with binary storage bytes as well as the JSON/UI flows.
  const spaces = (await (
    await page.request.get(`${apiUrl}/workspaces`)
  ).json()) as { id: string }[];
  const tasks = (await (
    await page.request.get(`${apiUrl}/workspaces/${spaces[0].id}/items`)
  ).json()) as { id: string }[];
  const attachmentsUrl = `${apiUrl}/workspaces/${spaces[0].id}/items/${tasks[0].id}/attachments`;
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
  const upload = await page.request.post(attachmentsUrl, {
    headers: { Origin: origin },
    data: {
      name: "proxy-stream.bin",
      contentType: "application/octet-stream",
      data: bytes.toString("base64"),
    },
  });
  expect(upload.status()).toBe(201);
  const attachment = (await upload.json()) as { id: string };
  const download = await page.request.get(`${attachmentsUrl}/${attachment.id}`);
  expect(download.status()).toBe(200);
  expect(await download.body()).toEqual(bytes);
  expect(
    (
      await page.request.post(`${apiUrl}/auth/logout`, {
        headers: { Origin: "https://wrong-origin.example.test" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  console.log(
    "Same-origin proxy acceptance passed: exact binary round trip and foreign-Origin mutation rejected.",
  );
  const teammateContext = await browser.newContext();
  try {
    const credentials = {
      email: teammates[0].email,
      password: teammates[0].password,
    };
    const login = await teammateContext.request.post(`${apiUrl}/auth/login`, {
      headers: { Origin: origin },
      data: credentials,
    });
    expect(login.status()).toBe(200);
    const target = (await login.json()) as User;
    expect(target.email).toBe(teammates[0].email);
    expect(target.isAdmin).toBe(false);
    expect(
      (await teammateContext.request.get(`${apiUrl}/auth/me`)).status(),
    ).toBe(200);
    expect(
      (
        await teammateContext.request.get(`${apiUrl}/admin/oidc-identities`)
      ).status(),
    ).toBe(403);
    const issued = await teammateContext.request.post(`${apiUrl}/auth/tokens`, {
      headers: { Origin: origin },
      data: { name: "Live identity unlink verification" },
    });
    expect(issued.status()).toBe(201);
    const { token } = (await issued.json()) as { token: string };
    expect(typeof token).toBe("string");
    // Node fetch has no browser cookies, so this verifies the bearer token independently.
    expect(
      (
        await fetch(`${apiUrl}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);

    const section = page.getByRole("region", { name: "OIDC identities" });
    const accountSelect = section.getByRole("combobox", {
      name: "Identity account",
      exact: true,
    });
    const targetLabel = `${teammates[0].name} (${teammates[0].email})`;
    await accountSelect.selectOption({ label: targetLabel });
    await expect(accountSelect).toHaveValue(target.id);
    await expect(
      section.getByText("No linked identities for this account."),
    ).toBeVisible();
    await expect(
      section.getByLabel("Exact issuer URL", { exact: true }),
    ).toHaveValue("");
    await expect(
      section.getByLabel("Exact OIDC subject (sub)", { exact: true }),
    ).toHaveValue("");
    // Test-only metadata binding, not an IdP login or a claim of Ory verification.
    const issuer = "https://identity.example.test/";
    const subject = randomUUID();
    await section.getByLabel("Exact issuer URL", { exact: true }).fill(issuer);
    await section
      .getByLabel("Exact OIDC subject (sub)", { exact: true })
      .fill(subject);
    const verified = section.getByRole("checkbox", {
      name: /I verified this issuer/,
    });
    await verified.check();
    await expect(verified).toBeChecked();
    const identitiesUrl = `${apiUrl}/admin/oidc-identities?userId=${target.id}`;
    const linkedRefresh = page.waitForResponse(
      (response) =>
        response.url() === identitiesUrl &&
        response.request().method() === "GET",
    );
    await section
      .getByRole("button", { name: "Link identity", exact: true })
      .click();
    const linkedResponse = await linkedRefresh;
    expect(linkedResponse.status()).toBe(200);
    const linked = (await linkedResponse.json()) as OidcIdentity[];
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ userId: target.id, issuer, subject });
    const list = section.getByRole("list", { name: "Linked identities" });
    await expect(list).toContainText(issuer);
    await expect(list).toContainText(subject);
    await expect(list.locator("time")).toHaveAttribute(
      "datetime",
      linked[0].createdAt,
    );
    await accountSelect.selectOption({
      label: `${teammates[1].name} (${teammates[1].email})`,
    });
    await expect(accountSelect).not.toHaveValue(target.id);
    await expect(
      section.getByText("No linked identities for this account."),
    ).toBeVisible();
    await expect(list).toHaveCount(0);
    await accountSelect.selectOption({ label: targetLabel });
    await expect(accountSelect).toHaveValue(target.id);
    await expect(list).toContainText(subject);

    const unlinkedRefresh = page.waitForResponse(
      (response) =>
        response.url() === identitiesUrl &&
        response.request().method() === "GET",
    );
    page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain(teammates[0].email);
      expect(dialog.message()).toContain(issuer);
      expect(dialog.message()).toContain(subject);
      expect(dialog.message()).toContain(
        "ALL sessions and programmatic tokens",
      );
      await dialog.accept();
    });
    await list.getByRole("button", { name: /^Unlink subject/ }).click();
    const unlinkedResponse = await unlinkedRefresh;
    expect(unlinkedResponse.status()).toBe(200);
    expect(await unlinkedResponse.json()).toEqual([]);
    await expect(
      section.getByText("No linked identities for this account."),
    ).toBeVisible();
    await expect(list).toHaveCount(0);
    await expect(accountSelect).toHaveValue(target.id);
    await expect(section.getByRole("status")).toContainText(
      "All sessions and programmatic tokens",
    );
    await expect(section.getByRole("alert")).toHaveCount(0);
    expect(
      (await teammateContext.request.get(`${apiUrl}/auth/me`)).status(),
    ).toBe(401);
    expect(
      (
        await fetch(`${apiUrl}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
    const accountsResponse = await page.request.get(`${apiUrl}/admin/users`);
    expect(accountsResponse.status()).toBe(200);
    const accounts = (await accountsResponse.json()) as User[];
    for (const teammate of teammates)
      expect(
        accounts.find((account) => account.email === teammate.email),
      ).toMatchObject({ disabled: false });
    const relogin = await teammateContext.request.post(`${apiUrl}/auth/login`, {
      headers: { Origin: origin },
      data: credentials,
    });
    expect(relogin.status()).toBe(200);
    expect(await relogin.json()).toMatchObject({
      id: target.id,
      isAdmin: false,
    });
    expect(errors).toEqual([]);
    console.log(
      "Identity administration live browser acceptance passed: real Adonis link/list/unlink, account isolation, member API 403, session/token revocation 401, accounts remain active and password login survives. Metadata-only fixture; no IdP contacted.",
    );
  } finally {
    await teammateContext.close();
  }
  await page.goto(`${origin}/settings`);
  const workspaceSelect = page.getByRole("combobox", {
    name: "Selected workspace",
  });
  await expect(
    page.getByRole("button", { name: "Add member", exact: true }),
  ).toBeVisible();
  const firstWorkspaceId = await workspaceSelect.inputValue();
  await page.getByLabel("Existing user's email").fill(teammates[0].email);
  await page
    .getByRole("combobox", { name: "Role", exact: true })
    .selectOption({ label: "Member" });
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(
    page.getByText(teammates[0].email, { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Name", { exact: true })
    .fill("Renamed first workspace");
  await page.getByRole("button", { name: "Rename workspace" }).click();
  await expect(
    workspaceSelect.locator(`option[value="${firstWorkspaceId}"]`),
  ).toHaveText("Renamed first workspace");

  await page.goto(`${origin}/app`);
  await page
    .getByRole("button", { name: "+ New workspace", exact: true })
    .click();
  await page.getByLabel("Workspace name").fill("Second verification workspace");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "WORKSPACE", exact: true }),
  ).not.toHaveValue(firstWorkspaceId);
  await page.goto(`${origin}/settings`);
  await expect(
    page.getByRole("button", { name: "Add member", exact: true }),
  ).toBeVisible();
  const secondWorkspaceId = await workspaceSelect.inputValue();
  await page.getByLabel("Existing user's email").fill(teammates[1].email);
  await page
    .getByRole("combobox", { name: "Role", exact: true })
    .selectOption({ label: "Member" });
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(
    page.getByText(teammates[1].email, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(teammates[0].email, { exact: true })).toHaveCount(
    0,
  );

  let release!: () => void;
  let captured!: () => void;
  let delivered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const responseCaptured = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const responseDelivered = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const delayedPath = `**/api/v1/workspaces/${firstWorkspaceId}`;
  await page.route(delayedPath, async (route) => {
    const response = await route.fetch();
    captured();
    await gate;
    try {
      await route.fulfill({ response });
    } finally {
      delivered();
    }
  });
  try {
    await workspaceSelect.selectOption(firstWorkspaceId);
    await responseCaptured;
    await workspaceSelect.selectOption(secondWorkspaceId);
    await expect(
      page.getByText(teammates[1].email, { exact: true }),
    ).toBeVisible();
    release();
    await responseDelivered;
    await expect(workspaceSelect).toHaveValue(secondWorkspaceId);
    await expect(
      page.getByText(teammates[0].email, { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      "Second verification workspace",
    );
    await expect(
      workspaceSelect.locator(`option[value="${firstWorkspaceId}"]`),
    ).toHaveText("Renamed first workspace");
  } finally {
    release();
    await page.unroute(delayedPath);
  }
  await workspaceSelect.selectOption(firstWorkspaceId);
  await expect(
    page.getByText(teammates[0].email, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(teammates[1].email, { exact: true })).toHaveCount(
    0,
  );
  await page.goto(`${origin}/app`);
  await expect(
    page.getByRole("button", {
      name: "Verify real REST persistence",
      exact: true,
    }),
  ).toBeVisible();
  const workspacePath = `/workspaces/${firstWorkspaceId}`;
  async function provision<T>(path: string, data: unknown): Promise<T> {
    const response = await page.request.post(`${apiUrl}${path}`, {
      headers: { Origin: origin },
      data,
    });
    expect(response.status(), `Provisioning ${path}`).toBe(201);
    return response.json() as Promise<T>;
  }
  const originalDetail = (await (
    await page.request.get(`${apiUrl}${workspacePath}`)
  ).json()) as Detail;
  const originalList = originalDetail.nodes.find(
    (node) => node.name === "Verification list",
  )!;
  const movingFolder = await provision<TreeNode>(`${workspacePath}/nodes`, {
    name: "Travelling folder",
    kind: "folder",
    parentId: originalList.parentId,
  });
  const nestedFolder = await provision<TreeNode>(`${workspacePath}/nodes`, {
    name: "Travelling nested folder",
    kind: "folder",
    parentId: movingFolder.id,
  });
  const destinationProject = await provision<TreeNode>(
    `${workspacePath}/nodes`,
    {
      name: "Move destination project",
      kind: "project",
      parentId: null,
    },
  );
  const destinationFolder = await provision<TreeNode>(
    `${workspacePath}/nodes`,
    {
      name: "Move destination folder",
      kind: "folder",
      parentId: destinationProject.id,
    },
  );
  const beforeMove = (await (
    await page.request.get(`${apiUrl}${workspacePath}/export`)
  ).json()) as {
    nodes: TreeNode[];
    items: Item[];
    attachments: { id: string; itemId: string }[];
  };
  await page.reload();
  await page
    .getByTitle("project: Verification project", { exact: true })
    .click();
  const persistedTask = page.getByRole("button", {
    name: "Verify real REST persistence",
    exact: true,
  });
  await expect(persistedTask).toBeVisible();
  // First move a populated list out of its project into a nested folder.
  await page
    .getByRole("button", { name: "Manage Verification list", exact: true })
    .click();
  const parentSelect = page.getByRole("combobox", {
    name: "Parent project or folder",
  });
  await expect(parentSelect).toHaveValue(originalList.parentId!);
  await parentSelect.selectOption(nestedFolder.id);
  let movedResponse = page.waitForResponse(
    (response) =>
      response.url() === `${apiUrl}${workspacePath}/nodes/${originalList.id}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  let moved = await movedResponse;
  expect(moved.status()).toBe(200);
  expect(moved.request().postDataJSON()).toEqual({
    parentId: nestedFolder.id,
    expectedParentId: originalList.parentId,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(persistedTask).toBeVisible();
  // Then carry that entire folder subtree to another project, still in this workspace.
  await page
    .getByRole("button", { name: "Manage Travelling folder", exact: true })
    .click();
  await expect(
    parentSelect.locator(`option[value="${movingFolder.id}"]`),
  ).toHaveCount(0);
  await expect(
    parentSelect.locator(`option[value="${nestedFolder.id}"]`),
  ).toHaveCount(0);
  await expect(
    parentSelect.locator(`option[value="${originalList.id}"]`),
  ).toHaveCount(0);
  await parentSelect.selectOption(destinationFolder.id);
  movedResponse = page.waitForResponse(
    (response) =>
      response.url() === `${apiUrl}${workspacePath}/nodes/${movingFolder.id}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  moved = await movedResponse;
  expect(moved.status()).toBe(200);
  expect(moved.request().postDataJSON()).toEqual({
    parentId: destinationFolder.id,
    expectedParentId: movingFolder.parentId,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Verification project", exact: true }),
  ).toBeVisible();
  await expect(persistedTask).toHaveCount(0);
  await page
    .getByTitle("project: Move destination project", { exact: true })
    .click();
  await expect(persistedTask).toBeVisible();
  await page.reload();
  await page
    .getByTitle("project: Verification project", { exact: true })
    .click();
  await expect(persistedTask).toHaveCount(0);
  await page
    .getByTitle("project: Move destination project", { exact: true })
    .click();
  await expect(persistedTask).toBeVisible();
  const afterMoveResponse = await page.request.get(
    `${apiUrl}${workspacePath}/export`,
  );
  expect(afterMoveResponse.status()).toBe(200);
  const afterMove = (await afterMoveResponse.json()) as typeof beforeMove;
  expect(afterMove.nodes).toEqual(
    beforeMove.nodes.map((node) => ({
      ...node,
      parentId:
        node.id === originalList.id
          ? nestedFolder.id
          : node.id === movingFolder.id
            ? destinationFolder.id
            : node.parentId,
    })),
  );
  expect(afterMove.items).toEqual(beforeMove.items);
  expect(afterMove.attachments).toEqual(beforeMove.attachments);
  expect(afterMove.items.find((item) => item.id === tasks[0].id)?.nodeId).toBe(
    originalList.id,
  );
  expect(afterMove.attachments).toContainEqual(
    expect.objectContaining({ id: attachment.id, itemId: tasks[0].id }),
  );
  expect(
    await (await page.request.get(`${attachmentsUrl}/${attachment.id}`)).body(),
  ).toEqual(bytes);
  console.log(
    "Hierarchy move live acceptance passed: project-to-folder list move, populated nested-folder subtree relocation, source/destination filters, reload persistence, unchanged task IDs/contents and export/attachment links.",
  );
  const privateField = await provision<Field>(`${workspacePath}/fields`, {
    name: "Existing private field definition",
    type: "text",
  });
  for (const permission of [
    "workspace:manage",
    "roles:manage",
    "structure:write",
  ]) {
    const credentials = {
      name: `Live ${permission} manager`,
      email: `scoped-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
    };
    const scopedUser = await provision<User>("/admin/users", credentials);
    expect(scopedUser.isAdmin).toBe(false);
    const scopedRole = await provision<Role>(`${workspacePath}/roles`, {
      name: `Live ${permission}`,
      permissions: [permission],
    });
    await provision(`${workspacePath}/members`, {
      email: credentials.email,
      roleId: scopedRole.id,
    });

    const scopedContext = await browser.newContext();
    const scopedPage = await scopedContext.newPage();
    const taskRequests: string[] = [];
    scopedPage.on("pageerror", (error) => errors.push(error.message));
    scopedPage.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith(`/api/v1${workspacePath}/items`))
        taskRequests.push(path);
    });
    try {
      await scopedPage.goto(`${origin}/login`);
      await scopedPage
        .getByLabel("Email", { exact: true })
        .fill(credentials.email);
      await scopedPage
        .getByLabel("Password", { exact: true })
        .fill(credentials.password);
      await scopedPage
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await expect(scopedPage).toHaveURL(/\/app$/);
      await expect(
        scopedPage.getByRole("heading", {
          name: "Task access is not included in your role",
        }),
      ).toBeVisible();
      await expect(scopedPage.getByRole("tablist")).toHaveCount(0);
      await expect(
        scopedPage.getByRole("button", {
          name: /New task|Create a task|Create your first workspace|Assistant/,
        }),
      ).toHaveCount(0);
      await expect(
        scopedPage.getByText(
          /0 complete|0 tasks in this view|Your next step starts here|Give your work a home/,
        ),
      ).toHaveCount(0);
      await scopedPage.getByLabel("Account menu", { exact: true }).click();
      await expect(
        scopedPage.getByRole("link", { name: "Administration", exact: true }),
      ).toHaveCount(0);
      await scopedPage.getByLabel("Account menu", { exact: true }).press("Escape");

      const identity = await scopedPage.request.get(`${apiUrl}/auth/me`);
      expect(identity.status()).toBe(200);
      expect(await identity.json()).toMatchObject({
        id: scopedUser.id,
        isAdmin: false,
      });
      const metadata = await scopedPage.request.get(
        `${apiUrl}${workspacePath}`,
      );
      expect(metadata.status()).toBe(200);
      const detail = (await metadata.json()) as Detail;
      expect(detail.workspace.id).toBe(firstWorkspaceId);
      expect(detail.role.id).toBe(scopedRole.id);
      expect(detail.permissions).toEqual([permission]);
      expect(detail.members).toEqual([]);
      if (permission === "structure:write") {
        expect(detail.nodes.some((node) => node.kind === "list")).toBe(true);
        expect(detail.fields.map((field) => field.id)).toContain(
          privateField.id,
        );
      } else {
        expect(detail.nodes).toEqual([]);
        expect(detail.fields).toEqual([]);
      }
      if (permission === "roles:manage")
        expect(detail.roles.length).toBeGreaterThan(1);
      else expect(detail.roles.map((role) => role.id)).toEqual([scopedRole.id]);
      for (const suffix of ["/items", "/items/page?limit=200", "/export"]) {
        const denied = await scopedPage.request.get(
          `${apiUrl}${workspacePath}${suffix}`,
        );
        expect(denied.status(), `${permission} must not read ${suffix}`).toBe(
          403,
        );
      }

      await scopedPage
        .getByRole("link", { name: "Open workspace settings" })
        .click();
      await expect(
        scopedPage.getByText(`Your role: ${scopedRole.name}`, { exact: true }),
      ).toBeVisible();
      await expect(
        scopedPage.getByRole("link", { name: "Download workspace JSON" }),
      ).toHaveCount(0);
      if (permission === "workspace:manage") {
        await scopedPage
          .getByLabel("Name", { exact: true })
          .fill("Renamed by management-only user");
        await scopedPage
          .getByRole("button", { name: "Rename workspace" })
          .click();
        await expect(
          scopedPage
            .getByRole("combobox", { name: "Selected workspace" })
            .locator(`option[value="${firstWorkspaceId}"]`),
        ).toHaveText("Renamed by management-only user");
        await scopedPage.reload();
        await expect(
          scopedPage.getByLabel("Name", { exact: true }),
        ).toHaveValue("Renamed by management-only user");
      } else if (permission === "roles:manage") {
        await scopedPage.getByRole("button", { name: "Create role" }).click();
        await scopedPage
          .getByLabel("Role name")
          .fill("Live role without task access");
        await scopedPage.getByRole("button", { name: "Save role" }).click();
        await expect(scopedPage.getByRole("dialog")).toHaveCount(0);
        await expect(
          scopedPage.getByText("Live role without task access", {
            exact: true,
          }),
        ).toBeVisible();
      } else {
        await scopedPage
          .getByLabel("Field name")
          .fill("Live structure-only field");
        await scopedPage
          .getByRole("combobox", { name: "Type", exact: true })
          .selectOption("number");
        await scopedPage.getByRole("button", { name: "Create field" }).click();
        await expect(
          scopedPage.getByText("Live structure-only field", { exact: true }),
        ).toBeVisible();
      }
      const persisted = await scopedPage.request.get(
        `${apiUrl}${workspacePath}`,
      );
      expect(persisted.status()).toBe(200);
      const updated = (await persisted.json()) as Detail;
      expect(updated.permissions).toEqual([permission]);
      if (permission === "workspace:manage")
        expect(updated.workspace.name).toBe("Renamed by management-only user");
      else if (permission === "roles:manage")
        expect(
          updated.roles.find(
            (role) => role.name === "Live role without task access",
          )?.permissions,
        ).toEqual([]);
      else
        expect(
          updated.fields.find(
            (field) => field.name === "Live structure-only field",
          )?.type,
        ).toBe("number");
      expect(
        (
          await scopedPage.request.get(`${apiUrl}${workspacePath}/items`)
        ).status(),
      ).toBe(403);
      expect(
        taskRequests,
        "Dashboard and Settings must not request unreadable tasks",
      ).toEqual([]);
      await expect(scopedPage.getByRole("alert")).toHaveCount(0);
      console.log(
        `Management-only live browser acceptance passed: ${permission}; metadata 200, tasks/export 403, permitted settings mutation persisted.`,
      );
    } finally {
      await scopedContext.close();
    }
  }
  await runLiveWorkflows(browser, page, origin);
  expect(errors).toEqual([]);
  console.log(
    "Live API browser verification passed: setup, hierarchy, task persistence, kanban, settings, admin audit, identity link/list/unlink and credential revocation, two workspaces, member additions, rename persistence, delayed real metadata isolation, and three management-only browser accounts.",
  );
} finally {
  await cleanup();
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
}
