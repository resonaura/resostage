/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

export interface RemoteProjectExportStatus {
  fileName?: string;
}

export interface RemoteProjectSaveAsDependencies {
  startExport(): Promise<{ ok: boolean; status: number }>;
  waitForExport(): Promise<RemoteProjectExportStatus | null>;
  chooseDestination(defaultPath: string): Promise<{
    canceled: boolean;
    filePath?: string;
  }>;
  downloadExport(): Promise<{ ok: boolean; status: number; bytes?: Uint8Array }>;
  writeFile(path: string, bytes: Uint8Array): void;
  showError(title: string, message: string): Promise<unknown>;
  cancelPendingSaveAs(): Promise<unknown>;
}

/**
 * Runs remote Save As as an export to the controller, not a Core path change.
 * Core's Save As callback must therefore receive a cancellation request on
 * every terminal path, including dialog cancellation, network errors and a
 * successful download. A disconnected remote Core cannot acknowledge it.
 */
export async function exportRemoteProjectAs(
  dependencies: RemoteProjectSaveAsDependencies,
): Promise<void> {
  const showError = async (title: string, message: string): Promise<void> => {
    try {
      await dependencies.showError(title, message);
    } catch {
      // Native message-box failure must not prevent settling Core's callback.
    }
  };

  try {
    const exportResult = await dependencies.startExport();
    if (!exportResult.ok) {
      await showError(
        "Remote export failed",
        `The remote host could not start an export (HTTP ${exportResult.status}).`,
      );
      return;
    }

    const ready = await dependencies.waitForExport();
    if (!ready) {
      await showError(
        "Remote export failed",
        "The remote host did not finish exporting the project in time.",
      );
      return;
    }

    const selection = await dependencies.chooseDestination(
      ready.fileName || "Project.rsnraset",
    );
    if (selection.canceled || !selection.filePath) return;

    const download = await dependencies.downloadExport();
    if (!download.ok) {
      await showError(
        "Download failed",
        `Could not download the exported project (HTTP ${download.status}).`,
      );
      return;
    }

    dependencies.writeFile(selection.filePath, download.bytes ?? new Uint8Array());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await showError("Remote project Save As failed", detail);
  } finally {
    try {
      // This flow writes on the controller and intentionally never adopts the
      // controller's path as the authoritative project path on the remote Core.
      await dependencies.cancelPendingSaveAs();
    } catch {
      // The remote Core may already be unreachable; it cannot be settled here.
    }
  }
}
