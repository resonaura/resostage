/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

/**
 * Shared peak/clip latches for visible controls that refer to one audio strip.
 * The store is fed directly from decoded live-meter telemetry and only notifies
 * subscribers when a latch changes; it never owns or changes audio state.
 */

const FLOOR_DB = -100;
const SANE_PEAK_DB = 24;
const HELD_PEAK_EPSILON_DB = 0.1;
/** Covers large sessions while bounding retained state across project changes. */
const MAX_RETAINED_STRIPS = 8192;

export type ChannelClipHoldSnapshot = {
  clipped: boolean;
  heldPeakDb: number;
};

const EMPTY_SNAPSHOT: ChannelClipHoldSnapshot = Object.freeze({
  clipped: false,
  heldPeakDb: FLOOR_DB,
});

type Entry = {
  snapshot: ChannelClipHoldSnapshot;
  listeners: Set<() => void>;
};

const entries = new Map<string, Entry>();

export type ChannelClipHoldProjectIdentity = {
  origin: string;
  stateSessionId: string;
  projectEpoch: number;
} | null;

/** Build the same clip-latch key in the React hook and telemetry decoder. */
export function channelClipHoldKey(
  stripId: string,
  project: ChannelClipHoldProjectIdentity,
): string {
  const namespace = project
    ? `${project.origin}:${project.stateSessionId}:${project.projectEpoch}`
    : "unfenced";
  return `${namespace}:${stripId}`;
}

function entryFor(key: string): Entry | null {
  let entry = entries.get(key);
  if (!entry) {
    if (entries.size >= MAX_RETAINED_STRIPS) {
      const evictableKey = [...entries].find(([, candidate]) => candidate.listeners.size === 0)?.[0];
      if (evictableKey === undefined) return null;
      entries.delete(evictableKey);
    }
    entry = { snapshot: EMPTY_SNAPSHOT, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

function publish(entry: Entry, next: ChannelClipHoldSnapshot): void {
  if (
    entry.snapshot.clipped === next.clipped &&
    entry.snapshot.heldPeakDb === next.heldPeakDb
  ) return;
  entry.snapshot = next;
  for (const listener of entry.listeners) listener();
}

/** Stable external-store read; missing/unmounted strips have a quiet baseline. */
export function getChannelClipHoldSnapshot(key: string): ChannelClipHoldSnapshot {
  return entries.get(key)?.snapshot ?? EMPTY_SNAPSHOT;
}

/** Subscribe a view to the latch for one fully-qualified strip identity. */
export function subscribeChannelClipHold(
  key: string,
  listener: () => void,
): () => void {
  const entry = entryFor(key);
  if (!entry) return () => {};
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

/** Receive one Core peak sample. Values at/below 0 dBFS do not clip. */
export function publishChannelClipPeak(key: string, peakDb: number): void {
  if (!Number.isFinite(peakDb) || peakDb <= 0 || peakDb > SANE_PEAK_DB)
    return;
  const entry = entryFor(key);
  if (!entry) return;

  const heldPeakDb = entry.snapshot.heldPeakDb;
  if (entry.snapshot.clipped) {
    if (peakDb > heldPeakDb + HELD_PEAK_EPSILON_DB)
      publish(entry, { clipped: true, heldPeakDb: peakDb });
  } else {
    publish(entry, { clipped: true, heldPeakDb: peakDb });
  }
}

/** Reset the same visible latch everywhere without touching the audio engine. */
export function clearChannelClipHold(key: string): void {
  const entry = entries.get(key);
  if (entry) publish(entry, EMPTY_SNAPSHOT);
}

/** Clear all mounted strip latches when the live Core/telemetry source resets. */
export function resetChannelClipHolds(): void {
  for (const entry of entries.values()) publish(entry, EMPTY_SNAPSHOT);
}
