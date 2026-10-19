import { defineConfig } from "vitest/config";
import { TEST_ENV } from "./test/env.js";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Set before any test imports src/config.ts. Already-set variables win over .env,
    // so the Supabase URLs in .env are never used by tests.
    env: TEST_ENV,
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
    // All test files share one database: run them one after another, never at once.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
