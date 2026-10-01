/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { brandMacHelper, helperIcon, installMacNativeHelper } from "../bundle.mjs";

test("native helpers receive separate artwork, metadata, and executable identity", () => {
  const temp = mkdtempSync(join(tmpdir(), "resostage-helper-test-"));
  try {
    mkdirSync(join(temp, "icons"));
    writeFileSync(join(temp, "icons", "helper.icns"), "helper artwork fixture");
    writeFileSync(join(temp, "package.json"), '{"version":"0.1.0"}');
    const executable = join(temp, "worker");
    writeFileSync(executable, "native fixture");
    chmodSync(executable, 0o755);
    const metadata = { name: "ResoStage Plugin Scanner", bundleId: "com.resonaura.resostage.pluginscan",
      description: "AU/VST3 scanner & crash containment" };
    const bundle = installMacNativeHelper(executable, join(temp, "Core.app"), temp, metadata);
    const contents = join(bundle, "Contents");
    assert.ok(existsSync(join(contents, "MacOS", metadata.name)));
    assert.equal(readFileSync(join(contents, "Resources", "AppIcon.icns"), "utf8"), "helper artwork fixture");
    const plist = readFileSync(join(contents, "Info.plist"), "utf8");
    assert.match(plist, /scanner &amp; crash containment/);
    assert.match(plist, /com.resonaura.resostage.pluginscan/);
    assert.match(plist, /CFBundleVersion<\/key><string>0.1.0/);
    if (process.platform === "darwin") {
      const plistPath = join(contents, "Info.plist");
      execFileSync("/usr/bin/plutil", ["-insert", "LSMinimumSystemVersion", "-string", "11.0", plistPath]);
      brandMacHelper(bundle, temp, metadata);
      assert.equal(execFileSync("/usr/bin/plutil", ["-extract", "LSMinimumSystemVersion", "raw", plistPath], { encoding: "utf8" }).trim(), "11.0");
    }
    assert.throws(() => helperIcon(temp, "ico"), /artwork is missing/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
