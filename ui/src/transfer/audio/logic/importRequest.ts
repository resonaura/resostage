/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { apiFetch, backendOrigin, type ApiResponse } from "@/lib/state/backend";
import { MAXIMUM_MEDIA_FILE_BYTES } from "@/transfer/audio/logic/mediaFormats";

interface MediaImportStatus {
  finished: boolean;
  success: boolean;
  error: string;
}

async function requireSuccess(response: ApiResponse): Promise<void> {
  if (response.ok) return;
  const payload = await response.json<{ error?: string }>().catch(() => ({}));
  throw new Error("error" in payload && payload.error ? payload.error : `Media import failed (${response.status})`);
}

/** Resolves only after Core commits the imported resource and region. */
export async function importMediaFile(songIndex: number, trackIndex: number, file: File, startSeconds = 0): Promise<void> {
  if (file.size > MAXIMUM_MEDIA_FILE_BYTES) throw new Error("Media file exceeds the 20 GiB limit");
  const origin = backendOrigin();
  const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (value) => value.toString(16).padStart(2, "0")).join("");
  const checkOrigin = () => {
    if (backendOrigin() !== origin) throw new Error("The active Core changed during media import");
  };
  await requireSuccess(await apiFetch("/api/v1/builder/track/import-wav/begin", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ songIndex, index: trackIndex, fileName: file.name, startSeconds, requestId }),
  }));
  checkOrigin();
  await requireSuccess(await apiFetch(`/api/v1/builder/track/import-wav/upload?requestId=${requestId}`, {
    method: "POST", body: file,
  }));
  const deadline = Date.now() + 7 * 60 * 60 * 1000;
  let delayMilliseconds = 250;
  while (Date.now() < deadline) {
    checkOrigin();
    const response = await apiFetch(`/api/v1/builder/track/import-status?requestId=${requestId}`);
    await requireSuccess(response);
    const status = await response.json<MediaImportStatus>();
    if (status.finished) {
      if (!status.success) throw new Error(status.error || "Media import failed");
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMilliseconds));
    delayMilliseconds = Math.min(1000, delayMilliseconds * 2);
  }
  throw new Error("Media import completion timed out");
}
