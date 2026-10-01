/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

/**
 * Factory for Build Platform Adapter.
 *
 * Encapsulates all OS-specific build assembly, PE metadata icon patching,
 * installer generation, and process liquidation behind a unified adapter interface.
 */

import { MacBuildAdapter } from "./MacBuildAdapter.mjs";
import { WinBuildAdapter } from "./WinBuildAdapter.mjs";
import { LinuxBuildAdapter } from "./LinuxBuildAdapter.mjs";

export function createBuildAdapter() {
  switch (process.platform) {
    case "darwin":
      return new MacBuildAdapter();
    case "win32":
      return new WinBuildAdapter();
    case "linux":
      return new LinuxBuildAdapter();
    default:
      throw new Error(`Unsupported platform for build adapter: ${process.platform}`);
  }
}

export { BuildAdapter } from "./BuildAdapter.mjs";
export { MacBuildAdapter } from "./MacBuildAdapter.mjs";
export { WinBuildAdapter, WinBuildAdapter as WindowsBuildAdapter } from "./WinBuildAdapter.mjs";
export { LinuxBuildAdapter } from "./LinuxBuildAdapter.mjs";
