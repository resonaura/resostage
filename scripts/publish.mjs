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
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// All publish outputs go into the platform build dir (build/mac/arm64/)
// so everything stays in one place. entitlements.plist is written into the
// bundle's Resources folder, not a separate file.

function appVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    return String(pkg.version || "0.1.0");
  } catch {
    return "0.1.0";
  }
}

function have(tool) {
  // Windows has no `which`; cmd.exe uses `where`.
  const cmd = process.platform === "win32" ? "where" : "which";
  return runQuiet(cmd, [tool]).status === 0;
}

function findIscc() {
  if (have("iscc")) return "iscc";
  const candidates = [
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
    join(process.env["ProgramFiles"] || "C:\\Program Files", "Inno Setup 6", "ISCC.exe"),
    "C:\\ProgramData\\chocolatey\\bin\\ISCC.exe",
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ];
  return candidates.find((c) => existsSync(c)) || null;
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
  <!-- Network access for LAN discovery, Art-Net/DMX, remote control, and WebSockets -->
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.network.server</key>
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
  // All staging + outputs go under PLATFORM_DIST_DIR/publish/<version>/
  const publishDir = join(PLATFORM_DIST_DIR, "publish", version);
  if (existsSync(publishDir)) {
    run("rm", ["-rf", publishDir]);
  }
  mkdirSync(publishDir, { recursive: true });
  const stage = join(publishDir, "stage");
  mkdirSync(join(stage, "root", "Applications"), { recursive: true });
  mkdirSync(join(stage, "scripts"), { recursive: true });

  // Write entitlements into bundle's Resources (so it travels with the app)
  const entitlements = join(bundle, "Contents", "Resources", "entitlements.plist");
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

  const component = join(publishDir, "ResoStage-component.pkg");
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

  const pkg = join(publishDir, `ResoStage-${version}.pkg`);
  log("productbuild...");
  run("productbuild", [
    "--distribution", distXml,
    "--package-path", publishDir,
    pkg,
  ]);
  rmSync(component, { force: true });

  // A .dmg containing the installer .pkg and clear installation instructions
  const dmg = join(publishDir, `ResoStage-${version}.dmg`);
  rmSync(dmg, { force: true });
  const dmgStage = join(stage, "dmg");
  mkdirSync(dmgStage, { recursive: true });
  cpSync(pkg, join(dmgStage, `ResoStage-${version}.pkg`));

  const dmgReadme = join(dmgStage, "README.txt");
  writeFileSync(
    dmgReadme,
    `===================================================================
  ResoStage ${version} - macOS Installation Instructions
===================================================================

Before running the installer, remove Apple quarantine and ad-hoc sign
the installer package. Open Terminal and run:

  xattr -cr "ResoStage-${version}.pkg"
  codesign --force --deep --sign - "ResoStage-${version}.pkg"

Then double-click "ResoStage-${version}.pkg" to install.

-------------------------------------------------------------------
(После завершения установки приложение ResoStage появится в папке
Программы / Applications)
===================================================================
`
  );

  log("hdiutil...");
  run("hdiutil", [
    "create",
    dmg,
    "-volname",
    `ResoStage ${version}`,
    "-srcfolder",
    dmgStage,
    "-ov",
    "-format",
    "UDZO",
  ]);

  // Copy standalone application bundle into publishDir as an artifact
  log("Copying standalone ResoStage.app to publish directory...");
  run("cp", ["-R", bundle, join(publishDir, `${SHELL_APP_NAME}.app`)]);

  // Create portable macOS ZIP archive preserving code signature & attributes
  const macZip = join(publishDir, `ResoStage-${version}-mac-${process.arch}.zip`);
  rmSync(macZip, { force: true });
  log("Compressing macOS application ZIP...");
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", bundle, macZip]);

  rmSync(stage, { recursive: true, force: true });
  rmSync(join(publishDir, "FIRST-RUN.txt"), { force: true });

  ok(`pkg: ${pkg}`);
  ok(`dmg: ${dmg}`);
  ok(`zip: ${macZip}`);
  ok(`app: ${join(publishDir, `${SHELL_APP_NAME}.app`)}`);
}

