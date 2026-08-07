/**
 * The identifier canon, as the mixer sees it.
 *
 * Every id in the project format is namespaced: "<ns>::<kind>:<n>" for a
 * numbered entity, "<ns>::<kind>" for a singleton. The mixer only ever needs
 * two of them -- the master bus and the physical output lanes -- so they live
 * here rather than being spelled out inline at a dozen call sites.
 *
 * That inlining is what broke the master strip: MixerScreen looked up the
 * master as `id === "main"`, which stopped matching when the engine moved to
 * "audio::main". The lookup fell through to "the first non-aux bus", which is
 * an output LANE, so Mute / mono / balance / volume on the master strip were
 * all being sent to a lane index instead -- silently doing nothing.
 */

/** The FOH master bus. A singleton, so no trailing index. */
export const MAIN_BUS_ID = "audio::main";

export function isMainBusId(id: string): boolean {
  return id === MAIN_BUS_ID;
}

/** Canonical id for a 0-based physical output channel: 0 -> "audio::out:1". */
export function outputLaneId(channel0Based: number): string {
  return `audio::out:${channel0Based + 1}`;
}

/**
 * The route target the backend stores for a physical pick. Outputs are always
 * mono lanes; "stereo" is a pair of them, which is what lets a project map
 * Main to 1/2, a mono wedge to 11 and a stereo IEM to 13/14 without inventing
 * stereo-pair bus objects.
 */
export function extOutTarget(startChannel0Based: number, pair: boolean): string {
  return pair
    ? `${outputLaneId(startChannel0Based)},${outputLaneId(startChannel0Based + 1)}`
    : outputLaneId(startChannel0Based);
}

/** Lane numbers (1-based) of an ext-out target, or null if it isn't one. */
export function parseOutputLanes(target: string): number[] | null {
  if (!target) return null;
  const parts = target
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const lanes: number[] = [];
  for (const token of parts) {
    const match = /^audio::out:(\d+)$/.exec(token);
    if (!match) return null;
    lanes.push(Number(match[1]));
  }
  return lanes;
}
