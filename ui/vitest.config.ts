/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Default is "node": most tests here are pure logic (src/lib/optimistic.ts,
// timelineVisibility.ts, regionPeaks.ts) and node starts far faster. The few
// that genuinely need a DOM -- currently src/lib/dragCancel.test.ts, which
// exercises real window keydown capture -- opt in per file with
// `// @vitest-environment jsdom`.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