// ── Windows ────────────────────────────────────────────────────────────────

function publishWindows() {
  const version = appVersion();
  // All outputs go under PLATFORM_DIST_DIR/publish/<version>/
  const publishDir = join(PLATFORM_DIST_DIR, "publish", version);
  // Clean target publish directory for clean rebuild
  rmSync(publishDir, { recursive: true, force: true });
  mkdirSync(publishDir, { recursive: true });
  const payload = PLATFORM_DIST_DIR;
  if (!existsSync(payload)) die(`No build at ${payload}. Run: pnpm run rebuild`);

  // Copy Windows .ico for installer + app executable icon
  const icoSrc = join(ROOT, "icons", "app.ico");
  if (existsSync(icoSrc)) {
    cpSync(icoSrc, join(payload, "ResoStage.ico"));
    cpSync(icoSrc, join(publishDir, "ResoStage.ico"));
  }

  const iss = join(publishDir, "resostage.iss");
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
SetupIconFile=ResoStage.ico

[Files]
Source: "${payload}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "publish,publish\\*"
Source: "${payload}\\ResoStage.ico"; DestDir: "{app}"; Flags: ignoreversion
; The JUCE core is built with MSVC and will not start without this.
Source: "vc_redist.x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist

[Icons]
Name: "{group}\\ResoStage"; Filename: "{app}\\ResoStage.exe"; IconFilename: "{app}\\ResoStage.ico"
Name: "{autodesktop}\\ResoStage"; Filename: "{app}\\ResoStage.exe"; IconFilename: "{app}\\ResoStage.ico"

[Registry]
; .rsnrasetmeta file association (metadata file next to project folder)
Root: HKCR; Subkey: ".rsnrasetmeta"; ValueType: string; ValueData: "ResoStage.ProjectFile"; Flags: uninsdeletekey
Root: HKCR; Subkey: "ResoStage.ProjectFile"; ValueType: string; ValueData: "ResoStage Project File"; Flags: uninsdeletekey
Root: HKCR; Subkey: "ResoStage.ProjectFile\\DefaultIcon"; ValueType: string; ValueData: "{app}\\ResoStage.ico,0"
Root: HKCR; Subkey: "ResoStage.ProjectFile\\shell\\open\\command"; ValueType: string; ValueData: """{app}\\ResoStage.exe"" ""%1"""

[Run]
Filename: "{tmp}\\vc_redist.x64.exe"; Parameters: "/quiet /norestart"; \\
  StatusMsg: "Installing Microsoft Visual C++ runtime..."; \\
  Check: VCRedistNeedsInstall; Flags: skipifsilent
; Configure Windows Defender Firewall rules for Core, Discovery, Web, Telemetry, and Art-Net
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""ResoStage LAN Discovery"" dir=in action=allow protocol=UDP localport=28991 enable=yes"; Flags: runhidden
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""ResoStage Web Server"" dir=in action=allow protocol=TCP localport=2899 enable=yes"; Flags: runhidden
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""ResoStage Telemetry"" dir=in action=allow protocol=UDP localport=2898 enable=yes"; Flags: runhidden
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""ResoStage Art-Net"" dir=in action=allow protocol=UDP localport=6454 enable=yes"; Flags: runhidden
Filename: "{app}\\ResoStage.exe"; Description: "Launch ResoStage"; \\
  Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""ResoStage LAN Discovery"""; Flags: runhidden
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""ResoStage Web Server"""; Flags: runhidden
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""ResoStage Telemetry"""; Flags: runhidden
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""ResoStage Art-Net"""; Flags: runhidden

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

  const isccBin = findIscc();
  if (isccBin) {
    log(`iscc (${isccBin})...`);
    run(isccBin, [iss], { cwd: publishDir });
    ok(`installer: ${join(publishDir, `ResoStage-${version}-Setup.exe`)}`);
  } else {
    log("iscc not on PATH or standard install locations -- compile it on a Windows box with Inno Setup 6");
  }

  // Always create portable application archive for Windows (excluding the publish subfolder itself)
  const archivePath = join(publishDir, `ResoStage-${version}-win-${process.arch}.zip`);
  rmSync(archivePath, { force: true });
  if (have("tar")) {
    log("Compressing Windows portable ZIP...");
    run("tar", ["-a", "-cf", archivePath, "--exclude=publish", "-C", payload, "."]);
    ok(`Portable ZIP archive: ${archivePath}`);
  } else if (have("zip")) {
    log("Compressing Windows portable ZIP...");
    run("zip", ["-r", "-q", archivePath, ".", "-x", "publish/*"], { cwd: payload });
    ok(`Portable ZIP archive: ${archivePath}`);
  }

  // Clean up intermediate build scripts and icons from publish directory
  rmSync(iss, { force: true });
  rmSync(join(publishDir, "ResoStage.ico"), { force: true });
}

