/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const COPYRIGHT = "Copyright © 2026 Andrii Vynohradov. All rights reserved.";
const escapeXML = (value) => String(value).replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Shared helper artwork, deliberately independent of Core and shell branding. */
export function helperIcon(repoRoot, extension) {
  const icon = join(repoRoot, "icons", `helper.${extension}`);
  if (!existsSync(icon)) throw new Error(`Helper artwork is missing: ${icon}`);
  return icon;
}

/** Write metadata before bottom-up signing; never modify a sealed helper later. */
export function brandMacHelper(bundle, repoRoot, { name, bundleId, description,
  copyright = COPYRIGHT }) {
  const contents = join(bundle, "Contents");
  const resources = join(contents, "Resources");
  mkdirSync(resources, { recursive: true });
  cpSync(helperIcon(repoRoot, "icns"), join(resources, "AppIcon.icns"));
  const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (!/^\d+(?:\.\d+){0,3}$/.test(version)) throw new Error(`Invalid helper version: ${version}`);
  const strings = {
    CFBundleIdentifier: bundleId,
    CFBundleName: name,
    CFBundleDisplayName: name,
    CFBundleExecutable: name,
    CFBundlePackageType: "APPL",
    CFBundleIconFile: "AppIcon.icns",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    CFBundleGetInfoString: description,
    NSHumanReadableCopyright: copyright,
  };
  const entries = Object.entries(strings).map(([key, value]) =>
    `  <key>${key}</key><string>${escapeXML(value)}</string>`).join("\n");
  const plist = join(contents, "Info.plist");
  if (existsSync(plist) && process.platform === "darwin") {
    // Kaishaku is a CMake/JUCE GUI app: retain deployment targets and other
    // generated capabilities while updating only our branding fields.
    for (const [key, value] of Object.entries(strings)) {
      try { execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist], { stdio: "pipe" }); }
      catch { execFileSync("/usr/bin/plutil", ["-insert", key, "-string", value, plist], { stdio: "pipe" }); }
    }
    try { execFileSync("/usr/bin/plutil", ["-replace", "LSUIElement", "-bool", "true", plist], { stdio: "pipe" }); }
    catch { execFileSync("/usr/bin/plutil", ["-insert", "LSUIElement", "-bool", "true", plist], { stdio: "pipe" }); }
    execFileSync("/usr/bin/plutil", ["-lint", plist], { stdio: "pipe" });
    return;
  }
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${entries}
  <key>LSUIElement</key><true/>
</dict></plist>
`);
  if (process.platform === "darwin") execFileSync("/usr/bin/plutil", ["-lint", plist], { stdio: "pipe" });
}

/** Console workers still receive proper .app identity/icon/process attribution. */
export function installMacNativeHelper(executable, coreBundle, repoRoot, metadata) {
  if (!existsSync(executable)) throw new Error(`Helper executable is missing: ${executable}`);
  const bundle = join(coreBundle, "Contents", "Helpers", `${metadata.name}.app`);
  const macOS = join(bundle, "Contents", "MacOS");
  mkdirSync(macOS, { recursive: true });
  cpSync(executable, join(macOS, metadata.name));
  brandMacHelper(bundle, repoRoot, metadata);
  return bundle;
}
