/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

/**
 * Only continuous, reversible rotary targets are exposed to MIDI Learn.
 * Structural, navigation, and note-editing commands intentionally have no
 * constructor here, so they cannot be bound through a rotary context menu.
 */
declare const rotaryMidiTargetBrand: unique symbol;

export type RotaryMidiTarget = string & {
  readonly [rotaryMidiTargetBrand]: true;
};

function action(value: string): RotaryMidiTarget {
  return value as RotaryMidiTarget;
}

function requireIdentity(identity: string, kind: string): string {
  if (!identity || identity.includes("|")) {
    throw new Error(`Invalid ${kind} identity for MIDI control binding`);
  }
  return identity;
}

export const rotaryMidiTarget = {
  trackPan: (trackId: string) =>
    action(`track_pan:${requireIdentity(trackId, "track")}`),
  busPan: (busId: string) =>
    action(`bus_pan:${requireIdentity(busId, "bus")}`),
  masterPan: () => action("master_pan"),
  clickPan: () => action("click_pan"),
  trackSend: (trackId: string, busId: string) =>
    action(
      `track_send:${requireIdentity(trackId, "track")}|${requireIdentity(busId, "send bus")}`,
    ),
  clickSend: (busId: string) =>
    action(`click_send:${requireIdentity(busId, "send bus")}`),
} as const;