// ── Linux ──────────────────────────────────────────────────────────────────

function publishLinux() {
  const version = appVersion();
  // All outputs go under PLATFORM_DIST_DIR/publish/<version>/
  const publishDir = join(PLATFORM_DIST_DIR, "publish", version);
  // Clean target publish directory for clean rebuild
  rmSync(publishDir, { recursive: true, force: true });
  mkdirSync(publishDir, { recursive: true });
  const payload = PLATFORM_DIST_DIR;
  if (!existsSync(payload)) die(`No build at ${payload}. Run: pnpm run rebuild`);

  // Copy Linux .png icon for AppImage / desktop entry
  const pngSrc = join(ROOT, "icons", "folder.png");
  if (existsSync(pngSrc)) {
    cpSync(pngSrc, join(payload, "resostage.png"));
  }

  // Mime-type desktop entry for .rsnrasetmeta file association
  const mimeDesktop = `[Desktop Entry]
Type=MimeType
MimeType=application/x-resostage-project-file
Comment=ResoStage Project File
Icon=resostage
`;
  writeFileSync(join(payload, "application-x-resostage-project-link.desktop"), mimeDesktop);

  // Application desktop entry with MimeType for .rsnrasetmeta
  const appDesktop = `[Desktop Entry]
Type=Application
Name=ResoStage
Exec=ResoStage %U
Icon=resostage
Categories=AudioVideo;Audio;
MimeType=application/x-resostage-project-link;
`;
  writeFileSync(join(payload, "resostage.desktop"), appDesktop);

  if (have("appimagetool")) {
    const appdir = join(publishDir, "ResoStage.AppDir");
    rmSync(appdir, { recursive: true, force: true });
    mkdirSync(join(appdir, "usr", "bin"), { recursive: true });
    run("rsync", ["-a", "--exclude=publish", `${payload}/`, join(appdir, "usr", "bin")]);
    // Icon for AppImage / desktop integration
    if (existsSync(join(payload, "resostage.png"))) {
      cpSync(join(payload, "resostage.png"), join(appdir, "resostage.png"));
    }
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
    run("appimagetool", [appdir, join(publishDir, `ResoStage-${version}-x86_64.AppImage`)]);
    ok(`AppImage: ${join(publishDir, `ResoStage-${version}-x86_64.AppImage`)}`);
  }

  // Create Linux portable tarball archive
  const tar = join(publishDir, `ResoStage-${version}-linux-${process.arch}.tar.gz`);
  log("Compressing Linux tarball archive...");
  run("tar", ["-czf", tar, "--exclude=publish", "-C", payload, "."]);
  writeFileSync(join(publishDir, "LINUX-DEPS.txt"), `ResoStage needs, at runtime:

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

export { publishMac, publishWindows, publishLinux, adhocSignBundle, machOTargetsDeepestFirst };

export function publish() {
  log(`Publishing ResoStage ${appVersion()} (${BUILD_TYPE})`);
  const pubDir = join(PLATFORM_DIST_DIR, "publish");
  rmSync(pubDir, { recursive: true, force: true });
  mkdirSync(pubDir, { recursive: true });

  if (process.platform === "darwin") publishMac();
  else if (process.platform === "win32") publishWindows();
  else if (process.platform === "linux") publishLinux();
  else die(`No installer recipe for ${process.platform}`);
}
