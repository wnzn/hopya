import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.HOPYA_BROWSER_PORT || 4321);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  workers: 3,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/browser-report.json" }],
  ],
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    // Keep the test server owned by Playwright, even in an AI-agent shell.
    env: { ASTRO_DEV_BACKGROUND: "1" },
    command: `npm run dev -- --config astro.browser.config.ts --port ${port} --ignore-lock`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI && !process.env.HOPYA_BROWSER_PORT,
  },
});
