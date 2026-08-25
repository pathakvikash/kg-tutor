import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["../test-env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
