/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Spinner } from "@heroui/react";
import { ConfirmDialog } from "@/shell/dialogs/components/ConfirmDialog";
import { project } from "@/lib/state/api";
import type { WebUiState } from "@/lib/state/types";

export function QuitOverlay({ open }: { open: boolean }) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-10000 flex items-center justify-center bg-background/50 backdrop-blur-xl transition-all duration-300 animate-in fade-in ease-out pointer-events-auto"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <div className="flex flex-col items-center gap-4 text-foreground select-none">
        <Spinner size="lg" color="current" className="text-foreground" />
      </div>
    </div>
  );
}

// Native quit was requested while the project has unsaved changes --
// MainComponent::confirmQuitIfUnsaved() is blocked waiting on our answer
// (see WebUiState.quitConfirmPending / WebCommandKind::QuitDecision). Only
// meaningful when embedded in the app's own webview; a plain LAN browser tab
// can still see this state but has no window to actually quit.
export function QuitConfirmDialog({
  state,
  onStartQuitting,
}: {
  state: WebUiState;
  onStartQuitting: () => void;
}) {
  const isRemote = (() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    return (
      params.has("remote") ||
      (window.location.hostname !== "localhost" &&
        window.location.hostname !== "127.0.0.1")
    );
  })();

  if (isRemote) return null;

  return (
    <ConfirmDialog
      open={state.quitConfirmPending}
      title="Unsaved Changes"
      message={`Do you want to save changes to '${state.projectName || "Untitled Project"}' before quitting?`}
      confirmLabel="Save"
      cancelLabel="Cancel"
      thirdLabel="Don't Save"
      danger
      onConfirm={() => {
        onStartQuitting();
        void project.resolveQuit("save");
      }}
      onThird={() => {
        onStartQuitting();
        void project.resolveQuit("discard");
      }}
      onCancel={() => void project.resolveQuit("cancel")}
    />
  );
}

// A project was opened from Finder/Explorer while the current project has
// unsaved changes -- MainComponent::openProjectFromIpc() is blocked waiting on
// our answer (see WebUiState.openConfirmPending / WebCommandKind::OpenDecision).
// Mirror of QuitConfirmDialog with open-specific wording.
export function OpenConfirmDialog({ state }: { state: WebUiState }) {
  return (
    <ConfirmDialog
      open={state.openConfirmPending}
      title="Unsaved Changes"
      message={`Do you want to save changes to '${state.projectName || "Untitled Project"}' before opening another project?`}
      confirmLabel="Save"
      cancelLabel="Cancel"
      thirdLabel="Don't Save"
      danger
      onConfirm={() => void project.resolveOpen("save")}
      onThird={() => void project.resolveOpen("discard")}
      onCancel={() => void project.resolveOpen("cancel")}
    />
  );
}
