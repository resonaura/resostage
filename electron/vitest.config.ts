import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Node-only unit tests for the Electron shell's pure helpers (see
// src/discovery.ts). No DOM, no Electron runtime -- just Node + TS.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
