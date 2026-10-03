/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { EditorMutationOutcome } from "@/lib/state/api";
import type { AutomationGestureCommitPayload } from "@/screens/editor/timeline/automation/logic/automationTouchController";

const STORAGE_KEY = "resostage:automation-gesture-recovery:v1";
const MAX_DRAFTS = 4;
const MAX_STORED_BYTES = 2 * 1024 * 1024;
const MAX_GESTURE_POINTS = 65_536;

export interface AutomationGestureRecoveryDraft {
  id: string;
  projectIdentity: string;
  songIndex: number;
  createdAt: number;
  outcome: EditorMutationOutcome;
  error: string;
  payload: AutomationGestureCommitPayload;
  persisted: boolean;
}

interface StoredDraft extends Omit<AutomationGestureRecoveryDraft, "persisted"> {}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isGesturePayload(value: unknown): value is AutomationGestureCommitPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<AutomationGestureCommitPayload>;
  return typeof payload.laneId === "string"
    && typeof payload.gestureId === "string"
    && typeof payload.writeMode === "string"
    && isFiniteNumber(payload.punchInBeats)
    && isFiniteNumber(payload.releaseBeats)
    && isFiniteNumber(payload.releaseValue)
    && isFiniteNumber(payload.returnRampBeats)
    && isFiniteNumber(payload.underlyingValue)
    && typeof payload.pointsCompacted === "boolean"
    && typeof payload.shouldRevertWriteMode === "boolean"
    && Array.isArray(payload.points)
    && payload.points.length <= MAX_GESTURE_POINTS
    && payload.points.every((point) => point
      && isFiniteNumber(point.timeBeats) && isFiniteNumber(point.value));
}

function isStoredDraft(value: unknown): value is StoredDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<StoredDraft>;
  return typeof draft.id === "string"
    && typeof draft.projectIdentity === "string"
    && draft.projectIdentity.length <= 512
    && Number.isSafeInteger(draft.songIndex)
    && (draft.songIndex ?? -1) >= 0
    && isFiniteNumber(draft.createdAt)
    && (draft.outcome === "not-sent" || draft.outcome === "rejected"
      || draft.outcome === "unknown" || draft.outcome === "stored")
    && typeof draft.error === "string"
    && isGesturePayload(draft.payload);
}

function storageOrNull(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Reads only the versioned, count- and byte-bounded session recovery queue. */
export function loadAutomationGestureDrafts(): AutomationGestureRecoveryDraft[] {
  const storage = storageOrNull();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw || new TextEncoder().encode(raw).byteLength > MAX_STORED_BYTES) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredDraft).slice(-MAX_DRAFTS).map((draft) => ({
      ...draft,
      persisted: true,
    }));
  } catch {
    return [];
  }
}

/**
 * Persists drafts only if the complete snapshot fits the hard session-storage
 * budget. Callers still keep the latest draft in bounded memory and expose an
 * export action when browser storage is unavailable or full.
 */
export function persistAutomationGestureDrafts(
  drafts: readonly AutomationGestureRecoveryDraft[],
): boolean {
  const storage = storageOrNull();
  if (!storage || drafts.length > MAX_DRAFTS) return false;
  const serializable: StoredDraft[] = drafts.map(({ persisted: _persisted, ...draft }) => draft);
  const raw = JSON.stringify(serializable);
  if (new TextEncoder().encode(raw).byteLength > MAX_STORED_BYTES) return false;
  try {
    storage.setItem(STORAGE_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

/** Clears stale safe-to-retry markers before a retry is sent. */
export function clearAutomationGestureDraftStorage(): void {
  const storage = storageOrNull();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // The live renderer copy remains available for export and is marked volatile.
  }
}

/** Removes a draft by its local recovery identity without changing the project. */
export function removeAutomationGestureDraft(
  drafts: readonly AutomationGestureRecoveryDraft[],
  id: string,
): AutomationGestureRecoveryDraft[] {
  return drafts.filter((draft) => draft.id !== id);
}

export const automationGestureRecoveryLimits = {
  drafts: MAX_DRAFTS,
  storedBytes: MAX_STORED_BYTES,
  pointsPerGesture: MAX_GESTURE_POINTS,
} as const;
