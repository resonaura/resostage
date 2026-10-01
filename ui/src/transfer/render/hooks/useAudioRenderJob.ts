/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useRef, useState } from "react";
import {
  audioRender,
  type AudioRenderOptions,
  type AudioRenderStatus,
} from "@/lib/state/api";

const initialStatus: AudioRenderStatus = {
  state: "rendering",
  phase: "preparing",
  progress: 0,
  outputPath: "",
  outputPaths: [],
  error: "",
};

/** Owns the API lifecycle and status polling for the app-wide audio renderer. */
export function useAudioRenderJob(
  open: boolean,
  requestId: number,
  activeSongIndex: number,
) {
  const [status, setStatus] = useState<AudioRenderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appliedRequestId = useRef(-1);

  useEffect(() => {
    if (!open || appliedRequestId.current === requestId) return;
    appliedRequestId.current = requestId;
    setStatus(null);
    setError(null);
  }, [open, requestId]);

  useEffect(() => {
    if (!open || status?.state !== "rendering") return;
    const timer = setInterval(() => {
      void audioRender
        .status()
        .then(setStatus)
        .catch((reason) => setError(String(reason)));
    }, 350);
    return () => clearInterval(timer);
  }, [open, status?.state]);

  useEffect(() => {
    if (!open) return;
    void audioRender
      .status()
      .then((nextStatus) => {
        if (nextStatus.state !== "idle") setStatus(nextStatus);
      })
      .catch(() => {});
  }, [open, activeSongIndex]);

  const start = async (options: AudioRenderOptions) => {
    setError(null);
    try {
      await audioRender.start(options);
      setStatus(initialStatus);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const cancel = async () => {
    try {
      await audioRender.cancel();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return {
    status,
    error,
    clearError: () => setError(null),
    setError,
    start,
    cancel,
  };
}
