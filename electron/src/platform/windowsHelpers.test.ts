/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { windowsHelperCandidates } from "@/platform/windowsHelpers.js";

const install = path.resolve("fixture", "ResoStage");
const repository = path.resolve("fixture", "repository");
const location = {
  shellExecutable: path.join(install, "resostage.exe"),
  resourcesDirectory: path.join(install, "resources"),
  sourceDirectory: path.join(repository, "electron", "dist", "platform"),
  workingDirectory: repository,
  architecture: "arm64",
};

describe("Windows helper discovery", () => {
  it("prefers the packaged core directory and retains legacy grouped/raw paths", () => {
    const candidates = windowsHelperCandidates(["core.exe"], location);
    expect(candidates[0]).toBe(path.join(install, "core", "core.exe"));
    expect(candidates).toContain(path.join(install, "helpers", "core.exe"));
    expect(candidates).toContain(path.join(install, "core.exe"));
    expect(candidates).toContain(path.join(repository, "build", "win", "arm64", "helpers", "core.exe"));
    expect(candidates).toContain(path.join(repository, "build", "win", "arm64", "core", "core.exe"));
    expect(candidates).toContain(path.join(repository, "core", "build", "app", "ResoStage_artefacts", "Debug", "core.exe"));
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates.every(path.isAbsolute)).toBe(true);
  });

  it("resolves Kaishaku in the same layout and cannot recursively spawn the shell", () => {
    expect(windowsHelperCandidates(["kaishaku.exe"], location)[0])
      .toBe(path.join(install, "core", "kaishaku.exe"));
    const candidates = windowsHelperCandidates(["core.exe", "ResoStage.exe"], location);
    expect(candidates.map((candidate) => candidate.toLowerCase()))
      .not.toContain(location.shellExecutable.toLowerCase());
  });
});
