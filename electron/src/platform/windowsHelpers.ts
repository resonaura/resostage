/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import path from "node:path";

export interface WindowsHelperLocation {
  shellExecutable: string;
  resourcesDirectory: string;
  sourceDirectory: string;
  workingDirectory: string;
  architecture: string;
}

/** Packaged siblings first, then legacy packages and raw developer artefacts.
 * Paths remain absolute; discovery never depends on a system-installed helper.
 */
export function windowsHelperCandidates(names: readonly string[], location: WindowsHelperLocation): string[] {
  const { shellExecutable, resourcesDirectory, sourceDirectory, workingDirectory, architecture } = location;
  const roots = [path.dirname(shellExecutable), path.resolve(resourcesDirectory, "..")];
  const repository = path.resolve(sourceDirectory, "..", "..", "..");
  const devRoots = [...new Set([architecture, "x64", "arm64"])].flatMap((arch) => [
    path.join(repository, "build", "win", arch),
    path.join(workingDirectory, "build", "win", arch),
  ]);
  const directories = [
    ...roots.map((root) => path.join(root, "helpers")),
    ...roots,
    resourcesDirectory,
    ...devRoots.flatMap((root) => [path.join(root, "helpers"), root]),
    ...["RelWithDebInfo", "Debug"].map((config) =>
      path.join(workingDirectory, "core", "build", "app", "ResoStage_artefacts", config)),
    path.join(workingDirectory, "core", "build", "app"),
  ];
  const shellPath = path.resolve(shellExecutable).toLowerCase();
  // An old Core name differs from resostage.exe only by case. Never treat
  // the current shell as a missing-Core fallback on a case-insensitive drive.
  return [...new Set(directories.flatMap((directory) => names.map((name) => path.join(directory, name))))]
    .filter((candidate) => path.resolve(candidate).toLowerCase() !== shellPath);
}
