import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { detail, fixture, task, wid } from "./fixture";

const pageRoute = `**/api/v1/workspaces/${wid}/items/page?*`;
const items = Array.from({ length: 401 }, (_, index) => ({
  ...task,
  id: `paged-${index}`,
  title: `Paged task ${index + 1}`,
  tags: index === 400 ? ["late-page-tag"] : [],
  status: index === 400 ? ("done" as const) : ("todo" as const),
  customFields: { effort: index, approved: index === 400, category: "Two" },
  startDate: index === 400 ? "2026-10-03" : "2026-09-03",
  dueDate: index === 400 ? "2026-10-08" : "2026-09-08",
}));

test("all pages supply totals, descendant search, late tags/custom fields and month-preserving edits", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-09-06T12:00:00"));
  const { mutations, errors } = await fixture(page, { items });
  const reads: URL[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      /\/items(?:\/page)?$/.test(new URL(request.url()).pathname)
    )
      reads.push(new URL(request.url()));
  });
  await page.goto("/app");
  await expect(page.locator(".workspace-footer")).toContainText(
    "401 tasks in this view",
  );
  expect(reads.map((url) => url.search)).toEqual([
    "?limit=200",
    "?limit=200&cursor=200",
    "?limit=200&cursor=400",
  ]);
  expect(reads.every((url) => url.pathname.endsWith("/items/page"))).toBe(true);
  await expect(page.getByRole("status")).toHaveText("Showing 100 of 401 tasks");
  await expect(page.locator(".workspace-heading")).toContainText(
    "1 complete · 400 in motion",
  );
  await expect(
    page.getByRole("button", { name: "All tasks 401", exact: true }),
  ).toBeVisible();
  await page.getByTitle("project: Test project", { exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search tasks" });
  await search.fill("late-page-tag");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("Paged task 401");
  await page.getByRole("tab", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: "Next month" }).click();
  await page.locator(".calendar-task").click();
  await expect(page.getByLabel("Effort", { exact: true })).toHaveValue("400");
  await expect(page.getByLabel("Approved", { exact: true })).toBeChecked();
  await expect(
    page.getByRole("combobox", { name: "Category", exact: true }),
  ).toHaveValue("Two");
  await page.getByLabel("Effort", { exact: true }).fill("999");
  await page.getByLabel("Title", { exact: true }).fill("Edited late-page task");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".calendar-task")).toContainText(
    "Edited late-page task",
  );
  await expect(
    page.getByRole("heading", { name: "October 2026" }),
  ).toBeVisible();
  expect(reads.map((url) => url.search)).toEqual([
    "?limit=200",
    "?limit=200&cursor=200",
    "?limit=200&cursor=400",
    "?limit=200",
    "?limit=200&cursor=200",
    "?limit=200&cursor=400",
  ]);
  expect(mutations.at(-1)).toEqual({
    path: `/workspaces/${wid}/items/paged-400`,
    method: "PATCH",
    body: {
      title: "Edited late-page task",
      expectedUpdatedAt: task.updatedAt,
      customFields: { effort: 999, approved: true, category: "Two" },
    },
  });
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  await page.locator(".gantt-bar").click();
  await expect(page.getByLabel("Effort", { exact: true })).toHaveValue("999");
  expect(errors).toEqual([]);
});

test("page two failure hides partial data and retry restarts from page one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const { errors } = await fixture(page, { items });
  const gate = Promise.withResolvers<void>();
  let fail = true;
  const cursors: (string | null)[] = [];
  await page.route(pageRoute, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    cursors.push(cursor);
    if (fail && cursor) {
      await gate.promise;
      return route.fulfill({
        status: 503,
        json: { error: "Task page temporarily unavailable" },
      });
    }
    return route.fallback();
  });
  try {
    await page.goto("/app");
    await expect(page.getByRole("status")).toHaveText(
      "Loading workspace tasks... 200 loaded. Waiting for all pages.",
    );
    expect(cursors).toEqual([null, "200"]);
    await expect(page.getByRole("tabpanel")).toHaveCount(0);
    await expect(page.locator(".workspace-footer")).toHaveCount(0);
    await expect(
      page.getByText(/complete ·|Your next step starts here/),
    ).toHaveCount(0);
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
      .analyze();
    expect(axe.violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    gate.resolve();
    await expect(page.getByRole("alert")).toHaveText(
      "Task page temporarily unavailable",
    );
    await expect(page.getByRole("tabpanel")).toHaveCount(0);
    await expect(
      page.getByText(
        /Your next step starts here|0 tasks in this view|0 complete/,
      ),
    ).toHaveCount(0);
    fail = false;
    await page.getByRole("button", { name: "Retry loading" }).click();
    await expect(page.locator(".workspace-footer")).toContainText(
      "401 tasks in this view",
    );
    expect(cursors).toEqual([null, "200", null, "200", "400"]);
    expect(errors).toEqual([]);
  } finally {
    gate.resolve();
  }
});

