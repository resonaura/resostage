#!/usr/bin/env node
// Produces a fully renamed + re-iconed copy of the installed node_modules/
// electron Electron.app at the given destination path, so macOS shows
// "ResoStage" everywhere -- Dock, ⌘-Tab, Force Quit, AND Activity Monitor's
// helper process rows (Renderer/GPU/Plugin) -- instead of "Electron".
// app.setName()/app.dock.setIcon at runtime only patch a couple of
// in-process surfaces, not the actual bundle Info.plist / executable names
// those OS surfaces read from.
//
// Renaming the main executable AND every "Electron Helper*.app" the same
// way is required, not cosmetic: Electron's own runtime locates its helper
// processes by taking its own running executable's file name and looking
// for "<that name> Helper[ (Renderer|GPU|Plugin)].app" under Contents/
// Frameworks/ -- this is the same convention electron-builder's productName
// rename relies on. Get the two out of sync and the app can't spawn its
// renderer/GPU processes at all.
//
// This only produces the *shell* (renamed Electron runtime, no app code
// inside yet, unsigned) -- scripts/lib.mjs's assembleShellBundle() copies in
// electron/dist + the nested JUCE Core.app afterwards and code-signs once at
// the end, since adding content after signing invalidates the signature
// anyway.
//
// macOS-only. Usage: node brand-mac-app.mjs <destApp.app path>
import { existsSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = join(__dirname, "..");
const REPO_ROOT = join(ELECTRON_DIR, "..");

const APP_NAME = "ResoStage";
const BUNDLE_ID = "com.resonaura.resostage";
const HELPER_RE = /^Electron Helper( \((GPU|Plugin|Renderer)\))?\.app$/;

function log(msg) {
  console.log(`→ ${msg}`);
}

// Renames one "Electron Helper[ (Variant)].app" -> "ResoStage Helper[ (Variant)].app",
// including its internal executable and Info.plist CFBundleName/CFBundleExecutable.
function renameHelper(frameworksDir, entryName, suffix) {
  const oldDir = join(frameworksDir, entryName);
  const oldExe = `Electron Helper${suffix}`;
  const newExe = `${APP_NAME} Helper${suffix}`;
  execFileSync("mv", [join(oldDir, "Contents", "MacOS", oldExe), join(oldDir, "Contents", "MacOS", newExe)]);
  const plistPath = join(oldDir, "Contents", "Info.plist");
  execFileSync("plutil", ["-replace", "CFBundleName", "-string", newExe, plistPath]);
  execFileSync("plutil", ["-replace", "CFBundleExecutable", "-string", newExe, plistPath]);
  const newDir = join(frameworksDir, `${newExe}.app`);
  execFileSync("mv", [oldDir, newDir]);
}

function renameAllHelpers(destApp) {
  const frameworksDir = join(destApp, "Contents", "Frameworks");
  if (!existsSync(frameworksDir)) return;
  for (const entry of readdirSync(frameworksDir)) {
    const m = entry.match(HELPER_RE);
    if (!m) continue;
    renameHelper(frameworksDir, entry, m[1] ?? "");
  }
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

  // Main executable + Info.plist must be renamed together (CFBundleExecutable
  // has to literally match the file in Contents/MacOS/ or LaunchServices
  // can't launch the bundle at all).
  execFileSync("mv", [
    join(destApp, "Contents", "MacOS", "Electron"),
    join(destApp, "Contents", "MacOS", APP_NAME),
  ]);

  const plistPath = join(destApp, "Contents", "Info.plist");
  execFileSync("plutil", ["-replace", "CFBundleExecutable", "-string", APP_NAME, plistPath]);
  execFileSync("plutil", ["-replace", "CFBundleName", "-string", APP_NAME, plistPath]);
  execFileSync("plutil", ["-replace", "CFBundleDisplayName", "-string", APP_NAME, plistPath]);
  execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", BUNDLE_ID, plistPath]);

  renameAllHelpers(destApp);

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
