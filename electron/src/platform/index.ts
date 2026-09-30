// Factory for the platform adapter. main.mts calls this once and never touches
// process.platform again -- platform differences are behind PlatformAdapter.

import { PlatformAdapter, type PlatformContext } from "@/platform/PlatformAdapter.js";
import { MacPlatformAdapter } from "@/platform/MacPlatformAdapter.js";
import { WindowsPlatformAdapter } from "@/platform/WindowsPlatformAdapter.js";
import { LinuxPlatformAdapter } from "@/platform/LinuxPlatformAdapter.js";

export function createPlatformAdapter(
  context: PlatformContext,
): PlatformAdapter {
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

export { PlatformAdapter } from "@/platform/PlatformAdapter.js";
export type {
  PlatformContext,
  PlatformInput,
  PlatformMenuSections,
} from "@/platform/PlatformAdapter.js";
export { MacPlatformAdapter } from "@/platform/MacPlatformAdapter.js";
export {
  WindowsPlatformAdapter,
  WindowsPlatformAdapter as WinPlatformAdapter,
} from "@/platform/WindowsPlatformAdapter.js";
export { LinuxPlatformAdapter } from "@/platform/LinuxPlatformAdapter.js";
