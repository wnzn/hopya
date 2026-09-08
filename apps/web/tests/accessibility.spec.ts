import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { priorities, statuses, type Detail } from "../src/lib/api";
import { detail, fixture, task, user } from "./fixture";

const fields: Detail["fields"] = [
  ...detail.fields,
  { id: "reference", name: "Reference", type: "text" },
  { id: "checkDate", name: "Check date", type: "date" },
];

async function scan(page: Page, state: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  const report = test.info().outputPath(`${state}-axe.json`);
  await writeFile(report, JSON.stringify(results, null, 2));
  await test
    .info()
    .attach(`${state}-axe`, { path: report, contentType: "application/json" });
  if (["Board", "login", "task-dialog"].includes(state)) {
    const screenshot = test.info().outputPath(`${state}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await test
      .info()
      .attach(state, { path: screenshot, contentType: "image/png" });
  }
  expect
    .soft(
      results.violations.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map(({ target, failureSummary }) => ({
          target,
          failureSummary,
        })),
      })),
      `${state}: axe violations`,
    )
    .toEqual([]);
  expect
    .soft(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${state}: no page-level horizontal overflow`,
    )
    .toBe(true);
}

for (const width of [1280, 320, 390]) {
  test.describe(`${width}px accessibility`, () => {
    test.use({ viewport: { width, height: 900 } });
    test.beforeEach(async ({ page }) => {
      await page.clock.setFixedTime(new Date("2026-09-06T12:00:00"));
    });

    for (const state of ["landing", "login", "register", "setup"]) {
      test(`${state} WCAG`, async ({ page }) => {
        const { errors } = await fixture(page, {
          authenticated: false,
          setup: state === "setup",
        });
        await page.goto(state === "landing" ? "/" : "/login");
        if (state !== "landing")
          await expect(
            page.getByLabel("Password", { exact: true }),
          ).toBeVisible();
        if (state === "register")
          await page.getByRole("button", { name: "Create an account" }).click();
        await scan(page, state);
        if (state !== "landing") {
          await page.route("**/api/v1/auth/*", (route) =>
            route.fulfill({
              status: 400,
              json: { error: "Unable to sign in with these details." },
            }),
          );
          if (state !== "login")
            await page.getByLabel("Your name").fill("Test Owner");
          await page.getByLabel("Email", { exact: true }).fill(user.email);
          await page
            .getByLabel("Password", { exact: true })
            .fill("test-only-password");
          if (state === "setup")
            await page
              .getByLabel("Operator setup token")
              .fill("test-only-token");
          await page
            .locator("form button[type=submit], form button:not([type])")
            .click();
          await expect(page.getByRole("alert")).toBeVisible();
          await scan(page, `${state}-error`);
        }
        expect(errors).toEqual([]);
      });
    }

    for (const view of ["List", "Board", "Calendar", "Gallery", "Timeline"]) {
      test(`${view} WCAG`, async ({ page }) => {
        const { errors } = await fixture(page, {
          fields,
          items: [
            ...statuses.map((status, i) => ({
              ...task,
              id: `task-${i}`,
              title: `${status} release task`,
              status,
              priority: priorities[i],
              customFields: {
                ...task.customFields,
                reference: "Release notes",
                checkDate: "2026-09-05",
              },
            })),
            {
              ...task,
              id: "unscheduled",
              priority: "urgent",
              startDate: null,
              dueDate: null,
            },
          ],
        });
        await page.goto("/app");
        await expect(
          page.getByRole("button", { name: task.title, exact: true }),
        ).toBeVisible();
        await page.getByRole("tab", { name: view, exact: true }).click();
        await scan(page, view);
        expect(errors).toEqual([]);
      });
    }

    test("task dialog, all custom fields, tags and attachments WCAG", async ({
      page,
    }) => {
      const { errors } = await fixture(page, {
        fields,
        items: [
          {
            ...task,
            tags: ["triage,urgent", "needs  review", "longtag".repeat(8)],
          },
        ],
      });
      await page.goto("/app");
      const opener = page.getByRole("button", {
        name: task.title,
        exact: true,
      });
      await opener.click();
      await expect(
        page.getByRole("dialog", { name: "Task details" }),
      ).toBeVisible();
      await page
        .getByLabel("Attach a file")
        .setInputFiles({
          name: "notes.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("notes"),
        });
      await expect(page.getByRole("link", { name: "notes.txt" })).toBeVisible();
      await page
        .getByLabel("New tag", { exact: true })
        .fill("release, follow-up");
      await page.getByLabel("New tag", { exact: true }).press("Enter");
      await scan(page, "task-dialog");
      expect(
        await page
          .getByRole("dialog")
          .evaluate((e) => e.scrollWidth <= e.clientWidth),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
      expect(errors).toEqual([]);
    });

    test("settings, custom field options and role dialog WCAG", async ({
      page,
    }) => {
      const { errors } = await fixture(page, { fields });
      await page.goto("/settings");
      await expect(page.getByLabel("Display name")).toHaveValue(user.name);
      await page
        .getByRole("combobox", { name: "Type", exact: true })
        .selectOption("select");
      await scan(page, "settings");
      await page.getByRole("button", { name: "Create role" }).click();
      await expect(
        page.getByRole("dialog", { name: "Create a role" }),
      ).toBeVisible();
      await scan(page, "role-dialog");
      expect(errors).toEqual([]);
    });

    test("admin and populated identity management WCAG", async ({ page }) => {
      const { errors } = await fixture(page);
      await page.route("**/api/v1/admin/oidc-identities?*", (route) =>
        route.fulfill({
          json: [
            {
              id: "identity-a11y",
              userId: user.id,
              issuer: `https://issuer.example.test/${"exact-case-".repeat(20)}Tenant/`,
              subject: `Subject-${"opaque-".repeat(25)}A`,
              createdAt: "2026-09-06T03:04:05.000Z",
            },
          ],
        }),
      );
      await page.goto("/admin");
      await expect(
        page.getByRole("heading", { name: "Instance status" }),
      ).toBeVisible();
      await scan(page, "admin");
      await page
        .getByRole("combobox", { name: "Identity account", exact: true })
        .selectOption(user.id);
      await expect(
        page.getByRole("list", { name: "Linked identities" }),
      ).toBeVisible();
      await scan(page, "identities");
      expect(errors).toEqual([]);
    });

    test("assistant and human review WCAG", async ({ page }) => {
      const { errors, mutations } = await fixture(page, { fields });
      await page.goto("/app");
      await page
        .getByRole("button", { name: "Assistant", exact: false })
        .click();
      await expect(page.getByLabel("Message the assistant")).toBeVisible();
      await scan(page, "assistant-empty");
      await page.getByLabel("Message the assistant").fill("Suggest a task");
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(
        page.getByRole("button", { name: "Review suggestion" }),
      ).toBeVisible();
      await scan(page, "assistant-proposal");
      await page.getByRole("button", { name: "Review suggestion" }).click();
      await expect(
        page.getByRole("dialog", { name: "Review suggested task" }),
      ).toBeVisible();
      await scan(page, "agent-review");
      expect(mutations.filter((m) => m.path.endsWith("/items"))).toHaveLength(
        0,
      );
      expect(errors).toEqual([]);
    });

    test("keyboard skip link, tabs, mobile menu and dialog focus", async ({
      page,
    }) => {
      await fixture(page);
      await page.goto("/app");
      await expect(
        page.getByRole("button", { name: task.title, exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("link", { name: "Skip to content" }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("#main")).toBeFocused();
      if (width < 760) {
        await page.getByRole("button", { name: "Menu", exact: true }).focus();
        await page.keyboard.press("Enter");
        await page.keyboard.press("Tab");
        await expect(
          page.getByRole("link", { name: "Workspace", exact: true }),
        ).toBeFocused();
        await scan(page, "mobile-menu");
        await page.keyboard.press("Escape");
        await expect(
          page.getByRole("button", { name: "Menu", exact: true }),
        ).toBeFocused();
      }
      await page.getByRole("tab", { name: "List", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("tab", { name: "Board" })).toBeFocused();
      await page.keyboard.press("Home");
      const opener = page.getByRole("button", {
        name: task.title,
        exact: true,
      });
      await opener.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
      for (const key of ["Tab", "Shift+Tab"]) {
        for (let i = 0; i < 35; i++) {
          await page.keyboard.press(key);
          const focus = await page.getByRole("dialog").evaluate((e) => ({
            inside: e.contains(document.activeElement),
            active: document.activeElement?.tagName,
            documentFocused: document.hasFocus(),
          }));
          // Native dialogs may visit browser chrome, but never the inert page.
          if (!focus.inside) {
            expect(focus).toEqual({
              inside: false,
              active: "BODY",
              documentFocused: false,
            });
            await page.keyboard.press(key);
            expect(
              await page
                .getByRole("dialog")
                .evaluate((e) => e.contains(document.activeElement)),
            ).toBe(true);
          }
        }
      }
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
    });
  });
}
