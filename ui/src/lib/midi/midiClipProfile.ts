/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// MIDI Clip-specific MIDI-CI validation for the profile prefix and sequence.
const MIDI_CI_PROFILE_ON_V1_BYTES = 18;
const MIDI_CI_PROFILE_ON_V2_BYTES = 20;
const MAX_SET_PROFILE_ON_BYTES = MIDI_CI_PROFILE_ON_V2_BYTES;

interface SysEx7MessageState {
  byteCount: number;
  prefix: number[];
}

function sysEx7Payload(words: number[]): { group: number; status: number; bytes: number[] } {
  if (words.length !== 2 || (words[0] >>> 28) !== 3)
    throw new Error("A MIDI Clip SysEx7 packet must contain two UMP words");

  const first = words[0] >>> 0;
  const status = (first >>> 20) & 0xf;
  const count = (first >>> 16) & 0xf;
  if (status > 3 || count > 6)
    throw new Error("A MIDI Clip SysEx7 packet has an invalid status or byte count");

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
    throw new Error("A MIDI Clip SysEx7 packet has invalid data or nonzero padding");

  return { group: (first >>> 24) & 0xf, status,
    bytes: paddedBytes.slice(0, count) };
}

function appendPayload(state: SysEx7MessageState, bytes: number[]): void {
  state.byteCount += bytes.length;
  const remainingPrefixBytes = MAX_SET_PROFILE_ON_BYTES - state.prefix.length;
  if (remainingPrefixBytes > 0)
    state.prefix.push(...bytes.slice(0, remainingPrefixBytes));
}

function validateSetProfileOn(state: SysEx7MessageState): void {
  const prefix = state.prefix;
  const validDestination = prefix[1] <= 0x0f || prefix[1] === 0x7e || prefix[1] === 0x7f;
  const version = prefix[4];
  const validVersion = version >= 1 && (version & 0xe0) === 0;
  const validLength = version === 1
    ? state.byteCount === MIDI_CI_PROFILE_ON_V1_BYTES
    : version === 2
      ? state.byteCount === MIDI_CI_PROFILE_ON_V2_BYTES
      : version > 2 && state.byteCount >= MIDI_CI_PROFILE_ON_V2_BYTES;
  if (prefix[0] !== 0x7e
      || !validDestination
      || prefix[2] !== 0x0d
      || prefix[3] !== 0x22
      || !validVersion
      || !validLength)
    throw new Error("MIDI Clip profile data must be a complete MIDI-CI Set Profile On message");
  if (prefix.slice(5, 13).some((byte) => byte !== 0x7f))
    throw new Error("MIDI Clip Set Profile On must use broadcast source and destination MUIDs");
  if (version >= 2 && prefix[1] >= 0x7e && (prefix[18] !== 0 || prefix[19] !== 0))
    throw new Error("MIDI Clip Set Profile On must request zero channels for Group or Function Block destinations");
}

/** Validate and preserve the UMP packets in the profile prefix before DCTPQ. */
export function validateMidiClipProfilePackets(packets: number[][]): void {
  const active = new Map<number, SysEx7MessageState>();

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

function isPropertyExchangePrefix(prefix: number[]): boolean {
  return prefix.length >= 4
    && prefix[0] === 0x7e
    && prefix[2] === 0x0d
    && prefix[3] >= 0x30
    && prefix[3] <= 0x3f;
}

/** Reject MIDI-CI Property Exchange SysEx7 messages from sequence data. */
export function assertNoMidiClipPropertyExchange(sequencePackets: number[][]): void {
  const active = new Map<number, SysEx7MessageState>();

  for (const words of sequencePackets) {
    if ((words[0] >>> 28) !== 3) continue;
    const { group, status, bytes } = sysEx7Payload(words);
    const current = active.get(group);

    if (status === 0) {
      if (current)
        throw new Error("MIDI Clip sequence has a complete SysEx7 packet before its previous message ended");
      const complete = { byteCount: 0, prefix: [] as number[] };
      appendPayload(complete, bytes);
      if (isPropertyExchangePrefix(complete.prefix))
        throw new Error("MIDI-CI Property Exchange messages are not allowed in MIDI Clip Sequence Data");
      continue;
    }

    if (status === 1) {
      if (current)
        throw new Error("MIDI Clip sequence has a SysEx7 start before its previous message ended");
      const started = { byteCount: 0, prefix: [] as number[] };
      appendPayload(started, bytes);
      if (isPropertyExchangePrefix(started.prefix))
        throw new Error("MIDI-CI Property Exchange messages are not allowed in MIDI Clip Sequence Data");
      active.set(group, started);
      continue;
    }

    if (!current)
      throw new Error("MIDI Clip sequence has a SysEx7 continuation without a matching start");
    appendPayload(current, bytes);
    if (isPropertyExchangePrefix(current.prefix))
      throw new Error("MIDI-CI Property Exchange messages are not allowed in MIDI Clip Sequence Data");
    if (status === 3) active.delete(group);
  }

  if (active.size > 0)
    throw new Error("MIDI Clip sequence contains an incomplete SysEx7 message");
}
