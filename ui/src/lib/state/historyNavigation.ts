/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { ApiResponse } from "@/lib/state/backend";
import type { WebUiState } from "@/lib/state/types";

export type HistoryDirection = "undo" | "redo";
export interface HistoryNavigationState { pending: boolean; error: string | null }
const navigationListeners = new Set<() => void>();
const boundaryListeners = new Set<() => void>();
let navigationState: HistoryNavigationState = { pending: false, error: null };

/** Used by optimistic controls to release ownership at a history boundary. */
export function subscribeHistoryBoundary(listener: () => void): () => void {
  boundaryListeners.add(listener);
  return () => { boundaryListeners.delete(listener); };
}
export function subscribeHistoryNavigation(listener: () => void): () => void {
  navigationListeners.add(listener);
  return () => { navigationListeners.delete(listener); };
}
export function getHistoryNavigationState(): HistoryNavigationState { return navigationState; }
export function dismissHistoryError(): void { publishNavigation({ ...navigationState, error: null }); }
function publishNavigation(next: HistoryNavigationState): void {
  navigationState = next;
  navigationListeners.forEach((listener) => listener());
}

export interface HistoryNavigationDependencies {
  fetch: (path: string, init?: RequestInit) => Promise<ApiResponse>;
  origin: () => string;
  prepare: () => Promise<void>;
  serialize: <T>(command: () => Promise<T>, payloadBytes: number) => Promise<T>;
  projectIdentity?: () => { origin: string; stateSessionId: string; projectEpoch: number } | null;
  applySnapshot: (snapshot: Partial<WebUiState>) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * One shared navigation path for menus, keyboard shortcuts, and toolbars.
 * HTTP admission is not completion: wait for the matching Core-session ACK
 * in the restored structural snapshot. Never retry the POST after timeout;
 * it may already be queued and a replay would apply history twice.
 */
export function createHistoryNavigator(dependencies: HistoryNavigationDependencies) {
  let queued = 0;
  let tail: Promise<void> = Promise.resolve();
  const sleep = dependencies.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;
  const timeoutMs = dependencies.timeoutMs ?? 30_000;
  return (direction: HistoryDirection): Promise<void> => {
    // Key-repeat cannot create an unbounded pending history queue.
    if (queued >= 100) {
      publishNavigation({ pending: queued > 0, error: "Too many pending history actions. Wait for Core to finish." });
      return Promise.resolve();
    }
    ++queued;
    publishNavigation({ pending: true, error: null });
    const execute = async () => {
      const origin = dependencies.origin();
      const deadline = now() + timeoutMs;
      const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            operation(),
            new Promise<T>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error(
                "Core did not confirm history before the timeout. The action may still be queued; do not resend blindly.",
              )), Math.max(0, deadline - now()));
            }),
          ]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
      };
      await bounded(dependencies.prepare);
      boundaryListeners.forEach((listener) => listener());
      const projectIdentity = dependencies.projectIdentity?.() ?? null;
      await dependencies.serialize(async () => {
        if (dependencies.origin() !== origin) throw new Error("Core changed before the history action was sent.");
        if (projectIdentity && projectIdentity.origin !== origin)
          throw new Error("Core changed before the history action was sent.");
        const response = await bounded(() => dependencies.fetch(`/api/v1/timeline/${direction}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(projectIdentity ? {
              "X-ResoStage-Session": projectIdentity.stateSessionId,
              "X-ResoStage-Project-Epoch": String(projectIdentity.projectEpoch),
            } : {}),
          },
          body: "{}",
        }));
        if (!response.ok) throw new Error(`Core rejected ${direction} (HTTP ${response.status}).`);
        const accepted = await bounded(() => response.json()) as {
          historyRequestId?: number;
          stateSessionId?: string;
          projectEpoch?: number;
        };
        if (!Number.isSafeInteger(accepted.historyRequestId) || !accepted.stateSessionId)
          throw new Error("Core did not acknowledge this history action. Update Core and retry.");
        if (projectIdentity && (accepted.stateSessionId !== projectIdentity.stateSessionId
          || accepted.projectEpoch !== projectIdentity.projectEpoch))
          throw new Error("Core project changed before the history action was sent.");
        while (now() <= deadline) {
          if (dependencies.origin() !== origin) throw new Error("Core changed while applying the history action.");
          const stateResponse = await bounded(() => dependencies.fetch("/api/v1/state"));
          if (!stateResponse.ok) throw new Error(`Cannot confirm ${direction} (HTTP ${stateResponse.status}).`);
          const snapshot = await bounded(() => stateResponse.json()) as Partial<WebUiState>;
          if (snapshot.stateSessionId !== accepted.stateSessionId)
            throw new Error("Core restarted before this history action could be confirmed.");
          if (projectIdentity) {
            const currentIdentity = dependencies.projectIdentity?.() ?? null;
            if (currentIdentity === null
              || currentIdentity.origin !== projectIdentity.origin
              || currentIdentity.stateSessionId !== projectIdentity.stateSessionId
              || currentIdentity.projectEpoch !== projectIdentity.projectEpoch)
              throw new Error("Project changed while confirming the history action.");
          }
          const historyResult = snapshot.historyResults?.find(
            (result) => result.requestId === accepted.historyRequestId,
          );
          if (historyResult !== undefined) {
            if (!historyResult.applied) {
              if (accepted.projectEpoch !== undefined
                && snapshot.projectEpoch !== accepted.projectEpoch)
                dependencies.applySnapshot(snapshot);
              throw new Error(historyResult.error || `Core did not apply ${direction}.`);
            }
            if (accepted.projectEpoch !== undefined
              && snapshot.projectEpoch !== accepted.projectEpoch) {
              dependencies.applySnapshot(snapshot);
              throw new Error("Project changed while applying the history action.");
            }
            if (!Number.isSafeInteger(historyResult.projectRevision)
              || !Number.isSafeInteger(snapshot.stateRevision)
              || snapshot.stateRevision! < historyResult.projectRevision)
              throw new Error("Core returned an inconsistent history revision.");
            dependencies.applySnapshot(snapshot);
            boundaryListeners.forEach((listener) => listener());
            return;
          }
          // Older Core versions omit exact outcomes and expose only the
          // monotonic applied high-water mark. Newer Core may still be
          // processing this accepted command, so keep polling while its exact
          // result ring exists rather than treating an absent row as failure.
          if (!Array.isArray(snapshot.historyResults)
            && (snapshot.lastHistoryRequestId ?? 0) >= accepted.historyRequestId!) {
            dependencies.applySnapshot(snapshot);
            boundaryListeners.forEach((listener) => listener());
            return;
          }
          await sleep(25);
        }
        throw new Error(`Core has not confirmed ${direction}. It may still be finishing a project operation; do not resend blindly.`);
      }, 2);
    };
    const request = tail.then(execute).catch((error: unknown) => {
      publishNavigation({ pending: true, error: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      --queued;
      publishNavigation({ ...navigationState, pending: queued > 0 });
    });
    tail = request;
    return request;
  };
}
