import { test, expect } from "@playwright/test";
import type { Detail } from "../src/lib/api";
import { fixture, wid, listId, user, detail, task } from "./fixture";

test("unauthenticated app redirects, setup requires the operator token", async ({
  page,
}) => {
  const { mutations, errors } = await fixture(page, {
    authenticated: false,
    setup: true,
  });
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Set up your home" }),
  ).toBeVisible();
  await page.getByLabel("Your name").fill("Test Owner");
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("test-only-password");
  await page
    .getByLabel("Operator setup token")
    .fill("test-only-operator-token");
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(
    page.getByRole("button", { name: task.title, exact: true }),
  ).toBeVisible();
  expect(mutations[0].body.setupToken).toBe("test-only-operator-token");
  expect(errors).toEqual([]);
});

test("all five views render real contract data and board keyboard controls persist status", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-09-06T12:00:00"));
  const { mutations, errors } = await fixture(page);
  await page.goto("/app");
  await expect(
    page.getByRole("button", { name: task.title, exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "List", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Board" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByLabel(`Move ${task.title} to status`).selectOption("done");
  await expect(page.getByLabel(`Move ${task.title} to status`)).toHaveValue(
    "done",
  );
  expect(
    mutations.some((m) => m.method === "PATCH" && m.body.status === "done"),
  ).toBe(true);
  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page.locator(".calendar-task")).toHaveText(task.title);
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(
    page.getByRole("heading", { name: "October 2026" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("tab", { name: "List", exact: true }).click();
  await expect(
    page.getByRole("columnheader", { name: "Effort" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Timeline" }).click();
  const bar = page.getByRole("button", {
    name: /Verify the release: 2026-09-03 to 2026-09-08/,
  });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveCSS("grid-column", "3 / span 6");
  await page.getByLabel("Search tasks").fill("not found");
  await expect(bar).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("task editor preserves typed custom fields, handles attachments and restores modal focus", async ({
  page,
}) => {
  const { mutations, errors } = await fixture(page);
  await page.goto("/app");
  const taskButton = page.getByRole("button", {
    name: task.title,
    exact: true,
  });
  await taskButton.click();
  const dialog = page.getByRole("dialog", { name: "Task details" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Effort", { exact: true }).fill("4.5");
  await dialog.getByLabel("Approved", { exact: true }).check();
  await page
    .getByRole("combobox", { name: "Category", exact: true })
    .selectOption("Two");
  await page.getByLabel("Attach a file").setInputFiles({
    name: "test.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(page.getByRole("link", { name: "test.txt" })).toBeVisible();
  const upload = mutations.find((m) => m.path.endsWith("/attachments"));
  expect(upload?.body).toEqual({
    name: "test.txt",
    contentType: "text/plain",
    data: "aGVsbG8=",
  });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    mutations.find((m) => m.method === "PATCH")?.body.customFields,
  ).toEqual({ effort: 4.5, approved: true, category: "Two" });
  await taskButton.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(taskButton).toBeFocused();
  expect(errors).toEqual([]);
});

test("agent proposals cannot create tasks before an explicit confirmation", async ({
  page,
}) => {
  const { mutations, errors } = await fixture(page);
  await page.goto("/app");
  await page.getByRole("button", { name: "Assistant", exact: false }).click();
  await page.getByLabel("Message the assistant").fill("Suggest a task");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Review suggestion" }).click();
  await expect(
    page.getByRole("dialog", { name: "Review suggested task" }),
  ).toBeVisible();
  expect(mutations.filter((m) => m.path.endsWith("/items"))).toHaveLength(0);
  await page.getByLabel("Title", { exact: true }).fill("Human-reviewed task");
  await page.getByLabel("Title", { exact: true }).press("Enter");
  expect(mutations.filter((m) => m.path.endsWith("/items"))).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm and create" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations.filter((m) => m.path.endsWith("/items"))).toHaveLength(1);
  expect(mutations.find((m) => m.path.endsWith("/items"))?.body.title).toBe(
    "Human-reviewed task",
  );
  expect(errors).toEqual([]);
});

test("task edits submit only changed fields with a version and retain the draft on conflict", async ({
  page,
}) => {
  const { errors } = await fixture(page);
  let submitted: Record<string, unknown> | undefined;
  await page.route(
    `**/api/v1/workspaces/${wid}/items/${task.id}`,
    async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      submitted = route.request().postDataJSON();
      await route.fulfill({
        status: 409,
        json: { error: "Task changed. Reload the task before saving." },
      });
    },
  );
  await page.goto("/app");
  await page.getByRole("button", { name: task.title, exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("My title change");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toContainText("Task changed");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "My title change",
  );
  expect(submitted).toEqual({
    title: "My title change",
    expectedUpdatedAt: task.updatedAt,
  });
  expect(errors).toEqual([]);
});

test("settings and separate admin use direct objects and remain usable on mobile", async ({
  page,
}) => {
  const { errors } = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(page.getByLabel("Display name")).toHaveValue(user.name);
  await expect(
    page.getByRole("heading", { name: "Roles & permissions" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Instance status" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: user.email, exact: true }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto("/app");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.getByLabel("WORKSPACE", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("comma and whitespace tags survive unrelated edits and chip changes are lossless", async ({
  page,
}) => {
  const tags = ["triage,urgent", "needs  review", "line\nbreak"];
  const { mutations, errors } = await fixture(page, {
    items: [{ ...task, tags }],
  });
  await page.goto("/app");
  await page.getByRole("button", { name: task.title, exact: true }).click();
  const chips = page
    .getByRole("list", { name: "Tags", exact: true })
    .locator("li > span");
  expect(await chips.allTextContents()).toEqual(tags);
  await page
    .getByLabel("Title", { exact: true })
    .fill("Only the title changed");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations.at(-1)?.body).toEqual({
    title: "Only the title changed",
    expectedUpdatedAt: task.updatedAt,
  });
  await page
    .getByRole("button", { name: "Only the title changed", exact: true })
    .click();
  expect(await chips.allTextContents()).toEqual(tags);
  await page.getByLabel("New tag", { exact: true }).fill("release, follow-up");
  await page.getByLabel("New tag", { exact: true }).press("Enter");
  expect(mutations.filter((m) => m.method === "PATCH")).toHaveLength(1);
  await page
    .getByRole("button", { name: "Remove tag triage,urgent", exact: true })
    .click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations.at(-1)?.body.tags).toEqual([
    "needs  review",
    "line\nbreak",
    "release, follow-up",
  ]);
  expect(errors).toEqual([]);
});

for (const view of ["Calendar", "Timeline"]) {
  test(`${view} retains a non-current month through task save and metadata refresh`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-09-06T12:00:00"));
    const { errors } = await fixture(page, {
      items: [{ ...task, startDate: "2026-10-03", dueDate: "2026-10-08" }],
    });
    await page.route(`**/api/v1/workspaces/${wid}/nodes/${listId}`, (route) =>
      route.fulfill({ json: { ...detail.nodes[1], name: "Renamed list" } }),
    );
    await page.goto("/app");
    await page.getByRole("tab", { name: view }).click();
    await page.getByRole("button", { name: "Next month" }).click();
    await expect(
      page.getByRole("heading", { name: "October 2026" }),
    ).toBeVisible();
    await page
      .locator(view === "Calendar" ? ".calendar-task" : ".gantt-bar")
      .click();
    await page.getByLabel("Title", { exact: true }).fill("October task edited");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "October 2026" }),
    ).toBeVisible();
    await expect(
      page.locator(view === "Calendar" ? ".calendar-task" : ".gantt-bar"),
    ).toHaveText("October task edited");
    await page.getByRole("button", { name: "Manage Test list" }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .fill("Renamed list");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "October 2026" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("all five custom field types display and edit without string coercion", async ({
  page,
}) => {
  const fields: Detail["fields"] = [
    ...detail.fields,
    { id: "note", name: "Reference", type: "text" },
    { id: "checkDate", name: "Check date", type: "date" },
  ];
  const customFields = {
    effort: 0,
    approved: false,
    category: "One",
    note: "Original reference",
    checkDate: "2026-09-05",
  };
  const { mutations, errors } = await fixture(page, {
    fields,
    items: [{ ...task, customFields }],
  });
  await page.goto("/app");
  await page.getByRole("tab", { name: "List", exact: true }).click();
  for (const field of fields)
    await expect(
      page.getByRole("columnheader", { name: new RegExp(`^${field.name} ↕$`) }),
    ).toBeVisible();
  const cells = page.locator("tbody tr").getByRole("cell");
  for (const value of ["0", "No", "One", "Original reference", "2026-09-05"])
    await expect(
      cells.filter({ hasText: new RegExp(`^${value}$`) }),
    ).toHaveCount(1);
  await page.getByRole("button", { name: task.title, exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Task details" });
  await editor.getByLabel("Effort", { exact: true }).fill("-2.75");
  await editor.getByLabel("Approved", { exact: true }).check();
  await page
    .getByRole("combobox", { name: "Category", exact: true })
    .selectOption("Two");
  await editor.getByLabel("Reference", { exact: true }).fill("Updated reference");
  await editor.getByLabel("Check date", { exact: true }).fill("2026-10-01");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations.at(-1)?.body.customFields).toEqual({
    effort: -2.75,
    approved: true,
    category: "Two",
    note: "Updated reference",
    checkDate: "2026-10-01",
  });
  for (const value of [
    "-2.75",
    "Yes",
    "Two",
    "Updated reference",
    "2026-10-01",
  ])
    await expect(
      cells.filter({ hasText: new RegExp(`^${value}$`) }),
    ).toHaveCount(1);
  expect(errors).toEqual([]);
});

for (const width of [320, 390]) {
  test(`all five views and tag editor fit ${width}px mobile with long task names and tags`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-09-06T12:00:00"));
    await page.setViewportSize({ width, height: 844 });
    const title = "LongTaskName".repeat(24);
    const tags = ["longtag".repeat(8), "triage,urgent"];
    const { errors } = await fixture(page, {
      items: [
        { ...task, title, tags },
        {
          ...task,
          id: "unscheduled",
          title: `${title} later`,
          tags,
          startDate: null,
          dueDate: null,
        },
      ],
    });
    await page.goto("/app");
    for (const view of ["List", "Board", "Calendar", "Gallery", "Timeline"]) {
      await page.getByRole("tab", { name: view, exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${view} must not widen the page`,
      ).toBe(true);
      const taskButton =
        view === "Calendar"
          ? page.locator(".calendar-task")
          : view === "Timeline"
            ? page.locator(".gantt-bar")
            : view === "Board"
              ? page.locator(".task-card").first()
              : page.getByRole("button", { name: title, exact: true });
      await taskButton.click();
      await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
        title,
      );
      expect(
        await page
          .getByRole("dialog")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      expect(
        await page
          .getByRole("list", { name: "Tags", exact: true })
          .locator("li > span")
          .allTextContents(),
      ).toEqual(tags);
      await page.getByRole("button", { name: "Close dialog" }).click();
    }
    expect(errors).toEqual([]);
  });
}
