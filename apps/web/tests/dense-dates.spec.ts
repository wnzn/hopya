import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import type { Item } from "../src/lib/api";
import { detail, fixture, task, wid } from "./fixture";

const moreNames = {
  Calendar: "Show 100 more per day and per date list",
  Timeline: "Show 100 more scheduled and 100 more outside/unscheduled",
};

function denseTasks(): Item[] {
  return [
    {
      name: "Outside",
      count: 125,
      startDate: "2040-12-03",
      dueDate: "2040-12-08",
    },
    { name: "Undated", count: 125, startDate: null, dueDate: null },
    { name: "Spillover", count: 125, startDate: null, dueDate: "2026-10-01" },
    {
      name: "Spanning",
      count: 125,
      startDate: "2026-08-30",
      dueDate: "2026-10-15",
    },
    {
      name: "Same day",
      count: 235,
      startDate: "2026-09-03",
      dueDate: "2026-09-08",
    },
    { name: "Start only", count: 125, startDate: "2026-09-09", dueDate: null },
  ].flatMap(({ name, count, startDate, dueDate }) =>
    Array.from({ length: count }, (_, index) => ({
      ...task,
      id: `${name.toLowerCase().replaceAll(" ", "-")}-${index}`,
      title: `${name} ${index + 1}`,
      description: index === count - 1 ? `${name} final description` : "",
      tags: index === count - 1 ? [`${name}-last-tag`] : [],
      status: name === "Undated" ? ("done" as const) : ("todo" as const),
      startDate,
      dueDate,
    })),
  );
}

