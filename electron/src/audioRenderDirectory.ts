/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import path from "node:path";

interface RenderDirectorySession {
  remote: boolean;
  backend: string;
}

interface RenderDirectorySelection {
  canceled: boolean;
  filePaths: string[];
}

/** Main-process only. A native folder belongs to the controller computer, so
 * the current Core must remain local throughout the asynchronous dialog. */
export async function chooseAudioRenderDirectory(
  defaultPath: unknown,
  currentSession: () => RenderDirectorySession,
  pickDirectory: (defaultPath?: string) => Promise<RenderDirectorySelection>,
): Promise<string | null> {
  const before = currentSession();
  if (before.remote)
    throw new Error("Choose an output folder on the remote Core machine by entering its path.");
  if (defaultPath !== undefined && typeof defaultPath !== "string")
    throw new Error("The initial output folder must be a path string.");
  const initialPath = typeof defaultPath === "string" && defaultPath.length > 0
    ? defaultPath : undefined;
  if (initialPath && (!path.isAbsolute(initialPath) || initialPath.includes("\0")))
    throw new Error("The initial output folder must be an absolute path.");

  const selection = await pickDirectory(initialPath);
  const after = currentSession();
  if (after.remote || after.backend !== before.backend)
    throw new Error("The active Core changed while choosing the output folder. Choose the destination again.");
  if (selection.canceled || selection.filePaths.length === 0) return null;
  const selected = selection.filePaths[0];
  if (!path.isAbsolute(selected) || selected.includes("\0"))
    throw new Error("The selected output folder must be an absolute path.");
  return selected;
}
