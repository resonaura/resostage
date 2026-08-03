#!/usr/bin/env node
// Produces a renamed + re-iconed copy of the installed node_modules/electron
// Electron.app at the given destination path, so macOS shows "ResoStage"
// (with icons/app.icns) instead of "Electron" in the Dock, ⌘-Tab switcher,
// and Force Quit -- app.setName()/app.dock.setIcon at runtime only patch a
// couple of in-process surfaces, not the actual bundle's Info.plist that
// those OS surfaces read from.
//
// This only produces the *shell* (renamed Electron runtime, no app code
// inside yet, unsigned) -- scripts/lib.mjs's assembleShellBundle() copies in
// electron/dist + the nested JUCE Core.app afterwards and code-signs once at
// the end, since adding content after signing invalidates the signature
// anyway.
//
// macOS-only. Usage: node brand-mac-app.mjs <destApp.app path>
import { existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = join(__dirname, "..");
const REPO_ROOT = join(ELECTRON_DIR, "..");

const APP_NAME = "ResoStage";
const BUNDLE_ID = "com.resostage.app";

function log(msg) {
  console.log(`→ ${msg}`);
}

function main() {
  if (process.platform !== "darwin") {
    log("Not on macOS -- skipping Electron.app branding");
    return;
  }

  const destApp = process.argv[2];
  if (!destApp) {
    console.error("Usage: node brand-mac-app.mjs <destApp.app path>");
    process.exit(1);
  }

  const electronPkgDir = join(ELECTRON_DIR, "node_modules", "electron");
  const electronPkgJson = join(electronPkgDir, "package.json");
  if (!existsSync(electronPkgJson)) {
    log("electron/node_modules/electron not installed -- skipping branding");
    return;
  }
  const electronVersion = JSON.parse(readFileSync(electronPkgJson, "utf8")).version;

  const srcApp = join(electronPkgDir, "dist", "Electron.app");
  if (!existsSync(srcApp)) {
    log(`${srcApp} not found -- skipping branding`);
    return;
  }

  const stampFile = join(dirname(destApp), ".electron-version");
  if (existsSync(destApp) && existsSync(stampFile)) {
    const stamped = readFileSync(stampFile, "utf8").trim();
    if (stamped === electronVersion) {
      log(`${APP_NAME}.app shell already branded for Electron ${electronVersion} -- skipping`);
      return;
    }
  }

  log(`Branding Electron.app -> ${destApp} (Electron ${electronVersion})...`);
  rmSync(destApp, { recursive: true, force: true });
  execFileSync("mkdir", ["-p", dirname(destApp)]);
  // `cp -R` (not fs.cpSync -- it re-resolves relative symlink targets to
  // absolute paths back into node_modules, which breaks codesign on nested
  // frameworks that use a Versions/Current symlink layout, e.g. Mantle.
  // framework) preserves symlinks verbatim, exactly like a real .app copy
  // needs.
  execFileSync("cp", ["-R", srcApp, destApp]);

  const plistPath = join(destApp, "Contents", "Info.plist");
  execFileSync("plutil", ["-replace", "CFBundleName", "-string", APP_NAME, plistPath]);
  execFileSync("plutil", ["-replace", "CFBundleDisplayName", "-string", APP_NAME, plistPath]);
  execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", BUNDLE_ID, plistPath]);

  const icnsSrc = join(REPO_ROOT, "icons", "app.icns");
  if (existsSync(icnsSrc)) {
    execFileSync("cp", [icnsSrc, join(destApp, "Contents", "Resources", "electron.icns")]);
  } else {
    log(`${icnsSrc} not found -- keeping stock Electron icon`);
  }

  writeFileSync(stampFile, electronVersion);
  log(`Shell branded at ${destApp}`);
}

main();
