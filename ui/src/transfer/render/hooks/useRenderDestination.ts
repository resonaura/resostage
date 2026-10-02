/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getRemoteBackend, onBackendChange } from "@/lib/state/backend";
import "@/lib/platform/electron";

/** Folder selection is controller-local only for a local Core. Remote/browser
 * clients enter a Core-machine path. Late dialogs cannot alter another request. */
export function useRenderDestination(open: boolean, requestId: number, rememberedDirectory = "") {
  const [directory, setDirectory] = useState(rememberedDirectory);
  const [localSession, setLocalSession] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const savedDirectory = useRef(rememberedDirectory);
  savedDirectory.current = rememberedDirectory;
  const invalidateRequest = useCallback(() => { ++generation.current; }, []);

  useEffect(() => {
    const current = ++generation.current;
    setChoosing(false);
    setError(null);
    setLocalSession(false);
    if (open) {
      // Telemetry refreshes must not overwrite a path the user is editing.
      setDirectory(savedDirectory.current);
      const bridge = window.resostageElectron;
      if (bridge?.isElectron && bridge.chooseAudioRenderDirectory && bridge.getRemoteStatus) {
        void bridge.getRemoteStatus().then((status) => {
          if (generation.current === current) setLocalSession(!status.isRemoteMode);
        }).catch(() => {}); // Unknown ownership fails closed to manual Core paths.
      }
    }
    return invalidateRequest;
  }, [open, requestId, invalidateRequest]);

  useEffect(() => {
    if (!open) return;
    return onBackendChange(() => {
      ++generation.current;
      setChoosing(false);
      setLocalSession(false);
      setDirectory("");
      setError("The active Core changed. Confirm the destination on that computer before exporting.");
      // A prior Core's folder preference must not leak into the new session.
    });
  }, [open]);

  const canBrowse = localSession && !getRemoteBackend();
  const chooseDirectory = async () => {
    const bridge = window.resostageElectron;
    if (!canBrowse || choosing || !bridge?.chooseAudioRenderDirectory) return;
    const current = generation.current;
    setChoosing(true);
    setError(null);
    try {
      // Main verifies ownership again before and after the native dialog.
      const selected = await bridge.chooseAudioRenderDirectory(directory || undefined);
      if (generation.current === current && selected !== null) setDirectory(selected);
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation.current === current) setChoosing(false);
    }
  };

  return {
    directory, canBrowse, choosing, error, chooseDirectory,
    setDirectory: (value: string) => { setDirectory(value); setError(null); },
  };
}
