import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { label, statuses, type Item } from "../src/lib/api";
import { detail, fixture, task, user, wid } from "./fixture";

function tasks(count = 235): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    ...task,
    id: `task-${index}`,
    title: `Task ${String(index + 1).padStart(3, "0")}`,
    description:
      index === count - 1 ? "Only the final task has this description" : "",
    tags: index === count - 1 ? ["last-only"] : [],
    startDate: index < 100 ? "2026-09-03" : "2026-10-03",
    dueDate: index < 100 ? "2026-09-08" : "2026-10-08",
  }));
}

for (const view of ["List", "Gallery", "Board"]) {
  test(`${view} renders 100 at a time, reaches every task, and retains the expanded limit after editing`, async ({
    page,
  }) => {
    const items = tasks();
    const { mutations, errors } = await fixture(page, { items });
    await page.goto("/app");
    await page.getByRole("tab", { name: view, exact: true }).click();
    const entries = page.locator(view === "Board" ? ".board-task" : view === "Gallery" ? ".gallery-grid .task-card" : "tbody tr");
    const more = page.getByRole("button", {
      name: view === "Board" ? "Show 100 more per column" : "Show more tasks",
      exact: true,
    });
    const summary = page.getByRole("status");
    await expect(entries).toHaveCount(100);
    await expect(summary).toContainText("Showing 100 of 235 tasks");
    await expect(page.locator(".workspace-footer")).toContainText(
      "235 tasks in this view",
    );
    await expect(
      page.getByRole("button", { name: "All tasks 235", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".workspace-heading")).toContainText(
      "0 complete · 235 in motion",
    );
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(entries).toHaveCount(200);
    await expect(summary).toContainText("Showing 200 of 235 tasks");
    await more.press("Space");
    await expect(entries).toHaveCount(235);
    await expect(summary).toContainText("Showing 235 of 235 tasks");
    await expect(more).toHaveCount(0);
    expect(mutations).toEqual([]);
    if (view === "Gallery") await entries.last().click();
    else await entries.last().getByRole("button").first().click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
      "Task 235",
    );
    await expect(
      page.getByRole("combobox", { name: "Assignee", exact: true }),
    ).toHaveValue(user.id);
    await page.getByLabel("Title", { exact: true }).fill("Edited final task");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(entries).toHaveCount(235);
    await expect(entries.last()).toContainText("Edited final task");
    await expect(
      page.getByRole("tab", { name: view, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    expect(mutations.at(-1)).toEqual({
      path: `/workspaces/${wid}/items/task-234`,
      method: "PATCH",
      body: { title: "Edited final task", expectedUpdatedAt: task.updatedAt },
    });
    expect(errors).toEqual([]);
  });

  test(`${view} searches all tasks including hidden descriptions and tags and edits a last-page result`, async ({
    page,
  }) => {
    const { mutations, errors } = await fixture(page, { items: tasks() });
    await page.goto("/app");
    await page.getByRole("tab", { name: view, exact: true }).click();
    const entries = page.locator(view === "Board" ? ".board-task" : view === "Gallery" ? ".gallery-grid .task-card" : "tbody tr");
    await expect(entries).toHaveCount(100);
    const search = page.getByRole("searchbox", { name: "Search tasks" });
    for (const query of ["Task 235", "final task has this", "last-only"]) {
      await search.fill(query);
      await expect(entries).toHaveCount(1);
      await expect(entries.first()).toContainText("Task 235");
      await expect(page.getByRole("status")).toContainText(
        "Showing 1 of 1 tasks",
      );
      await expect(page.locator(".workspace-footer")).toContainText(
        "1 task in this view",
      );
    }
    if (view === "Gallery") await entries.first().click();
    else await entries.first().getByRole("button").first().click();
    await page.getByLabel("Title", { exact: true }).fill("Updated hidden task");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText("Updated hidden task");
    await expect(search).toHaveValue("last-only");
    await search.fill("");
    await expect(entries).toHaveCount(100);
    await expect(page.getByRole("status")).toContainText(
      "Showing 100 of 235 tasks",
    );
    expect(mutations).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}

test("Board has one global control, full per-column counts, and accurate status moves without collapsing expanded columns", async ({
  page,
}) => {
  const items = tasks(625).map((item, index) => ({
    ...item,
    status: statuses[Math.floor(index / 125)],
  }));
  const { mutations, errors } = await fixture(page, { items });
  await page.goto("/app");
  await page.getByRole("tab", { name: "Board", exact: true }).click();
  await expect(page.locator(".board-task")).toHaveCount(500);
  for (const status of statuses) {
    const column = page.getByRole("region", {
      name: label(status),
      exact: true,
    });
    await expect(column.locator(".board-task")).toHaveCount(100);
    await expect(column.locator("h2 .count")).toHaveText("125");
    await expect(
      column.getByText("Showing 100 of 125 tasks", { exact: true }),
    ).toBeVisible();
  }
  const more = page.getByRole("button", {
    name: "Show 100 more per column",
    exact: true,
  });
  await expect(more).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText(
    "Showing 500 of 625 tasks across all columns.",
  );
  await page
    .getByLabel("Move Task 001 to status", { exact: true })
    .selectOption("done");
  const backlog = page.getByRole("region", { name: "Backlog", exact: true });
  const done = page.getByRole("region", { name: "Done", exact: true });
  await expect(backlog.locator("h2 .count")).toHaveText("124");
  await expect(done.locator("h2 .count")).toHaveText("126");
  await expect(page.locator(".workspace-heading")).toContainText(
    "126 complete · 499 in motion",
  );
  await expect(page.locator(".board-task")).toHaveCount(500);
  await more.click();
  await expect(page.locator(".board-task")).toHaveCount(625);
  await expect(more).toHaveCount(0);
  await page
    .getByLabel("Move Task 125 to status", { exact: true })
    .selectOption("done");
  await expect(backlog.locator("h2 .count")).toHaveText("123");
  await expect(done.locator("h2 .count")).toHaveText("127");
  await expect(done.locator(".board-task")).toHaveCount(127);
  await expect(page.getByRole("status")).toHaveText(
    "Showing 625 of 625 tasks across all columns.",
  );
  expect(mutations).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("search, status, hierarchy and view changes reset the limit without resetting dates or filters", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-09-06T12:00:00"));
  const { errors } = await fixture(page, { items: tasks() });
  await page.goto("/app");
  const rows = page.locator("tbody tr");
  const more = page.getByRole("button", {
    name: "Show more tasks",
    exact: true,
  });
  const search = page.getByRole("searchbox", { name: "Search tasks" });
  await more.click();
  await expect(rows).toHaveCount(200);
  await search.fill("Task");
  await expect(rows).toHaveCount(100);
  await more.click();
  await expect(rows).toHaveCount(200);
  await page
    .getByRole("combobox", { name: "Filter status" })
    .selectOption("todo");
  await expect(rows).toHaveCount(100);
  await more.click();
  await expect(rows).toHaveCount(200);
  await page.getByTitle("list: Test list", { exact: true }).click();
  await expect(rows).toHaveCount(100);
  await more.click();
  await expect(rows).toHaveCount(200);
  await page.getByRole("tab", { name: "Gallery", exact: true }).click();
  const galleryCards = page.locator(".gallery-grid .task-card");
  await expect(galleryCards).toHaveCount(100);
  await page.getByRole("button", { name: "Show more tasks", exact: true }).click();
  await expect(galleryCards).toHaveCount(200);
  await page.getByRole("tab", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(
    page.getByRole("heading", { name: "October 2026" }),
  ).toBeVisible();
  await expect(page.locator(".calendar-task")).toHaveCount(100);
  await page
    .getByRole("button", {
      name: "Show 100 more per day and per date list",
      exact: true,
    })
    .click();
  await expect(page.locator(".calendar-task")).toHaveCount(135);
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "October 2026" }),
  ).toBeVisible();
  await expect(page.locator(".gantt-bar")).toHaveCount(100);
  await page
    .getByRole("button", {
      name: "Show 100 more scheduled and 100 more outside/unscheduled",
      exact: true,
    })
    .click();
  await expect(page.locator(".gantt-bar")).toHaveCount(135);
  await expect(
    page.getByRole("button", {
      name: /Show more tasks|Show 100 more per column/,
    }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "List", exact: true }).click();
  await expect(rows).toHaveCount(100);
  await expect(search).toHaveValue("Task");
  await expect(
    page.getByRole("combobox", { name: "Filter status" }),
  ).toHaveValue("todo");
  await expect(
    page.getByRole("heading", { name: "Test list", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Calendar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "October 2026" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("hierarchy and status filters run before the row limit, with full member definitions", async ({
  page,
}) => {
  const items = tasks().map((item, index) =>
    index < 120
      ? item
      : {
          ...item,
          nodeId: "other-list",
          status: "done" as const,
          assigneeId: "other-member",
        },
  );
  const { errors } = await fixture(page, { items });
  await page.route(`**/api/v1/workspaces/${wid}`, (route) =>
    route.fulfill({
      json: {
        ...detail,
        nodes: [
          ...detail.nodes,
          {
            id: "other-list",
            name: "Other list",
            kind: "list",
            parentId: detail.nodes[0].id,
          },
        ],
        members: [
          ...detail.members,
          {
            userId: "other-member",
            name: "Other colleague",
            email: "other@example.test",
            roleId: detail.role.id,
            disabled: false,
          },
        ],
      },
    }),
  );
  await page.goto("/app");
  await page.getByTitle("list: Other list", { exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await expect(page.getByRole("status")).toHaveText("Showing 100 of 115 tasks");
  await expect(page.locator("tbody tr").first()).toContainText("Task 121");
  await expect(page.locator("tbody tr").first()).toContainText(
    "Other colleague",
  );
  await page
    .getByRole("button", { name: "Show more tasks", exact: true })
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(115);
  await page
    .getByRole("button", { name: "All tasks 235", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Filter status" })
    .selectOption("done");
  await expect(page.getByRole("status")).toHaveText("Showing 100 of 115 tasks");
  await expect(page.locator("tbody tr").first()).toContainText("Task 121");
  await expect(page.locator(".workspace-heading")).toContainText(
    "115 complete · 120 in motion",
  );
  expect(errors).toEqual([]);
});

test("workspace switching resets the display limit and ignores a late old-workspace refresh", async ({
  page,
}) => {
  const { errors } = await fixture(page, { items: tasks() });
  const secondId = "other-workspace";
  const second = {
    ...detail,
    workspace: { id: secondId, name: "Other workspace" },
    nodes: [
      {
        id: "second-project",
        name: "Other project",
        kind: "project",
        parentId: null,
      },
      {
        id: "second-list",
        name: "Other workspace list",
        kind: "list",
        parentId: "second-project",
      },
    ],
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
        items: tasks(150).map((item) => ({
          ...item,
          workspaceId: secondId,
          nodeId: "second-list",
          title: `Other ${item.title}`,
        })),
        nextCursor: null,
      },
    }),
  );
  await page.goto("/app");
  await page
    .getByRole("button", { name: "Show more tasks", exact: true })
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(200);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**/api/v1/workspaces/${wid}`, async (route) => {
    started();
    await gate;
    await route.fulfill({ json: detail });
  });
  try {
    await page.getByRole("button", { name: "Task 150", exact: true }).click();
    await page
      .getByLabel("Title", { exact: true })
      .fill("Old workspace edited");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await requested;
    await page
      .getByRole("combobox", { name: "WORKSPACE", exact: true })
      .selectOption(secondId);
    await expect(page.locator("tbody tr")).toHaveCount(100);
    await expect(page.getByRole("status")).toHaveText(
      "Showing 100 of 150 tasks",
    );
    release();
    await expect(page.locator("tbody tr").first()).toContainText(
      "Other Task 001",
    );
    await expect(
      page.getByRole("button", { name: "Old workspace edited", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Show more tasks", exact: true })
      .click();
    await expect(page.locator("tbody tr")).toHaveCount(150);
    await page
      .getByRole("combobox", { name: "WORKSPACE", exact: true })
      .selectOption(wid);
    await expect(page.locator("tbody tr")).toHaveCount(100);
    await expect(page.getByRole("status")).toHaveText(
      "Showing 100 of 235 tasks",
    );
    await expect(
      page.getByRole("button", { name: "Other Task 001", exact: true }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});

for (const view of ["List", "Gallery", "Board"]) {
  test(`${view} progressive controls are keyboard accessible and fit mobile without axe violations`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    const { errors } = await fixture(page, { items: tasks(125) });
    await page.goto("/app");
    await page.getByRole("tab", { name: view, exact: true }).click();
    const more = page.getByRole("button", {
      name: view === "Board" ? "Show 100 more per column" : "Show more tasks",
      exact: true,
    });
    await more.focus();
    await expect(more).toBeFocused();
    await expect(more).toBeInViewport();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
      .analyze();
    expect(results.violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await more.press("Enter");
    await expect(page.getByRole("status")).toContainText(
      "Showing 125 of 125 tasks",
    );
    expect(errors).toEqual([]);
  });
}
