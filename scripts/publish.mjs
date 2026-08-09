/**
 * Installer builder: `pnpm run publish`.
 *
 * Turns the assembled bundle in build/<platform>/<arch>/ into something a
 * person who has never seen a terminal can install.
 *
 * ## Why the mac path looks the way it does
 *
 * There is no Apple Developer ID here, so nothing can be notarized. That is
 * not a detail to paper over -- it decides the whole shape of the output:
 *
 *  - The bundle is ad-hoc signed BOTTOM-UP before packaging. Any nested
 *    Mach-O has to be signed before the thing containing it, or signing the
 *    parent invalidates the child. ResoStage nests a whole second .app (the
 *    JUCE core) plus two dylibs inside an Electron shell, which is exactly
 *    the case that breaks if you just run `codesign --deep` at the top.
 *  - `com.apple.security.cs.disable-library-validation` is not optional. The
 *    Electron binaries carry a real Team ID and the locally built JUCE core
 *    carries none; without that entitlement the loader refuses the mix with
 *    "different Team IDs" and the app dies on launch.
 *  - The .pkg gets a postinstall script that strips quarantine and re-signs
 *    in place. That is the step users otherwise have to be talked through in
 *    a terminal, and the one they get wrong.
 *
 * Windows and Linux need none of that. Windows produces an Inno Setup script
 * (compiled here if `iscc` is on PATH, emitted for a Windows box if not) and
 * Linux an AppImage or a tarball, depending on what is installed.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILD_TYPE,
  CORE_APP_NAME,
  DIST_DIR,
  PLATFORM_DIST_DIR,
  ROOT,
  SHELL_APP_NAME,
  die,
  getNestedCoreAppBundle,
  getShellAppBundle,
  log,
  ok,
  run,
  runQuiet,
} from "./lib.mjs";

const BUNDLE_ID = "com.resonaura.resostage";
const OUT_DIR = join(DIST_DIR, "publish");

function appVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    return String(pkg.version || "0.1.0");
  } catch {
    return "0.1.0";
  }
}

function have(tool) {
  return runQuiet("which", [tool]).status === 0;
}

// ── macOS ──────────────────────────────────────────────────────────────────

const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- The locally built JUCE core has no Team ID and the Electron binaries
       do. Without this the loader refuses to map one into the other. -->
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <!-- V8. -->
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <!-- The engine opens input devices as well as outputs. -->
  <key>com.apple.security.device.audio-input</key>
  <true/>
</dict>
</plist>
`;

/**
 * Every Mach-O inside the bundle, deepest first.
 *
 * Order is the whole point: signing a container rewrites its seal over
 * whatever it contains, so a child signed afterwards invalidates the parent.
 * Sorting by path depth descending is a cheap way to guarantee bottom-up
 * without hand-listing a bundle layout that will change.
 */
function machOTargetsDeepestFirst(bundle) {
  const found = runQuiet("find", [
    bundle,
    "-type", "f",
    "(", "-name", "*.dylib", "-o", "-name", "*.so", "-o", "-name", "*.node", ")",
  ]);
  const files = String(found.stdout || "").split("\n").filter(Boolean);

  const bundles = runQuiet("find", [
    bundle,
    "-type", "d",
    "(", "-name", "*.app", "-o", "-name", "*.framework", ")",
  ]);
  const dirs = String(bundles.stdout || "").split("\n").filter(Boolean);

  const all = [...files, ...dirs].filter((p) => p !== bundle);
  all.sort((a, b) => b.split("/").length - a.split("/").length);
  return all;
}

function adhocSignBundle(bundle, entitlementsPath) {
  log("Ad-hoc signing, deepest first...");
  for (const target of machOTargetsDeepestFirst(bundle)) {
    // allowFail: a resource that merely looks like a Mach-O (a stray .so in a
    // node_modules fixture) is not worth aborting a release for.
    run("codesign", ["--force", "--timestamp=none", "--sign", "-",
      "--entitlements", entitlementsPath, "--options", "runtime", target],
      { allowFail: true });
  }
  run("codesign", ["--force", "--timestamp=none", "--sign", "-",
    "--entitlements", entitlementsPath, "--options", "runtime", bundle]);
  const verify = runQuiet("codesign", ["--verify", "--deep", "--strict", bundle]);
  if (verify.status !== 0) {
    log(`codesign --verify reported: ${String(verify.stderr || "").trim()}`);
  }
  ok("Ad-hoc signed");
}

