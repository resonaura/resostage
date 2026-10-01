/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolveImportAliases } from "./resolve-import-aliases.mjs";

test("rewrites aliases into ESM paths Node can execute", async (t) => {
  const output = mkdtempSync(path.join(os.tmpdir(), "resostage-electron-alias-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));

  mkdirSync(path.join(output, "nested"), { recursive: true });
  mkdirSync(path.join(output, "shared"), { recursive: true });
  writeFileSync(path.join(output, "package.json"), '{"type":"module"}\n');
  writeFileSync(path.join(output, "shared", "module.js"), "export const value = 1;\n");
  writeFileSync(path.join(output, "shared", "lazy.mjs"), "export const lazy = true;\n");
  const entryPath = path.join(output, "nested", "entry.mjs");
  writeFileSync(entryPath, [
    'import { value } from "@/shared/module";',
    'export { value as reexported } from "@/shared/module";',
    'import "@/shared/module";',
    'export const lazyModule = await import("@/shared/lazy");',
    'const documentation = "@/shared/module";',
  ].join("\n"));

  assert.equal(resolveImportAliases(output), 1);
  assert.equal(readFileSync(entryPath, "utf8"), [
    'import { value } from "../shared/module.js";',
    'export { value as reexported } from "../shared/module.js";',
    'import "../shared/module.js";',
    'export const lazyModule = await import("../shared/lazy.mjs");',
    'const documentation = "@/shared/module";',
  ].join("\n"));

  const loaded = await import(pathToFileURL(entryPath).href);
  assert.equal(loaded.reexported, 1);
  assert.equal(loaded.lazyModule.lazy, true);
});

test("fails closed when an emitted alias target is missing", (t) => {
  const output = mkdtempSync(path.join(os.tmpdir(), "resostage-electron-alias-missing-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  writeFileSync(path.join(output, "entry.mjs"), 'import "@/missing/module";\n');

  assert.throws(
    () => resolveImportAliases(output),
    /Cannot resolve Electron import alias @\/missing\/module/,
  );
});
