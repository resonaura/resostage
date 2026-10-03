/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

export type ProjectSaveLabel = "Save" | "Saving…" | "Saved";

/** Only save-specific Core statuses may change the Save button label. */
export function projectSaveLabel(statusMessage: string | undefined): ProjectSaveLabel {
  if (/^Saving\b/i.test(statusMessage ?? "")) return "Saving…";
  if (/^Saved\b/i.test(statusMessage ?? "")) return "Saved";
  return "Save";
}
