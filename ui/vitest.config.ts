import { defineConfig } from "vitest/config";

// Default is "node": most tests here are pure logic (src/lib/optimistic.ts,
// timelineVisibility.ts, regionPeaks.ts) and node starts far faster. The few
// that genuinely need a DOM -- currently src/lib/dragCancel.test.ts, which
// exercises real window keydown capture -- opt in per file with
// `// @vitest-environment jsdom`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
