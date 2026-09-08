import { test, expect } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`landing keeps native presentation and layout without JavaScript at ${width}px`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    const response = await page.goto(`${baseURL}/`);
    expect(response?.headers()["cache-control"]).toBe("no-store");
    await expect(page).toHaveTitle("A home for your work | Hopya");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      "content",
      /width=device-width/,
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      /self-hosted/i,
    );
    await expect(page.locator("astro-island, noscript")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const properties = await page.evaluate(() =>
      Array.from(document.styleSheets).flatMap((sheet) =>
        Array.from(sheet.cssRules).flatMap((rule) =>
          rule instanceof CSSStyleRule ? Array.from(rule.style) : [],
        ),
      ),
    );
    expect(properties.length).toBeGreaterThan(0);
    expect(
      properties.every((property) =>
        /^(max-width|margin-.+|padding-.+|padding|display|flex-wrap|gap|row-gap|column-gap|align-items|justify-content)$/.test(
          property,
        ),
      ),
    ).toBe(true);
    const presentation = await page
      .locator("h1, nav a")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          return [
            style.fontFamily,
            style.fontSize,
            style.fontWeight,
            style.color,
            style.textDecorationLine,
            style.letterSpacing,
          ];
        }),
      );
    const native = await context.newPage();
    await native.setContent(
      '<nav><a href="http://localhost:4321/login">Sign in</a><a href="http://localhost:4321/app">Open workspace</a></nav><h1>A home for your work</h1>',
    );
    expect(presentation).toEqual(
      await native.locator("h1, nav a").evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          return [
            style.fontFamily,
            style.fontSize,
            style.fontWeight,
            style.color,
            style.textDecorationLine,
            style.letterSpacing,
          ];
        }),
      ),
    );
    await page.getByRole("link", { name: "Skip to content" }).click();
    await expect(page.locator("#main")).toBeFocused();
    await context.close();
  });
}
