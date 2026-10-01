/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, realpathSync } from "node:fs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

const FFMPEG_VERSION = "9.0.2";
const FFMPEG_SOURCE = `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`;
const FFMPEG_SHA256 = "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e";
const FFMPEG_SIGNING_KEY = "FCF986EA15E6E293A5644F10B4322F04D67658D8";
const RUNTIME_LAYOUT_VERSION = 2;
// A month-end release is retained upstream for two years. Do not combine
// pinned hashes with floating "latest" URLs: tomorrow's build would fail.
const BTBN_RELEASE = "autobuild-2026-09-30-13-08";
const BTBN_VERSION = "n9.0.2-17-g2a571b6068";
const BTBN_SOURCE = "https://github.com/FFmpeg/FFmpeg/tree/2a571b6068";
const MAC_INTEL_BUILD = {
  name: `ffmpeg-${FFMPEG_VERSION}.zip`,
  url: `https://evermeet.cx/ffmpeg/ffmpeg-${FFMPEG_VERSION}.zip`,
  sha256: "4acc0be580f9b2788029eb7bd4d645ff87968911b0a62aeeb3940d42d54558d5",
};

const WINDOWS_LINUX_BUILDS = {
  "linux-x64": {
    name: `ffmpeg-${BTBN_VERSION}-linux64-gpl-9.0.tar.xz`,
    sha256: "68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269",
  },
  "linux-arm64": {
    name: `ffmpeg-${BTBN_VERSION}-linuxarm64-gpl-9.0.tar.xz`,
    sha256: "91afcd7695d4bbbb9e0057aa10baaf9875ec4e1a97303f9059ec971336a2ab46",
  },
  "win32-x64": {
    name: `ffmpeg-${BTBN_VERSION}-win64-gpl-shared-9.0.zip`,
    sha256: "3da6c7b60bb9ccd73ec5b5e815ba804a0879eb362ba0e3beebce50174c022696",
  },
  "win32-arm64": {
    name: `ffmpeg-${BTBN_VERSION}-winarm64-gpl-shared-9.0.zip`,
    sha256: "92460cf103340012d41413b557669902538f040e0c953abc1d719750dcd5f8a8",
  },
};

function sha256File(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytesRead));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function download(url, destination) {
  console.log(`Downloading ${url}`);
  run("curl", ["-fsSL", "--retry", "5", "--retry-all-errors", "--retry-delay", "2",
    "--connect-timeout", "30", "--max-time", "3600", url, "-o", destination]);
}

function run(executable, args, options = {}) {
  execFileSync(executable, args, { stdio: "inherit", ...options });
}

function findNamedFile(directory, name) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase())
      return path;
    if (entry.isDirectory()) {
      const found = findNamedFile(path, name);
      if (found) return found;
    }
  }
  return null;
}

function copyLicenseFiles(sourceRoot, destination) {
  mkdirSync(destination, { recursive: true });
  const copied = new Set();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (/(license|copying|copyright|^gpl|^lgpl)/i.test(entry.name)) {
        const target = join(destination, relative(sourceRoot, path).split(sep).join("_"));
        cpSync(path, target);
        copied.add(entry.name.toLowerCase());
      }
    }
  };
  visit(sourceRoot);
  if (!copied.size)
    throw new Error(`FFmpeg package contains no license texts: ${sourceRoot}`);
}

function writeManifest(destination, platform, arch, {
  extra = "", identity, version = FFMPEG_VERSION,
  source = FFMPEG_SOURCE, sourceHash = FFMPEG_SHA256,
} = {}) {
  const lines = [
    `FFmpeg ${version}`,
    `Platform: ${platform}-${arch}`,
    `Runtime layout: ${RUNTIME_LAYOUT_VERSION}`,
    "License: GPL codec build; --enable-nonfree components are excluded.",
    "Runtime: bundled inside the ResoStage application; no system FFmpeg/PATH lookup is performed.",
    `FFmpeg source: ${source}`,
    sourceHash ? `FFmpeg source SHA-256: ${sourceHash}` : "",
    sourceHash ? `FFmpeg release signing key fingerprint: ${FFMPEG_SIGNING_KEY}` : "",
    `Runtime identity: ${identity}`,
    "Build configuration, supplier/source references, and license notices accompany this runtime.",
    "ResoStage packaging changes are limited to executable branding and library relocation.",
    extra,
  ].filter(Boolean);
  writeFileSync(join(destination, "BUILD.txt"), `${lines.join("\n")}\n`);
}

