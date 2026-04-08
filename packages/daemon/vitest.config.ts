import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests spawn real processes (mock claude scripts)
    // which need more time on CI runners than the default 5s
    testTimeout: 15_000,
  },
});
