import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Root = path.resolve(__dirname, "../../..");
const SrcDir = path.join(Root, "native", "mac");
const OutDir = path.join(Root, "dist");

const Modules = {
  MenuFlash: "MenuFlash.m",
  Haptics: "Haptics.m",
};

const isDarwin = process.platform === "darwin";

if (!isDarwin) {
  console.log("skip native mac modules (not darwin)");
  process.exit(0);
}

mkdirSync(OutDir, { recursive: true });

for (const legacy of ["mac_menu_flash.dylib", "MacMenuFlash.dylib"]) {
  const p = path.join(OutDir, legacy);
  if (existsSync(p)) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

const Arch = process.arch === "arm64" ? "arm64" : "x86_64";

for (const [name, srcFile] of Object.entries(Modules)) {
  const Src = path.join(SrcDir, srcFile);
  const Out = path.join(OutDir, `${name}.dylib`);
  if (!existsSync(Src)) {
    console.error("missing", Src);
    process.exit(1);
  }
  execFileSync(
    "clang",
    [
      "-dynamiclib",
      "-fobjc-arc",
      "-arch",
      Arch,
      "-mmacosx-version-min=11.0",
      "-framework",
      "AppKit",
      "-framework",
      "Foundation",
      "-o",
      Out,
      Src,
    ],
    { stdio: "inherit" },
  );
  console.log("built", Out);
}