function ensureHash(path, expected, label) {
  const actual = sha256File(path);
  if (actual !== expected)
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
}

function capture(executable, args, options = {}) {
  return execFileSync(executable, args, { encoding: "utf8", timeout: 30000, ...options }).trim();
}

function validateConfiguration(versionInfo) {
  const config = versionInfo.split("\n").find((line) => line.startsWith("configuration:")) ?? "";
  if (!config.includes("--enable-gpl") || config.includes("--enable-nonfree"))
    throw new Error("Bundled FFmpeg must enable GPL codecs and must not enable nonfree components");
}

function validateMacArchitecture(file, arch) {
  const required = arch === "x64" ? "x86_64" : "arm64";
  const architectures = capture("lipo", ["-archs", file]).split(/\s+/);
  if (!architectures.includes(required))
    throw new Error(`FFmpeg image ${file} has ${architectures.join(", ")}, but the app requires ${required}`);
}

function ensureHomebrewFFmpeg(arch) {
  let prefix;
  try {
    prefix = capture("brew", ["--prefix", "ffmpeg"]);
  } catch {
    prefix = "";
  }
  let executable = prefix ? join(prefix, "bin", "ffmpeg") : "";
  if (!executable || !existsSync(executable)) {
    console.log("Installing the full GPL FFmpeg build into the build environment (it will be bundled into ResoStage)...");
    run("brew", ["install", "ffmpeg"]);
    prefix = capture("brew", ["--prefix", "ffmpeg"]);
    executable = join(prefix, "bin", "ffmpeg");
  }
  if (!existsSync(executable)) throw new Error(`Homebrew FFmpeg executable missing: ${executable}`);
  validateMacArchitecture(executable, arch);
  const versionInfo = capture(executable, ["-version"]);
  validateConfiguration(versionInfo);
  const version = versionInfo.match(/^ffmpeg version (\S+)/)?.[1];
  if (!version || !/^\d+\.\d+(?:\.\d+)?$/.test(version))
    throw new Error(`Cannot identify the installed Homebrew FFmpeg release: ${versionInfo.split("\n")[0]}`);
  const deps = capture("brew", ["deps", "--installed", "ffmpeg"]).split("\n").filter(Boolean);
  const versions = deps.map((name) => capture("brew", ["list", "--versions", name])).join("\n");
  const identity = createHash("sha256").update(`${versionInfo}\n${versions}`).digest("hex");
  return { prefix, executable, version, versionInfo, identity, deps: ["ffmpeg", ...deps] };
}

function otoolDependencies(file) {
  // `otool -L` includes a dylib's own install ID as its first row; it is
  // identity, not a dependency that must be resolved through LC_RPATH.
  const installId = capture("otool", ["-D", file]).split("\n").slice(1).map((line) => line.trim())[0];
  return capture("otool", ["-L", file]).split("\n").slice(1)
    .map((line) => line.trim().match(/^(.*?) \(compatibility version/))
    .filter(Boolean).map((match) => match[1]).filter((path) => path !== installId);
}

function otoolRpaths(file) {
  const lines = capture("otool", ["-l", file]).split("\n");
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "cmd LC_RPATH") continue;
    const pathLine = lines.slice(i + 1, i + 5).find((line) => line.trim().startsWith("path "));
    const path = pathLine?.trim().match(/^path (.*?) \(offset/);
    if (path) result.push(path[1]);
  }
  return result;
}

function expandMachPath(path, imagePath, executablePath) {
  return path
    .replace(/^@loader_path/, dirname(imagePath))
    .replace(/^@executable_path/, dirname(executablePath));
}