function publishMac() {
  for (const tool of ["pkgbuild", "productbuild", "codesign", "hdiutil"]) {
    if (!have(tool)) die(`Missing ${tool} -- install the Xcode command line tools`);
  }
  const bundle = getShellAppBundle();
  if (!existsSync(bundle)) die(`No bundle at ${bundle}. Run: pnpm run rebuild`);
  if (!existsSync(getNestedCoreAppBundle(bundle))) {
    die(`Shell bundle has no nested "${CORE_APP_NAME}.app" -- the build is incomplete`);
  }

  const version = appVersion();
  const stage = join(OUT_DIR, "stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "root", "Applications"), { recursive: true });
  mkdirSync(join(stage, "scripts"), { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const entitlements = join(OUT_DIR, "entitlements.plist");
  writeFileSync(entitlements, ENTITLEMENTS);
  adhocSignBundle(bundle, entitlements);

  log("Staging payload...");
  run("cp", ["-R", bundle, join(stage, "root", "Applications", `${SHELL_APP_NAME}.app`)]);

  // The installed copy is what actually has to run, so it is re-signed in
  // place after installation: pkgbuild rewrites file metadata on the way in,
  // and the copy inherits quarantine from the .pkg it arrived in.
  const postinstall = join(stage, "scripts", "postinstall");
  writeFileSync(postinstall, `#!/bin/bash
# Installed-copy fixups. Both are things the user would otherwise be asked to
# type into a terminal, which is where an install goes wrong.
set -u
APP="/Applications/${SHELL_APP_NAME}.app"
[ -d "$APP" ] || exit 0
/usr/bin/xattr -cr "$APP" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - "$APP" 2>/dev/null || true
exit 0
`);
  chmodSync(postinstall, 0o755);

  const component = join(OUT_DIR, "ResoStage-component.pkg");
  log("pkgbuild...");
  run("pkgbuild", [
    "--root", join(stage, "root"),
    "--identifier", `${BUNDLE_ID}.app`,
    "--version", version,
    "--install-location", "/",
    "--scripts", join(stage, "scripts"),
    component,
  ]);

  const distXml = join(stage, "distribution.xml");
  writeFileSync(distXml, `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>ResoStage ${version}</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <domains enable_localSystem="true"/>
  <choices-outline><line choice="app"/></choices-outline>
  <choice id="app" title="ResoStage"><pkg-ref id="${BUNDLE_ID}.app"/></choice>
  <pkg-ref id="${BUNDLE_ID}.app" version="${version}">ResoStage-component.pkg</pkg-ref>
</installer-gui-script>
`);

  const pkg = join(OUT_DIR, `ResoStage-${version}.pkg`);
  log("productbuild...");
  run("productbuild", [
    "--distribution", distXml,
    "--package-path", OUT_DIR,
    pkg,
  ]);
  rmSync(component, { force: true });

  // A .dmg alongside it: some people will not run an installer, and
  // drag-to-Applications is the gesture they expect.
  const dmg = join(OUT_DIR, `ResoStage-${version}.dmg`);
  rmSync(dmg, { force: true });
  const dmgStage = join(stage, "dmg");
  mkdirSync(dmgStage, { recursive: true });
  run("cp", ["-R", bundle, join(dmgStage, `${SHELL_APP_NAME}.app`)]);
  run("ln", ["-s", "/Applications", join(dmgStage, "Applications")], { allowFail: true });
  log("hdiutil...");
  run("hdiutil", ["create", "-volname", `ResoStage ${version}`,
    "-srcfolder", dmgStage, "-ov", "-format", "UDZO", dmg]);

  writeFileSync(join(OUT_DIR, "FIRST-RUN.txt"), `ResoStage ${version}

Installing with the .pkg
------------------------
Double-click it. If macOS refuses to open it at all, right-click the .pkg and
choose Open, or run:

    xattr -c "ResoStage-${version}.pkg"
    sudo installer -pkg "ResoStage-${version}.pkg" -target /

The installer clears quarantine and re-signs the installed app for you.

Installing from the .dmg
------------------------
Drag ResoStage to Applications, then run these two lines once:

    sudo xattr -cr "/Applications/${SHELL_APP_NAME}.app"
    sudo codesign --force --deep --sign - "/Applications/${SHELL_APP_NAME}.app"

Why: this build is signed ad-hoc rather than with an Apple Developer ID, so
Gatekeeper has no certificate to check. The commands above tell macOS the app
came from you rather than from the internet. Nothing else about it changes.
`);

  rmSync(stage, { recursive: true, force: true });
  ok(`pkg: ${pkg}`);
  ok(`dmg: ${dmg}`);
  ok(`notes: ${join(OUT_DIR, "FIRST-RUN.txt")}`);
}

// ── Windows ────────────────────────────────────────────────────────────────

function publishWindows() {
  const version = appVersion();
  mkdirSync(OUT_DIR, { recursive: true });
  const payload = PLATFORM_DIST_DIR;
  if (!existsSync(payload)) die(`No build at ${payload}. Run: pnpm run rebuild`);

  const iss = join(OUT_DIR, "resostage.iss");
  writeFileSync(iss, `; Generated by scripts/publish.mjs -- edit the generator, not this file.
[Setup]
AppId={{B7E4B1B0-4C2E-4E6B-9A2E-RESOSTAGE0001}
AppName=ResoStage
AppVersion=${version}
AppPublisher=Resonaura
DefaultDirName={autopf}\\ResoStage
DefaultGroupName=ResoStage
OutputDir=.
OutputBaseFilename=ResoStage-${version}-Setup
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin

[Files]
Source: "${payload}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; The JUCE core is built with MSVC and will not start without this.
Source: "vc_redist.x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist

[Icons]
Name: "{group}\\ResoStage"; Filename: "{app}\\ResoStage.exe"
Name: "{autodesktop}\\ResoStage"; Filename: "{app}\\ResoStage.exe"

[Run]
Filename: "{tmp}\\vc_redist.x64.exe"; Parameters: "/quiet /norestart"; \\
  StatusMsg: "Installing Microsoft Visual C++ runtime..."; \\
  Check: VCRedistNeedsInstall; Flags: skipifdoesntexist
Filename: "{app}\\ResoStage.exe"; Description: "Launch ResoStage"; \\
  Flags: nowait postinstall skipifsilent

[Code]
function VCRedistNeedsInstall: Boolean;
var
  Installed: Cardinal;
begin
  Result := True;
  if RegQueryDWordValue(HKLM, 'SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
                        'Installed', Installed) then
    if Installed = 1 then Result := False;
end;
`);
  ok(`Inno Setup script: ${iss}`);

  if (have("iscc")) {
    log("iscc...");
    run("iscc", [iss], { cwd: OUT_DIR });
    ok(`installer: ${join(OUT_DIR, `ResoStage-${version}-Setup.exe`)}`);
  } else {
    log("iscc not on PATH -- script written, compile it on a Windows box with Inno Setup 6");
  }
}

// ── Linux ──────────────────────────────────────────────────────────────────

function publishLinux() {
  const version = appVersion();
  mkdirSync(OUT_DIR, { recursive: true });
  const payload = PLATFORM_DIST_DIR;
  if (!existsSync(payload)) die(`No build at ${payload}. Run: pnpm run rebuild`);

  if (have("appimagetool")) {
    const appdir = join(OUT_DIR, "ResoStage.AppDir");
    rmSync(appdir, { recursive: true, force: true });
    mkdirSync(join(appdir, "usr", "bin"), { recursive: true });
    run("cp", ["-R", `${payload}/.`, join(appdir, "usr", "bin")]);
    writeFileSync(join(appdir, "resostage.desktop"), `[Desktop Entry]
Type=Application
Name=ResoStage
Exec=ResoStage
Icon=resostage
Categories=AudioVideo;Audio;
`);
    const apprun = join(appdir, "AppRun");
    writeFileSync(apprun, `#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/ResoStage" "$@"
`);
    chmodSync(apprun, 0o755);
    log("appimagetool...");
    run("appimagetool", [appdir, join(OUT_DIR, `ResoStage-${version}-x86_64.AppImage`)]);
    ok(`AppImage: ${join(OUT_DIR, `ResoStage-${version}-x86_64.AppImage`)}`);
    return;
  }

  // No appimagetool: a tarball is still an install, and it does not pretend
  // to resolve the GTK/ALSA dependencies an AppImage would have bundled.
  const tar = join(OUT_DIR, `ResoStage-${version}-linux-${process.arch}.tar.gz`);
  log("tar (appimagetool not found)...");
  run("tar", ["-czf", tar, "-C", payload, "."]);
  writeFileSync(join(OUT_DIR, "LINUX-DEPS.txt"), `ResoStage needs, at runtime:

  libasound2 (>= 1.0.25)   ALSA
  libpulse0                PulseAudio, when present
  libjack-jackd2-2         JACK / PipeWire-JACK, when present
  libgtk-3-0               file dialogs

Install appimagetool and re-run \`pnpm run publish\` to get a self-contained
AppImage instead of this tarball.
`);
  ok(`tarball: ${tar}`);
}

// ── Entry ──────────────────────────────────────────────────────────────────

export function publish() {
  log(`Publishing ResoStage ${appVersion()} (${BUILD_TYPE})`);
  if (process.platform === "darwin") publishMac();
  else if (process.platform === "win32") publishWindows();
  else if (process.platform === "linux") publishLinux();
  else die(`No installer recipe for ${process.platform}`);
}
