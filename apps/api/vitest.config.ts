import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one database, so run files one at a time.
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://stockpilot:stockpilot@localhost:5432/stockpilot_test",
      NODE_ENV: "test",
    },
  },
});