function resolveMachDependency(imagePath, dependency, executablePath) {
  if (dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/"))
    return null;
  const candidates = [];
  if (dependency.startsWith("@rpath/")) {
    const tail = dependency.slice("@rpath/".length);
    for (const rpath of otoolRpaths(imagePath))
      candidates.push(join(expandMachPath(rpath, imagePath, executablePath), tail));
  } else {
    candidates.push(expandMachPath(dependency, imagePath, executablePath));
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found)
    throw new Error(`Could not resolve FFmpeg dependency ${dependency} referenced by ${imagePath}`);
  const resolved = realpathSync(found);
  if (resolved.startsWith("/System/Library/") || resolved.startsWith("/usr/lib/"))
    return null;
  return resolved;
}

function bundleMacDylibs(sourceExecutable, runtimeDirectory, arch) {
  const executableDestination = join(runtimeDirectory, "ffmpeg");
  const libraryDirectory = join(runtimeDirectory, "lib");
  mkdirSync(libraryDirectory, { recursive: true });
  cpSync(realpathSync(sourceExecutable), executableDestination);
  const queue = [{ source: realpathSync(sourceExecutable), destination: executableDestination, root: true }];
  const destinations = new Map([[realpathSync(sourceExecutable), executableDestination]]);
  while (queue.length) {
    const item = queue.shift();
    validateMacArchitecture(item.source, arch);
    for (const dependency of otoolDependencies(item.source)) {
      const resolved = resolveMachDependency(item.source, dependency, sourceExecutable);
      if (!resolved) continue;
      let destination = destinations.get(resolved);
      if (!destination) {
        const libraryName = resolved.split(sep).at(-1);
        destination = join(libraryDirectory, libraryName);
        if (existsSync(destination))
          throw new Error(`Multiple Homebrew libraries collide at bundled name ${libraryName}`);
        cpSync(resolved, destination);
        destinations.set(resolved, destination);
        queue.push({ source: resolved, destination, root: false });
      }
      const replacement = item.root
        ? `@executable_path/lib/${destination.split(sep).at(-1)}`
        : `@loader_path/${destination.split(sep).at(-1)}`;
      run("install_name_tool", ["-change", dependency, replacement, item.destination], { stdio: "pipe" });
    }
    if (!item.root)
      run("install_name_tool", ["-id", `@rpath/${item.destination.split(sep).at(-1)}`, item.destination], { stdio: "pipe" });
  }
  for (const file of [executableDestination, ...readdirSync(libraryDirectory).map((name) => join(libraryDirectory, name))])
    run("codesign", ["--force", "--sign", "-", "--timestamp=none", file], { stdio: "pipe" });
}

function buildMacRuntime(destination, platform, arch, brewFFmpeg) {
  const executable = realpathSync(brewFFmpeg.executable);
  bundleMacDylibs(executable, destination, arch);
  const licensesDir = join(destination, "licenses");
  mkdirSync(licensesDir, { recursive: true });
  for (const formula of brewFFmpeg.deps) {
    const formulaPrefix = capture("brew", ["--prefix", formula]);
    const target = join(licensesDir, formula.replaceAll("/", "_"));
    try { copyLicenseFiles(formulaPrefix, target); } catch (error) {
      console.log(`No installed license texts for ${formula}: ${error.message}`);
    }
    // Installed recipes/receipts preserve exact source and bottle provenance;
    // the live Homebrew formula may have changed since this bottle was built.
    const installedPrefix = realpathSync(formulaPrefix);
    for (const name of [".brew", "INSTALL_RECEIPT.json"])
      if (existsSync(join(installedPrefix, name)))
        cpSync(join(installedPrefix, name), join(target, name), { recursive: true });
  }
  writeManifest(destination, platform, arch, {
    extra: "Runtime supplier: Homebrew FFmpeg formula\nInstalled formula sources and versions: licenses/*/.brew and INSTALL_RECEIPT.json",
    identity: brewFFmpeg.identity, version: brewFFmpeg.version,
    source: `https://ffmpeg.org/releases/ffmpeg-${brewFFmpeg.version}.tar.xz`, sourceHash: null,
  });
  writeFileSync(join(destination, "CONFIGURE.txt"), `${brewFFmpeg.versionInfo}\n`);
}

function copyFFmpegLicenseTexts(tempRoot, destination) {
  const archive = join(tempRoot, `ffmpeg-${FFMPEG_VERSION}.tar.xz`);
  download(FFMPEG_SOURCE, archive);
  ensureHash(archive, FFMPEG_SHA256, "FFmpeg license source archive");
  const extracted = join(tempRoot, "source");
  mkdirSync(extracted, { recursive: true });
  run("tar", ["-xf", archive, "-C", extracted]);
  copyLicenseFiles(join(extracted, `ffmpeg-${FFMPEG_VERSION}`), join(destination, "licenses", "ffmpeg"));
}

/** Validates the copied runtime, including every non-system Mach-O dependency. */
export function verifyFFmpegRuntime(directory, platform = process.platform, arch = process.arch,
  executableName = platform === "win32" ? "ffmpeg.exe" : "ffmpeg") {
  const executable = join(directory, executableName);
  if (platform !== process.platform) return;
  if (platform === "darwin") {
    const images = [executable, ...(existsSync(join(directory, "lib"))
      ? readdirSync(join(directory, "lib")).map((name) => join(directory, "lib", name)) : [])];
    for (const image of images) {
      validateMacArchitecture(image, arch);
      for (const dependency of otoolDependencies(image)) {
        if (dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/")) continue;
        const resolved = resolveMachDependency(image, dependency, executable);
        if (resolved && !resolved.startsWith(`${realpathSync(directory)}${sep}`))
          throw new Error(`Bundled FFmpeg still references external library ${dependency}`);
      }
    }
  }
  // Run the exact installed image with a minimal environment. Architecture
  // validation above catches Intel/ARM mixups before this smoke test.
  const options = { env: { PATH: platform === "win32" ? process.env.SystemRoot + "\\System32" : "/usr/bin:/bin",
    ...(platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}), LANG: "C" } };
  const versionInfo = capture(executable, ["-version"], options);
  validateConfiguration(versionInfo);
  const encoders = capture(executable, ["-hide_banner", "-encoders"], options);
  for (const encoder of ["aac", "alac", "flac", "libmp3lame", "libopus", "libvorbis", "wmav2"])
    if (!new RegExp(`\\s${encoder}\\s`).test(encoders))
      throw new Error(`Bundled FFmpeg lacks required export encoder ${encoder}`);
  return versionInfo;
}

export function prepareFFmpegRuntime(platform, arch, cacheRoot) {
  const platformName = platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform;
  const packageSpec = platform === "darwin" && arch === "x64"
    ? MAC_INTEL_BUILD : WINDOWS_LINUX_BUILDS[`${platform}-${arch}`];
  const brewFFmpeg = platform === "darwin" && arch === "arm64" ? ensureHomebrewFFmpeg(arch) : null;
  const runtimeIdentity = brewFFmpeg?.identity ?? packageSpec?.sha256;
  if (!runtimeIdentity)
    throw new Error(`No bundled FFmpeg build is defined for ${platform}-${arch}`);
  const cacheDir = join(cacheRoot, "dependencies", "ffmpeg", `${platformName}-${arch}`);
  const executableName = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const marker = join(cacheDir, "BUILD.txt");
  if (existsSync(join(cacheDir, executableName)) && existsSync(marker)) {
    const current = readFileSync(marker, "utf8");
    if (current.includes(`Platform: ${platformName}-${arch}`)
      && current.includes(`Runtime layout: ${RUNTIME_LAYOUT_VERSION}`)
      && current.includes(`Runtime identity: ${runtimeIdentity}`)) {
      verifyFFmpegRuntime(cacheDir, platform, arch);
      return cacheDir;
    }
  }

  mkdirSync(join(cacheRoot, "dependencies", "ffmpeg"), { recursive: true });
  const tempRoot = mkdtempSync(join(tmpdir(), "resostage-ffmpeg-"));
  const staged = join(tempRoot, "package");
  mkdirSync(staged, { recursive: true });
  try {
    if (brewFFmpeg) {
      buildMacRuntime(staged, platformName, arch, brewFFmpeg);
    } else {
      const spec = packageSpec;
      if (!spec)
        throw new Error(`No bundled FFmpeg build is defined for ${platform}-${arch}`);
      const archive = join(tempRoot, spec.name);
      const url = spec.url ?? `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_RELEASE}/${spec.name}`;
      console.log(`Downloading pinned GPL FFmpeg runtime: ${spec.name}`);
      download(url, archive);
      ensureHash(archive, spec.sha256, "FFmpeg runtime package");
      const extracted = join(tempRoot, "extracted");
      mkdirSync(extracted, { recursive: true });
      run("tar", ["-xf", archive, "-C", extracted]);
      const binary = findNamedFile(extracted, executableName);
      if (!binary)
        throw new Error(`FFmpeg package did not contain ${executableName}`);
      cpSync(binary, join(staged, executableName));
      if (platform === "darwin") {
        // Intel upstream executables are unsigned. An ad-hoc cache signature
        // avoids repeated Rosetta/security assessment before the containing
        // app is later sealed with the application's signing identity.
        run("codesign", ["--force", "--sign", "-", "--timestamp=none", join(staged, executableName)], { stdio: "pipe" });
      }
      const binaryDir = binary.slice(0, binary.lastIndexOf(sep));
      // Preserve any platform libraries beside the exact helper. The selected
      // upstream static builds usually have no separate DLL/SO dependencies.
      for (const entry of readdirSync(binaryDir, { withFileTypes: true })) {
        if (entry.isFile() && /\.(dll|so(?:\.\d+)*)$/i.test(entry.name))
          cpSync(join(binaryDir, entry.name), join(staged, entry.name));
      }
      if (platform !== "darwin") copyLicenseFiles(extracted, join(staged, "licenses"));
      writeManifest(staged, platformName, arch, {
        extra: `Runtime supplier: ${platform === "darwin" ? "https://evermeet.cx/ffmpeg/" : "https://github.com/BtbN/FFmpeg-Builds"}\nRuntime package SHA-256: ${spec.sha256}\nRuntime package: ${url}`,
        identity: spec.sha256,
        ...(platform === "darwin" ? {} : { version: BTBN_VERSION, source: BTBN_SOURCE, sourceHash: null }),
      });
    }

    copyFFmpegLicenseTexts(tempRoot, staged);
    const versionInfo = verifyFFmpegRuntime(staged, platform, arch);
    if (versionInfo) writeFileSync(join(staged, "CONFIGURE.txt"), `${versionInfo}\n`);

    const target = join(cacheRoot, "dependencies", "ffmpeg", `${platformName}-${arch}`);
    rmSync(target, { recursive: true, force: true });
    cpSync(staged, target, { recursive: true });
    if (platform !== "win32")
      run("chmod", ["755", join(target, executableName)]);
    return target;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function installFFmpegRuntime(runtimeDirectory, executablePath, noticesDirectory) {
  const executableDirectory = dirname(executablePath);
  mkdirSync(executableDirectory, { recursive: true });
  cpSync(join(runtimeDirectory, executablePath.endsWith(".exe") ? "ffmpeg.exe" : "ffmpeg"), executablePath);
  for (const entry of readdirSync(runtimeDirectory, { withFileTypes: true })) {
    if (entry.isFile() && /\.(dll|so(?:\.\d+)*)$/i.test(entry.name))
      cpSync(join(runtimeDirectory, entry.name), join(executableDirectory, entry.name));
  }
  if (existsSync(join(runtimeDirectory, "lib")))
    cpSync(join(runtimeDirectory, "lib"), join(executableDirectory, "lib"), { recursive: true });
  rmSync(noticesDirectory, { recursive: true, force: true });
  mkdirSync(noticesDirectory, { recursive: true });
  if (existsSync(join(runtimeDirectory, "licenses")))
    cpSync(join(runtimeDirectory, "licenses"), join(noticesDirectory, "licenses"), { recursive: true });
  for (const name of ["BUILD.txt", "CONFIGURE.txt"])
    if (existsSync(join(runtimeDirectory, name)))
      cpSync(join(runtimeDirectory, name), join(noticesDirectory, name));
}
