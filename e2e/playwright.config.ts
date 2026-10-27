import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests against the real API and web app. The API runs on its own
 * database (E2E_DATABASE_URL), brought up to date with migrations before every
 * run. Nothing is wiped: each test signs up its own business, so runs never
 * see each other's data.
 */
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://stockpilot:stockpilot@localhost:5432/stockpilot_e2e";
const API_PORT = 4100;
const WEB_PORT = 5273;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: [
    {
      command: "pnpm --filter @stockpilot/api exec prisma migrate deploy && pnpm --filter @stockpilot/api exec tsx src/server.ts",
      url: `http://localhost:${API_PORT}/api/health`,
      env: { DATABASE_URL, PORT: String(API_PORT), NODE_ENV: "test" },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @stockpilot/web exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { API_URL: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
