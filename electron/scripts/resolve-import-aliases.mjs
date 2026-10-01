/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const emittedExtensions = [".js", ".mjs", ".cjs"];
const sourceToEmittedExtension = new Map([
  [".ts", ".js"],
  [".tsx", ".js"],
  [".mts", ".mjs"],
  [".cts", ".cjs"],
]);
const aliasImportPattern = /(\bfrom\s*|\bimport\s*(?:\(\s*)?)(["'])(@\/[^"']+)\2/g;

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function findEmittedTarget(outputRoot, aliasSpecifier) {
  const suffixStart = aliasSpecifier.search(/[?#]/);
  const aliasPath = suffixStart < 0 ? aliasSpecifier : aliasSpecifier.slice(0, suffixStart);
  const suffix = suffixStart < 0 ? "" : aliasSpecifier.slice(suffixStart);
  const targetBase = path.resolve(outputRoot, aliasPath.slice(2).replaceAll("/", path.sep));

  if (!isInside(outputRoot, targetBase)) {
    throw new Error(`Import alias escapes the Electron output directory: ${aliasSpecifier}`);
  }

  const sourceExtension = path.extname(targetBase);
  const emittedExtension = sourceToEmittedExtension.get(sourceExtension);
  const candidates = sourceExtension
    ? [emittedExtension ? targetBase.slice(0, -sourceExtension.length) + emittedExtension : targetBase]
    : [
        ...emittedExtensions.map((extension) => targetBase + extension),
        ...emittedExtensions.map((extension) => path.join(targetBase, `index${extension}`)),
      ];

  const target = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!target) {
    throw new Error(`Cannot resolve Electron import alias ${aliasSpecifier} from emitted output ${outputRoot}`);
  }

  return { target, suffix };
}

/**
 * Rewrites TypeScript path aliases in emitted ESM to explicit relative file
 * specifiers. Node executes Electron's tsc output directly, so this step is
 * required after typechecking and before the shell is packaged.
 */
export function resolveImportAliases(outputDirectory) {
  const outputRoot = path.resolve(outputDirectory);
  let rewrittenModules = 0;

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (!entry.isFile() || !emittedExtensions.includes(path.extname(file))) continue;

      const source = readFileSync(file, "utf8");
      const updated = source.replace(aliasImportPattern, (match, prefix, quote, specifier) => {
        const { target, suffix } = findEmittedTarget(outputRoot, specifier);
        let relative = path.relative(path.dirname(file), target).split(path.sep).join("/");
        if (!relative.startsWith(".")) relative = `./${relative}`;
        return `${prefix}${quote}${relative}${suffix}${quote}`;
      });

      if (updated !== source) {
        writeFileSync(file, updated);
        rewrittenModules += 1;
      }
    }
  };

  visit(outputRoot);
  return rewrittenModules;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const outputDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
  const count = resolveImportAliases(outputDirectory);
  process.stdout.write(`Resolved @/ imports in ${count} emitted Electron module(s).\n`);
}
