// Factory for the platform adapter. main.mts calls this once and never touches
// process.platform again -- platform differences are behind PlatformAdapter.

import { PlatformAdapter, type PlatformContext } from "./PlatformAdapter.js";
import { MacPlatformAdapter } from "./MacPlatformAdapter.js";
import { WindowsPlatformAdapter } from "./WindowsPlatformAdapter.js";
import { LinuxPlatformAdapter } from "./LinuxPlatformAdapter.js";

export function createPlatformAdapter(context: PlatformContext): PlatformAdapter {
  switch (process.platform) {
    case "darwin":
      return new MacPlatformAdapter(context);
    case "win32":
      return new WindowsPlatformAdapter(context);
    case "linux":
      return new LinuxPlatformAdapter(context);
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

export { PlatformAdapter } from "./PlatformAdapter.js";
export type { PlatformContext, PlatformInput, PlatformMenuSections } from "./PlatformAdapter.js";
export { MacPlatformAdapter } from "./MacPlatformAdapter.js";
export { WindowsPlatformAdapter } from "./WindowsPlatformAdapter.js";
export { LinuxPlatformAdapter } from "./LinuxPlatformAdapter.js";
