import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { fixture, task } from "./fixture";

for (const path of ["/app", "/login", "/admin"]) {
test(`Settings owns appearance; stored choices apply before React on ${path}`, async ({ page }) => {
  const { errors, mutations } = await fixture(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings");
  await expect(page.getByLabel("Display name")).toHaveValue("Test Owner");
  await expect(page.locator(".sidebar .theme-toggle")).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle dark mode" }).click();
  expect(await page.evaluate(() => localStorage.getItem("hopya-theme"))).toBe("dark");
  // Keep only the head initializer, so neither Astro nor React can restore the theme.
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({ response, body: html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,
      (script) => script.includes("hopya-theme-preference") ? script : "") });
  });
  for (const scheme of ["dark", "light"] as const) {
    await page.evaluate((value) => localStorage.setItem("hopya-theme", value), scheme);
    await page.emulateMedia({ colorScheme: scheme === "dark" ? "light" : "dark" });
      await page.goto(path);
      await expect(page.locator("astro-island[ssr]")).toHaveCount(1);
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute("content", scheme);
      await expect(page.locator("html")).toHaveCSS("color-scheme", scheme);
      await expect(page.locator(".theme-toggle")).toHaveCount(0);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
  }
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});
}

test("system changes update appearance and control state only without an explicit preference", async ({ page }) => {
  const { errors } = await fixture(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings");
  await expect(page.getByLabel("Display name")).toBeVisible();
  const toggle = page.getByRole("button", { name: "Toggle dark mode" });
  const system = page.getByRole("button", { name: "Use system theme" });
  await expect(system).toHaveAttribute("aria-pressed", "true");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute("content", "dark");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await page.reload();
  await expect(page.getByLabel("Display name")).toHaveValue("Test Owner");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await system.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await page.getAttribute("html", "data-theme")).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("hopya-theme"))).toBeNull();
  await page.reload();
  await expect(system).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
});

for (const storage of ["invalid", "blocked"] as const) {
  test(`${storage} storage falls back to the OS without breaking Settings`, async ({ page }) => {
    const { errors } = await fixture(page);
    page.on("pageerror", (error) => { void test.info().attach("storage-error", { body: error.stack || error.message, contentType: "text/plain" }); });
    await page.addInitScript((mode) => {
      if (mode === "invalid") localStorage.setItem("hopya-theme", "unexpected");
      else Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Blocked", "SecurityError"); } });
    }, storage);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/settings");
    await expect(page.getByLabel("Display name")).toHaveValue("Test Owner");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    expect(await page.getAttribute("html", "data-theme")).toBeNull();
    const toggle = page.getByRole("button", { name: "Toggle dark mode" });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "light" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
    await page.getByRole("button", { name: "Use system theme" }).click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 390, 1280]) {
  for (const path of ["/settings", "/app"]) {
  test(`dark surfaces, spacing, keyboard focus and axe on ${path} at ${width}px`, async ({ page }) => {
    const { errors } = await fixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(path);
      if (path === "/settings") await expect(page.getByLabel("Display name")).toHaveValue("Test Owner");
      else await expect(page.getByRole("button", { name: task.title, exact: true })).toBeVisible();
      await expect(page.locator(".sidebar .theme-toggle")).toHaveCount(0);
      if (width < 760) await page.getByRole("button", { name: "Menu", exact: true }).click();
      await expect(page.locator(".sidebar")).toHaveCSS("background-color", "rgb(32, 32, 32)");
      await expect(page.locator(".main-content")).toHaveCSS("background-color", "rgb(10, 10, 10)");
      await expect(page.locator(".sidebar")).toHaveCSS("border-right-color", "rgb(72, 72, 72)");
      await expect(page.locator(".main-nav")).toHaveCSS("gap", "8px");
      if (width >= 760) {
        const logo = (await page.locator(".sidebar > .brand").boundingBox())!;
        const nav = (await page.locator(".main-nav").boundingBox())!;
        expect(nav.y - logo.y - logo.height).toBeGreaterThanOrEqual(24);
      } else await page.getByRole("button", { name: "Menu", exact: true }).click();
      if (path === "/settings") {
        const toggle = page.getByRole("button", { name: "Toggle dark mode" });
        await toggle.focus();
        await page.keyboard.press("Tab");
        const reset = page.getByRole("button", { name: "Use system theme" });
        await expect(reset).toBeFocused();
        await expect(reset).toHaveCSS("outline-style", "solid");
        await expect(reset).toHaveCSS("outline-offset", "3px");
        const bounds = (await reset.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(6);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 6);
        await expect(page.locator(".theme-controls")).toHaveCSS("gap", "12px");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
      await test.info().attach(`${path.slice(1)}-axe`, { body: JSON.stringify(axe), contentType: "application/json" });
      expect(axe.violations).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`${path.slice(1)}-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
  }
}
