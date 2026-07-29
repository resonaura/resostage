#!/usr/bin/env node
// Regenerates app/web/EmbeddedAssets.h from the last `pnpm build` output
// (webui/dist/, a normal multi-file Vite build -- index.html + hashed
// assets/*.js + assets/*.css, plus whatever images/fonts/etc. get added
// later). Walks the whole dist/ tree and embeds every file under its real
// path; WebServer::serveStatic() looks each one up and serves it with the
// matching MIME type instead of always returning one blob for every path.
//
// Run manually after `pnpm build` (`pnpm build:embed` does both) -- this is
// a local dev-workflow step, not part of the CMake build graph, so the C++
// build never needs Node/pnpm to be present (the shipped binary embeds
// whatever the developer last built and committed).
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, relative, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const outPath = join(here, "..", "..", "app", "web", "EmbeddedAssets.h");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
// Embedded as C++ raw string literals (compact, human-diffable). Everything
// else (images, fonts, ...) is embedded as a byte array instead, since raw
// strings can't safely hold arbitrary binary (embedded NULs, no length other
// than strlen, delimiter collisions with binary noise).
const TEXT_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".map", ".txt"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function pickDelimiter(source, used) {
  const candidates = ["HTML", "JS", "CSS", "TXT", "ASSET0", "ASSET1", "ASSET2", "ASSET3"];
  for (const d of candidates) {
    if (used.has(d)) continue;
    if (!source.includes(`)${d}"`)) return d;
  }
  throw new Error("Could not find a safe raw-string delimiter for an embedded asset.");
}

function identifierFor(index) {
  return `kAssetData${index}`;
}

const files = walk(distDir);
if (files.length === 0) {
  console.error(`No files found in ${distDir} -- run "pnpm build" first.`);
  process.exit(1);
}

const usedDelimiters = new Set();
const dataDecls = [];
const manifestEntries = [];

files.forEach((absPath, i) => {
  const relPath = "/" + relative(distDir, absPath).split(sep).join("/");
  const ext = extname(absPath).toLowerCase();
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";
  const ident = identifierFor(i);

  if (TEXT_EXTENSIONS.has(ext)) {
    const text = readFileSync(absPath, "utf8");
    const delim = pickDelimiter(text, usedDelimiters);
    usedDelimiters.add(delim);
    dataDecls.push(
      `#if defined(__clang__) || defined(__GNUC__)\n#pragma GCC diagnostic push\n#pragma GCC diagnostic ignored "-Woverlength-strings"\n#endif\ninline constexpr char ${ident}[] = R"${delim}(${text})${delim}";\n#if defined(__clang__) || defined(__GNUC__)\n#pragma GCC diagnostic pop\n#endif`
    );
    manifestEntries.push(`    { "${relPath}", "${mime}", ${ident}, sizeof(${ident}) - 1 },`);
  } else {
    // Plain `char` array, not `unsigned char*` -- reinterpret_cast isn't a
    // constant expression, so mixing char/unsigned char pointer types here
    // would make kAssets fail to compile as constexpr. Emit each byte as a
    // decimal literal already in signed-char range (two's-complement) so
    // the initializer needs no cast at all.
    const bytes = readFileSync(absPath);
    const values = Array.from(bytes)
      .map((b) => (b > 127 ? b - 256 : b))
      .join(",");
    dataDecls.push(`inline constexpr char ${ident}[] = {${values}};`);
    manifestEntries.push(`    { "${relPath}", "${mime}", ${ident}, sizeof(${ident}) },`);
  }
});

const header = `#pragma once

// Static assets served from the embedded WebServer -- GENERATED FILE, do not
// hand-edit. Regenerate with:
//   cd webui && pnpm build && node scripts/embed.mjs
// (or \`pnpm build:embed\` for both in one step)
//
// Source: webui/ (pnpm + vite + react + typescript + heroui v3 + tailwind
// v4 + framer-motion + lucide-react). Dev workflow: MainComponent's
// embedded webview tries http://localhost:2900 (the Vite dev server) first
// and falls back to this baked-in build when that's unreachable.

#include <cstddef>

namespace resostage {
namespace embedded_assets {

${dataDecls.join("\n\n")}

struct Asset {
    const char* path;
    const char* mimeType;
    const char* data;
    std::size_t length;
};

inline constexpr Asset kAssets[] = {
${manifestEntries.join("\n")}
};
inline constexpr std::size_t kAssetCount = sizeof(kAssets) / sizeof(kAssets[0]);

inline constexpr const char* kIndexHtmlPath = "/index.html";

} // namespace embedded_assets
} // namespace resostage
`;

writeFileSync(outPath, header, "utf8");
const totalKb = files.reduce((sum, f) => sum + statSync(f).size, 0) / 1024;
console.log(`Wrote ${outPath} (${files.length} asset(s), ${totalKb.toFixed(1)} KB total)`);
