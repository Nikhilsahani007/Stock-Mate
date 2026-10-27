import { execSync } from "node:child_process";

/** Applies migrations to the test database. Each test file truncates the tables it uses. */
export default function setup() {
  execSync("pnpm exec prisma migrate deploy", {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgresql://stockpilot:stockpilot@localhost:5432/stockpilot_test",
    },
  });
}
