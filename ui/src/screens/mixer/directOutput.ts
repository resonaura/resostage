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
  const count = settings.outputChannelNames.length;
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
