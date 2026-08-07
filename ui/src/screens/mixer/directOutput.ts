import type { SettingsState } from "../../lib/types";

export type DirectOutOption = {
  /** Unique option id — must not collide when both pair and single share a start channel. */
  id: string;
  /** Plain label for the native OS popup ("1/2", "3", …) — no decoration. */
  label: string;
  startChannel: number;
  pair: boolean;
};

export function optionId(startChannel: number, pair: boolean): string {
  return `${pair ? "p" : "s"}:${startChannel}`;
}

export function parseOptionId(
  id: string,
): { startChannel: number; pair: boolean } | null {
  const m = /^(p|s):(\d+)$/.exec(id);
  if (!m) return null;
  return { pair: m[1] === "p", startChannel: Number(m[2]) };
}

/** A route's comma-separated mono Direct Output lane numbers, or null when
 *  the route isn't a direct egress ("", a project main/aux bus, sends). The
 *  ids are 1-based ("audio::out:1", stereo = "audio::out:1,audio::out:2"). */
export function parseDirectLanes(busId: string): number[] | null {
  if (!busId) return null;
  const parts = busId.split(",").map((t) => t.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  for (const t of parts) {
    const m = /^(?:audio::out:|direct:)(\d+)$/.exec(t);
    if (!m) return null;
  }
  return parts.map((t) => {
    if (t.startsWith("audio::out:")) return Number(t.slice("audio::out:".length));
    return Number(t.slice("direct:".length));
  });
}

/** Map a route id onto the channel-picker option it should display:
 *  two consecutive lanes -> pair option, a single lane -> mono option. The
 *  option is 0-based internally (startChannel), matching directOutputOptions. */
export function routeToOptionId(
  busId: string,
): { startChannel: number; pair: boolean } | null {
  const lanes = parseDirectLanes(busId);
  if (!lanes || lanes.length === 0) return null;
  if (lanes.length >= 2 && lanes[1] === lanes[0] + 1)
    return { startChannel: lanes[0] - 1, pair: true };
  return { startChannel: lanes[0] - 1, pair: false };
}

/** Build the route id the backend stores for a physical pick. */
export function routeIdForOutput(
  startChannel: number, // 0-based physical index
  pair: boolean,
): string {
  if (pair)
    return `audio::out:${startChannel + 1},audio::out:${startChannel + 2}`;
  return `audio::out:${startChannel + 1}`;
}

/**
 * Physical-output picks for Ext. Out / master channel lists.
 * Pairs first ("1/2", "3/4", …). Then singles:
 * - stereo mode: only leftover singles not covered by a full pair
 * - mono mode (`includeAllSingles`): every active channel (1, 2, 3, 4, …)
 */
export function directOutputOptions(
  settings: SettingsState,
  opts?: { includeAllSingles?: boolean },
): DirectOutOption[] {
  // The engine always assumes at least a default stereo pair when a device
  // hasn't reported its channel names yet (see AudioEngine's `total = 2`).
  // Mirror that here so Ext. Out / master / metronome always have SOMETHING to
  // select, otherwise the secondary picker is empty and no channel can be
  // chosen (and the previous value lingers until the device reports in).
  const count = settings.outputChannelNames.length || 2;
  const isActive = (i: number) => settings.activeOutputChannels[i] !== false;
  const options: DirectOutOption[] = [];
  const inPair = new Set<number>();

  for (let i = 0; i + 1 < count; i += 2) {
    if (isActive(i) && isActive(i + 1)) {
      options.push({
        id: optionId(i, true),
        label: `${i + 1}/${i + 2}`,
        startChannel: i,
        pair: true,
      });
      inPair.add(i);
      inPair.add(i + 1);
    }
  }

  for (let i = 0; i < count; i++) {
    if (!isActive(i)) continue;
    if (!opts?.includeAllSingles && inPair.has(i)) continue;
    options.push({
      id: optionId(i, false),
      label: `${i + 1}`,
      startChannel: i,
      pair: false,
    });
  }
  return options;
}

/** True when a physical out target is currently reachable on the device. */
export function channelAvailable(
  settings: SettingsState,
  startChannel: number,
  channels: number,
): boolean {
  const count = settings.outputChannelNames.length;
  // No device info yet — assume everything is available to avoid a warning flash.
  if (count === 0) return true;
  if (startChannel < 0 || startChannel >= count) return false;
  if (settings.activeOutputChannels[startChannel] === false) return false;
  if (channels >= 2) {
    if (startChannel + 1 >= count) return false;
    if (settings.activeOutputChannels[startChannel + 1] === false) return false;
  }
  return true;
}

/** Best option id for a bus already on a given hardware mapping. */
export function matchOptionId(
  options: DirectOutOption[],
  startChannel: number,
  channels: number,
): string {
  const wantPair = channels >= 2;
  const exact = options.find(
    (o) => o.startChannel === startChannel && o.pair === wantPair,
  );
  if (exact) return exact.id;
  const any = options.find((o) => o.startChannel === startChannel);
  return any?.id ?? options[0]?.id ?? optionId(0, true);
}