async function fullDataTotals(page: Page, filtered = 860) {
  await expect(page.locator(".workspace-footer")).toContainText(
    `${filtered} ${filtered === 1 ? "task" : "tasks"} in this view`,
  );
  await expect(
    page.getByRole("button", { name: "All tasks 860", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".workspace-heading")).toContainText(
    "125 complete · 735 in motion",
  );
}

for (const view of ["Calendar", "Timeline"] as const) {
  test(`${view} bounds dense date sections after range filtering and preserves expanded late-page edits`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-09-06T12:00:00"));
    const { errors, mutations } = await fixture(page, { items: denseTasks() });
    const cursors: (string | null)[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/items/page"))
        cursors.push(url.searchParams.get("cursor"));
    });
    await page.goto("/app");
    await page.getByRole("tab", { name: view, exact: true }).click();
    expect(cursors).toEqual([null, "200", "400", "600", "800"]);
    const entries = page.locator(
      view === "Calendar" ? ".calendar-task" : ".gantt-bar",
    );
    const more = page.getByRole("button", {
      name: moreNames[view],
      exact: true,
    });
    const summary = page.getByRole("status");
    await expect(more).toHaveCount(1);
    await expect(entries).toHaveCount(view === "Calendar" ? 300 : 100);
    await expect(summary).toContainText(
      `Showing ${view === "Calendar" ? 500 : 200} of 860 tasks across all date sections.`,
    );
    await fullDataTotals(page);
    if (view === "Calendar") {
      await expect(summary).toContainText(
        "360 in selected month; showing 300 of 485 in the 42-day grid.",
      );
      await expect(page.locator(".calendar-day")).toHaveCount(42);
      await expect(
        page.getByLabel("2026-09-08: showing 100 of 235 tasks", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByLabel("2026-10-01: showing 100 of 125 tasks", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.locator(
          ".calendar-day:has(time[datetime='2026-09-09']) .calendar-task",
        ),
      ).toHaveCount(100);
      await expect(
        page
          .getByRole("region", {
            name: "Outside this calendar grid 250",
            exact: true,
          })
          .getByRole("button"),
      ).toHaveCount(100);
      await expect(
        page
          .getByRole("region", { name: "Without a date 125", exact: true })
          .getByRole("button"),
      ).toHaveCount(100);
    } else {
      await expect(summary).toContainText(
        "Showing 100 of 485 scheduled in selected month.",
      );
      await expect(entries.first()).toHaveAttribute(
        "aria-label",
        "Spanning 1: 2026-08-30 to 2026-10-15, Todo",
      );
      await expect(entries.first()).toHaveCSS("grid-column-start", "1");
      await expect(entries.first()).toHaveCSS("grid-column-end", "span 30");
      await expect(
        page
          .getByRole("region", {
            name: "Outside this month or unscheduled 375",
            exact: true,
          })
          .getByRole("button"),
      ).toHaveCount(100);
    }
    await more.focus();
    await more.press("Enter");
    await expect(entries).toHaveCount(view === "Calendar" ? 450 : 200);
    await expect(summary).toContainText(
      `Showing ${view === "Calendar" ? 775 : 400} of 860 tasks`,
    );
    await more.press("Space");
    await expect(entries).toHaveCount(view === "Calendar" ? 485 : 300);
    if (view === "Timeline") {
      await expect(summary).toContainText("Showing 600 of 860 tasks");
      await more.click();
      await expect(summary).toContainText("Showing 775 of 860 tasks");
      await more.click();
    }
    await expect(summary).toContainText("Showing 860 of 860 tasks");
    await expect(entries).toHaveCount(485);
    await expect(more).toHaveCount(0);
    expect(mutations).toEqual([]);
    const lastScheduled = entries.filter({ hasText: "Start only 125" });
    await lastScheduled.click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
      "Start only 125",
    );
    await expect(page.getByLabel("Start date", { exact: true })).toHaveValue(
      "2026-09-09",
    );
    await page
      .getByLabel("Title", { exact: true })
      .fill("Edited last scheduled task");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(entries).toHaveCount(485);
    await expect(
      entries.filter({ hasText: "Edited last scheduled task" }),
    ).toHaveCount(1);
    await expect(summary).toContainText("Showing 860 of 860 tasks");
    await expect(
      page.getByRole("heading", { name: "September 2026" }),
    ).toBeVisible();
    await fullDataTotals(page);
    expect(cursors).toEqual([
      null,
      "200",
      "400",
      "600",
      "800",
      null,
      "200",
      "400",
      "600",
      "800",
    ]);
    expect(mutations).toEqual([
      {
        path: `/workspaces/${wid}/items/start-only-124`,
        method: "PATCH",
        body: {
          title: "Edited last scheduled task",
          expectedUpdatedAt: task.updatedAt,
        },
      },
    ]);
    expect(errors).toEqual([]);
  });

  test(`${view} full search reaches outside-grid, undated and final-page tasks without changing or truncating their dates`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-09-06T12:00:00"));
    const { errors, mutations } = await fixture(page, { items: denseTasks() });
    await page.goto("/app");
    await page.getByRole("tab", { name: view, exact: true }).click();
    const search = page.getByRole("searchbox", { name: "Search tasks" });
    for (const name of [
      "Outside",
      "Undated",
      "Spillover",
      "Spanning",
      "Same day",
      "Start only",
    ]) {
      for (const query of [
        `${name} ${name === "Same day" ? 235 : 125}`,
        `${name} final description`,
        `${name}-last-tag`,
      ]) {
        await search.fill(query);
        await fullDataTotals(page, 1);
        await expect(page.getByRole("status")).toContainText(
          "Showing 1 of 1 tasks",
        );
        await expect(
          page.getByRole("button", { name: moreNames[view], exact: true }),
        ).toHaveCount(0);
      }
      const opener = page.locator(
        ".calendar-task, .gantt-bar, .unscheduled > button",
      );
      await expect(opener).toHaveCount(1);
      await opener.click();
      const original = denseTasks().find(
        (item) => item.title === `${name} ${name === "Same day" ? 235 : 125}`,
      )!;
      await expect(page.getByLabel("Start date", { exact: true })).toHaveValue(
        original.startDate || "",
      );
      await expect(page.getByLabel("Due date", { exact: true })).toHaveValue(
        original.dueDate || "",
      );
      await page
        .getByLabel("Title", { exact: true })
        .fill(`Edited ${original.title}`);
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(opener).toContainText(`Edited ${original.title}`);
      await expect(
        page.getByRole("heading", { name: "September 2026" }),
      ).toBeVisible();
      await fullDataTotals(page, 1);
    }
    await search.fill("");
    await fullDataTotals(page);
    await expect(page.getByRole("status")).toContainText(
      `Showing ${view === "Calendar" ? 500 : 200} of 860 tasks`,
    );
    expect(mutations).toHaveLength(6);
    expect(
      mutations.every(
        ({ body }) =>
          Object.keys(body).sort().join() === "expectedUpdatedAt,title",
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });

  test(`${view} resets date bounds on month, year, search, status, hierarchy, view and workspace but not same-month jumps or refresh`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-09-06T12:00:00"));
    const { errors } = await fixture(page, { items: denseTasks() });
    const secondId = "second-dates-workspace";
    await page.route("**/api/v1/workspaces", (route) =>
      route.fulfill({
        json: [detail.workspace, { id: secondId, name: "Second dates" }],
      }),
    );
    await page.route(`**/api/v1/workspaces/${secondId}`, (route) =>
      route.fulfill({
        json: { ...detail, workspace: { id: secondId, name: "Second dates" } },
      }),
    );
    await page.route(
      `**/api/v1/workspaces/${secondId}/items/page?*`,
      (route) => {
        const offset = Number(
          new URL(route.request().url()).searchParams.get("cursor") || 0,
        );
        return route.fulfill({
          json: {
            items: denseTasks()
              .slice(offset, offset + 200)
              .map((item) => ({ ...item, workspaceId: secondId })),
            nextCursor: offset + 200 < 860 ? String(offset + 200) : null,
          },
        });
      },
    );
    await page.goto("/app");
    await page.getByRole("tab", { name: view, exact: true }).click();
    const more = page.getByRole("button", {
      name: moreNames[view],
      exact: true,
    });
    const entries = page.locator(
      view === "Calendar" ? ".calendar-task" : ".gantt-bar",
    );
    const chooser = page.getByLabel("Jump to month (YYYY-MM)", { exact: true });
    await more.click();
    await page
      .getByRole("button", { name: "Go to month", exact: true })
      .click();
    await expect(entries).toHaveCount(view === "Calendar" ? 450 : 200);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(entries).toHaveCount(view === "Calendar" ? 450 : 200);
    for (const value of ["2026-10", "2027-10", "2040-12"]) {
      await chooser.fill(value);
      await page
        .getByRole("button", { name: "Go to month", exact: true })
        .click();
      await expect(chooser).toHaveValue(value);
      await expect(entries).toHaveCount(
        value === "2026-10" && view === "Calendar"
          ? 200
          : value === "2027-10"
            ? 0
            : 100,
      );
      await more.click();
    }
    await entries.last().click();
    await page.getByLabel("Title", { exact: true }).fill("Far future edit");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(chooser).toHaveValue("2040-12");
    await expect(entries).toHaveCount(125);
    await expect(entries.last()).toContainText("Far future edit");
    await chooser.fill("2026-09");
    await page
      .getByRole("button", { name: "Go to month", exact: true })
      .click();
    const initial = view === "Calendar" ? 300 : 100;
    await expect(entries).toHaveCount(initial);
    for (const change of [
      "search",
      "status",
      "node",
      "view",
      "workspace",
    ] as const) {
      await more.click();
      await expect(entries).toHaveCount(view === "Calendar" ? 450 : 200);
      if (change === "search")
        await page.getByRole("searchbox", { name: "Search tasks" }).fill(" ");
      if (change === "status")
        await page
          .getByRole("combobox", { name: "Filter status" })
          .selectOption("todo");
      if (change === "node")
        await page.getByTitle("list: Test list", { exact: true }).click();
      if (change === "view") {
        await page.getByRole("tab", { name: "List", exact: true }).click();
        await page.getByRole("tab", { name: view, exact: true }).click();
      }
      if (change === "workspace")
        await page
          .getByRole("combobox", { name: "WORKSPACE", exact: true })
          .selectOption(secondId);
      await expect(entries).toHaveCount(initial);
      await expect(chooser).toHaveValue("2026-09");
    }
    expect(errors).toEqual([]);
  });

  for (const width of [320, 390]) {
    test(`${view} dense date controls at ${width}px pass axe and keyboard traversal`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.clock.setFixedTime(new Date("2026-09-06T12:00:00"));
      const { errors } = await fixture(page, { items: denseTasks() });
      await page.goto("/app");
      await page.getByRole("tab", { name: view, exact: true }).click();
      const previous = page.getByRole("button", {
        name: "Previous month",
        exact: true,
      });
      const next = page.getByRole("button", {
        name: "Next month",
        exact: true,
      });
      await previous.focus();
      await previous.press("Enter");
      await expect(
        page.getByLabel("Jump to month (YYYY-MM)", { exact: true }),
      ).toHaveValue("2026-08");
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "Today", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(next).toBeFocused();
      await next.press("Space");
      await expect(
        page.getByLabel("Jump to month (YYYY-MM)", { exact: true }),
      ).toHaveValue("2026-09");
      await page.keyboard.press("Tab");
      await expect(
        page.getByLabel("Jump to month (YYYY-MM)", { exact: true }),
      ).toBeFocused();
      const go = page.getByRole("button", { name: "Go to month", exact: true });
      // Native month inputs may expose several editable segments to Tab.
      for (
        let index = 0;
        index < 8 &&
        !(await go.evaluate((element) => element === document.activeElement));
        index++
      )
        await page.keyboard.press("Tab");
      await expect(go).toBeFocused();
      await page.keyboard.press("Tab");
      const more = page.getByRole("button", {
        name: moreNames[view],
        exact: true,
      });
      await expect(more).toBeFocused();
      await expect(more).toBeInViewport();
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
        .analyze();
      await testInfo.attach("dense-dates-axe", {
        body: JSON.stringify(axe),
        contentType: "application/json",
      });
      expect(axe.violations).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await more.press("Enter");
      await expect(page.getByRole("status")).toContainText(
        `Showing ${view === "Calendar" ? 775 : 400} of 860 tasks`,
      );
      expect(errors).toEqual([]);
    });
  }
}

