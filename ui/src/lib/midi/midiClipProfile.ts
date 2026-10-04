/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

const MAX_SET_PROFILE_ON_BYTES = 18;

interface ProfileMessageState {
  byteCount: number;
  prefix: number[];
}

function sysEx7Payload(words: number[]): { group: number; status: number; bytes: number[] } {
  if (words.length !== 2 || (words[0] >>> 28) !== 3)
    throw new Error("A MIDI Clip profile packet must use a two-word SysEx7 UMP");

  const first = words[0] >>> 0;
  const status = (first >>> 20) & 0xf;
  const count = (first >>> 16) & 0xf;
  if (status > 3 || count > 6)
    throw new Error("A MIDI Clip profile packet has an invalid SysEx7 status or byte count");

  const second = words[1] >>> 0;
  const paddedBytes = [
    (first >>> 8) & 0xff,
    first & 0xff,
    (second >>> 24) & 0xff,
    (second >>> 16) & 0xff,
    (second >>> 8) & 0xff,
    second & 0xff,
  ];
  if (paddedBytes.slice(0, count).some((byte) => byte > 0x7f)
      || paddedBytes.slice(count).some((byte) => byte !== 0))
    throw new Error("A MIDI Clip profile packet has invalid SysEx7 data or nonzero padding");

  return { group: (first >>> 24) & 0xf, status,
    bytes: paddedBytes.slice(0, count) };
}

function appendPayload(state: ProfileMessageState, bytes: number[]): void {
  state.byteCount += bytes.length;
  const remainingPrefixBytes = MAX_SET_PROFILE_ON_BYTES - state.prefix.length;
  if (remainingPrefixBytes > 0)
    state.prefix.push(...bytes.slice(0, remainingPrefixBytes));
}

function validateSetProfileOn(state: ProfileMessageState): void {
  const prefix = state.prefix;
  const validDestination = prefix[1] <= 0x0f || prefix[1] === 0x7e || prefix[1] === 0x7f;
  if (state.byteCount < MAX_SET_PROFILE_ON_BYTES
      || prefix[0] !== 0x7e
      || !validDestination
      || prefix[2] !== 0x0d
      || prefix[3] !== 0x22
      || !Number.isInteger(prefix[4])
      || prefix[4] < 1)
    throw new Error("MIDI Clip profile data must be a complete MIDI-CI Set Profile On message");
}

/** Validate and preserve the UMP packets in the profile prefix before DCTPQ. */
export function validateMidiClipProfilePackets(packets: number[][]): void {
  const active = new Map<number, ProfileMessageState>();

  for (const words of packets) {
    const { group, status, bytes } = sysEx7Payload(words);
    const current = active.get(group);

    if (status === 0) {
      if (current)
        throw new Error("A MIDI Clip profile SysEx7 message ended before its previous message");
      const complete = { byteCount: 0, prefix: [] as number[] };
      appendPayload(complete, bytes);
      validateSetProfileOn(complete);
      continue;
    }

    if (status === 1) {
      if (current)
        throw new Error("A MIDI Clip profile SysEx7 message started before its previous message ended");
      const started = { byteCount: 0, prefix: [] as number[] };
      appendPayload(started, bytes);
      active.set(group, started);
      continue;
    }

    if (!current)
      throw new Error("A MIDI Clip profile SysEx7 continuation has no matching start");
    appendPayload(current, bytes);
    if (status === 3) {
      validateSetProfileOn(current);
      active.delete(group);
    }
  }

  if (active.size > 0)
    throw new Error("MIDI Clip profile data contains an incomplete SysEx7 message");
}
