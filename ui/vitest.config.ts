import { defineConfig } from "vitest/config";

// Pure-logic unit tests only (no DOM/component rendering yet) -- see
// src/lib/timelineVisibility.test.ts. Plain "node" environment is enough and
// keeps this fast; add jsdom here if/when a test actually needs it.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