test("a failed paginated refresh does not present the old dataset as current", async ({
  page,
}) => {
  await fixture(page, { items });
  await page.goto("/app");
  await page.getByRole("button", { name: "Paged task 1", exact: true }).click();
  await page.route(pageRoute, (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor"))
      return route.fulfill({
        status: 403,
        json: { error: "Task read access revoked" },
      });
    return route.fallback();
  });
  await page.getByLabel("Title", { exact: true }).fill("Changed task");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Task read access revoked");
  await expect(page.getByRole("tabpanel")).toHaveCount(0);
  await expect(page.locator(".workspace-footer")).toHaveCount(0);
  await expect(
    page.getByText(/complete ·|Your next step starts here/),
  ).toHaveCount(0);
});

for (const cycle of [
  ["a", "a"],
  ["a", "b", "a"],
]) {
  test(`cursor loop ${cycle.join(" -> ")} fails clearly without requesting a repeated page`, async ({
    page,
  }) => {
    await fixture(page);
    let requests = 0;
    await page.route(pageRoute, (route) =>
      route.fulfill({
        json: {
          items: [{ ...task, id: `loop-${requests}` }],
          nextCursor: cycle[requests++] ?? null,
        },
      }),
    );
    await page.goto("/app");
    await expect(page.getByRole("alert")).toContainText(
      "pagination cursor repeated",
    );
    expect(requests).toBe(cycle.length);
    await expect(page.getByRole("tabpanel")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Retry loading" }),
    ).toBeVisible();
  });
}

