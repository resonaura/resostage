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
/** Covers large sessions while bounding retained state across project changes. */
const MAX_RETAINED_STRIPS = 8192;

export type ChannelClipHoldSnapshot = {
  clipped: boolean;
};

export type ChannelPeakHold = Readonly<{
  leftDb: number;
  rightDb: number;
}>;

type MutableChannelPeakHold = {
  leftDb: number;
  rightDb: number;
};

const EMPTY_SNAPSHOT: ChannelClipHoldSnapshot = Object.freeze({
  clipped: false,
});

const EMPTY_PEAK_HOLD: ChannelPeakHold = Object.freeze({
  leftDb: FLOOR_DB,
  rightDb: FLOOR_DB,
});

type Entry = {
  snapshot: ChannelClipHoldSnapshot;
  peakHold: MutableChannelPeakHold;
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
    entry = {
      snapshot: EMPTY_SNAPSHOT,
      peakHold: { leftDb: FLOOR_DB, rightDb: FLOOR_DB },
      listeners: new Set(),
    };
    entries.set(key, entry);
  }
  return entry;
}

function publish(entry: Entry, next: ChannelClipHoldSnapshot): void {
  if (entry.snapshot.clipped === next.clipped) return;
  entry.snapshot = next;
  for (const listener of entry.listeners) listener();
}

/** Stable external-store read; missing/unmounted strips have a quiet baseline. */
export function getChannelClipHoldSnapshot(key: string): ChannelClipHoldSnapshot {
  return entries.get(key)?.snapshot ?? EMPTY_SNAPSHOT;
}

/**
 * Read the shared peak hold from a meter paint loop without causing React
 * renders for every rising sample. Peak values are updated in place by the
 * telemetry decoder; consumers should sample them during their paint/readout
 * loop rather than retain them as React state.
 */
export function getChannelPeakHold(key: string): ChannelPeakHold {
  return entries.get(key)?.peakHold ?? EMPTY_PEAK_HOLD;
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

/** Receive one Core stereo peak sample. Clip latches only above 0 dBFS. */
export function publishChannelPeak(
  key: string,
  peakDbL: number,
  peakDbR: number,
): void {
  if (
    !Number.isFinite(peakDbL) || !Number.isFinite(peakDbR) ||
    peakDbL > SANE_PEAK_DB || peakDbR > SANE_PEAK_DB
  ) return;
  const entry = entryFor(key);
  if (!entry) return;

  const leftDb = Math.max(FLOOR_DB, peakDbL);
  const rightDb = Math.max(FLOOR_DB, peakDbR);
  if (leftDb > entry.peakHold.leftDb || rightDb > entry.peakHold.rightDb) {
    entry.peakHold.leftDb = Math.max(leftDb, entry.peakHold.leftDb);
    entry.peakHold.rightDb = Math.max(rightDb, entry.peakHold.rightDb);
  }

  const clipped = Math.max(leftDb, rightDb) > 0;
  if (clipped !== entry.snapshot.clipped)
    publish(entry, { clipped });
}

/** Reset the same visible latch everywhere without touching the audio engine. */
export function clearChannelClipHold(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.peakHold.leftDb = FLOOR_DB;
  entry.peakHold.rightDb = FLOOR_DB;
  publish(entry, EMPTY_SNAPSHOT);
}

/** Clear all mounted strip latches when the live Core/telemetry source resets. */
export function resetChannelClipHolds(): void {
  for (const entry of entries.values()) {
    entry.peakHold.leftDb = FLOOR_DB;
    entry.peakHold.rightDb = FLOOR_DB;
    publish(entry, EMPTY_SNAPSHOT);
  }
}