test("month chooser validates text fallback, supports early years and never changes task dates", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-09-06T12:00:00"));
  const { errors, mutations } = await fixture(page, {
    items: [
      { ...task, startDate: "0099-12-31", dueDate: "0100-01-02" },
      {
        ...task,
        id: "year-zero",
        title: "Year zero leap day",
        startDate: null,
        dueDate: "0000-02-29",
      },
    ],
  });
  await page.goto("/app");
  await page.getByRole("tab", { name: "Calendar", exact: true }).click();
  const chooser = page.getByLabel("Jump to month (YYYY-MM)", { exact: true });
  for (const invalid of ["", "2026-13", "0099-1", "10000-01", "2026-09-08"]) {
    await chooser.evaluate((element) => {
      (element as HTMLInputElement).type = "text";
    });
    await chooser.fill(invalid);
    await page
      .getByRole("button", { name: "Go to month", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "September 2026" }),
    ).toBeVisible();
    expect(
      await chooser.evaluate((element) =>
        (element as HTMLInputElement).checkValidity(),
      ),
    ).toBe(false);
  }
  await chooser.fill("0099-12");
  await page.getByRole("button", { name: "Go to month", exact: true }).click();
  await expect(page.locator(".calendar-task")).toHaveText(task.title);
  await page.getByRole("button", { name: "Next month", exact: true }).click();
  await expect(chooser).toHaveValue("0100-01");
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  await expect(page.locator(".gantt-bar")).toHaveCSS("grid-column-start", "1");
  await expect(page.locator(".gantt-bar")).toHaveCSS(
    "grid-column-end",
    "span 2",
  );
  await page.locator(".gantt-bar").click();
  await expect(page.getByLabel("Start date", { exact: true })).toHaveValue(
    "0099-12-31",
  );
  await expect(page.getByLabel("Due date", { exact: true })).toHaveValue(
    "0100-01-02",
  );
  await page.keyboard.press("Escape");
  await chooser.fill("0001-01");
  await page.getByRole("button", { name: "Go to month", exact: true }).click();
  await page
    .getByRole("button", { name: "Previous month", exact: true })
    .click();
  await expect(chooser).toHaveAttribute("type", "text");
  await chooser.fill("0000-02");
  await page.getByRole("button", { name: "Go to month", exact: true }).click();
  await expect(page.locator(".gantt-bar")).toHaveCSS("grid-column-start", "29");
  await expect(page.locator(".gantt-bar")).toHaveCSS(
    "grid-column-end",
    "span 1",
  );
  await chooser.fill("0000-01");
  await page.getByRole("button", { name: "Go to month", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Previous month", exact: true }),
  ).toBeDisabled();
  await chooser.fill("9999-12");
  await page.getByRole("button", { name: "Go to month", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Next month", exact: true }),
  ).toBeDisabled();
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});