const invalidPages = [
  {
    name: "missing envelope",
    value: [task],
    error: "Invalid task page response",
  },
  {
    name: "non-array items",
    value: { items: {}, nextCursor: null },
    error: "Invalid task page response",
  },
  {
    name: "missing cursor",
    value: { items: [] },
    error: "Invalid task page response",
  },
  {
    name: "numeric cursor",
    value: { items: [], nextCursor: 200 },
    error: "Invalid task page response",
  },
  {
    name: "empty cursor",
    value: { items: [], nextCursor: "" },
    error: "Invalid task page response",
  },
  {
    name: "invalid row",
    value: { items: [null], nextCursor: null },
    error: "Invalid task in page response",
  },
  {
    name: "missing ID",
    value: { items: [{ ...task, id: undefined }], nextCursor: null },
    error: "Invalid task in page response",
  },
  {
    name: "foreign workspace",
    value: { items: [{ ...task, workspaceId: "foreign" }], nextCursor: null },
    error: "unexpected workspace",
  },
  {
    name: "missing workspace",
    value: { items: [{ ...task, workspaceId: undefined }], nextCursor: null },
    error: "unexpected workspace",
  },
  {
    name: "duplicate ID within page",
    value: { items: [task, task], nextCursor: null },
    error: "duplicate task ID",
  },
];
for (const invalid of invalidPages) {
  test(`rejects ${invalid.name} without claiming an empty or complete dataset`, async ({
    page,
  }) => {
    const { errors } = await fixture(page);
    await page.route(pageRoute, (route) =>
      route.fulfill({ json: invalid.value }),
    );
    await page.goto("/app");
    await expect(page.getByRole("alert")).toContainText(invalid.error);
    await expect(page.getByRole("tabpanel")).toHaveCount(0);
    await expect(
      page.getByText(
        /Your next step starts here|0 tasks in this view|0 complete/,
      ),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("duplicate IDs across pages fail rather than deduplicating or counting false totals", async ({
  page,
}) => {
  await fixture(page);
  await page.route(pageRoute, (route) =>
    route.fulfill({
      json: {
        items: [task],
        nextCursor: new URL(route.request().url()).searchParams.has("cursor")
          ? null
          : "next",
      },
    }),
  );
  await page.goto("/app");
  await expect(page.getByRole("alert")).toContainText("duplicate task ID");
  await expect(page.getByRole("tabpanel")).toHaveCount(0);
});

test("an empty intermediate page continues using the exact opaque cursor until null", async ({
  page,
}) => {
  await fixture(page);
  const opaque = "opaque + /?&=cursor";
  const cursors: (string | null)[] = [];
  await page.route(pageRoute, (route) => {
    const query = new URL(route.request().url()).searchParams;
    cursors.push(query.get("cursor"));
    expect([...query.keys()].sort()).toEqual(
      cursors.length === 1 ? ["limit"] : ["cursor", "limit"],
    );
    return route.fulfill({
      json:
        cursors.length === 1
          ? { items: [], nextCursor: opaque }
          : { items: [task], nextCursor: null },
    });
  });
  await page.goto("/app");
  await expect(
    page.getByRole("button", { name: task.title, exact: true }),
  ).toBeVisible();
  expect(cursors).toEqual([null, opaque]);
});

for (const lateStatus of [200, 503]) {
  test(`switching workspace aborts page two and ignores its late ${lateStatus} response`, async ({
    page,
  }) => {
    const { errors } = await fixture(page, { items });
    const secondId = "second-workspace";
    const second = {
      ...detail,
      workspace: { id: secondId, name: "Second workspace" },
    };
    await page.route("**/api/v1/workspaces", (route) =>
      route.fulfill({ json: [detail.workspace, second.workspace] }),
    );
    await page.route(`**/api/v1/workspaces/${secondId}`, (route) =>
      route.fulfill({ json: second }),
    );
    await page.route(`**/api/v1/workspaces/${secondId}/items/page?*`, (route) =>
      route.fulfill({
        json: {
          items: [
            { ...task, workspaceId: secondId, title: "Second workspace task" },
          ],
          nextCursor: null,
        },
      }),
    );
    const gate = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const requests: string[] = [];
    // Observe the real AbortSignal, including engines whose routed requests do not emit requestfailed.
    await page.addInitScript(() => {
      const fetch = window.fetch;
      window.fetch = (input, init) => {
        if (
          String(input).includes("/items/page?") &&
          String(input).includes("cursor=")
        )
          init?.signal?.addEventListener(
            "abort",
            () => (document.documentElement.dataset.pageAborted = "true"),
          );
        return fetch(input, init);
      };
    });
    await page.route(pageRoute, async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      requests.push(cursor || "first");
      if (!cursor) return route.fallback();
      await gate.promise;
      try {
        await route.fulfill({
          status: lateStatus,
          json:
            lateStatus === 200
              ? { items: items.slice(200, 400), nextCursor: "400" }
              : { error: "Old workspace failure" },
        });
      } finally {
        finished.resolve();
      }
    });
    try {
      await page.goto("/app");
      await expect(page.getByRole("status")).toContainText("200 loaded");
      await page
        .getByRole("combobox", { name: "WORKSPACE", exact: true })
        .selectOption(secondId);
      await expect(
        page.getByRole("button", {
          name: "Second workspace task",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute(
        "data-page-aborted",
        "true",
      );
      gate.resolve();
      await finished.promise;
      await expect(page.locator(".workspace-footer")).toContainText(
        "1 task in this view",
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Paged task 1", exact: true }),
      ).toHaveCount(0);
      expect(requests).toEqual(["first", "200"]);
      expect(errors).toEqual([]);
    } finally {
      gate.resolve();
    }
  });
}

test("workspace export offers a native same-origin download without a false success claim", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/settings");
  const link = page.getByRole("link", { name: "Download workspace JSON" });
  await expect(link).toHaveAttribute(
    "href",
    `/api/v1/workspaces/${wid}/export`,
  );
  await expect(link).toHaveAttribute("download", `hopya-${wid}.json`);
  await link.focus();
  await expect(link).toBeFocused();
  await expect(
    page.getByText("Workspace export downloaded.", { exact: false }),
  ).toHaveCount(0);
});
