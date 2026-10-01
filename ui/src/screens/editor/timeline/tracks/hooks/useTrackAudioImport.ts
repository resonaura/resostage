// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useRef, type ChangeEvent } from "react";
import { builder } from "@/lib/state/api";
import { IS_EMBEDDED } from "@/lib/platform/embedded";

interface PendingTrackImport {
  songIndex: number;
  trackIndex: number;
}

/** Owns the native-dialog/browser-file-input split for empty audio lanes. */
export function useTrackAudioImport() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingImportRef = useRef<PendingTrackImport | null>(null);

  const openTrackAudioImport = (songIndex: number, trackIndex: number) => {
    // Embedded in the native app's webview: pop the OS's own "Open Audio
    // File" dialog through Core (shows up in the same window, matches
    // project.loadDialog). A plain browser tab has no native window to show
    // the dialog in, so it keeps the <input type=file> upload fallback.
    if (IS_EMBEDDED) {
      void builder.trackImportWavDialog(songIndex, trackIndex);
      return;
    }
    pendingImportRef.current = { songIndex, trackIndex };
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    const pending = pendingImportRef.current;
    pendingImportRef.current = null;
    if (!file || !pending) return;
    void builder.trackImportWav(pending.songIndex, pending.trackIndex, file);
  };

  return { fileInputRef, openTrackAudioImport, handleFileChange };
}
