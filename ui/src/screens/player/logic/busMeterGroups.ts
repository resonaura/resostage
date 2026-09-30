import {
  type BusRow,
  type ClickSendRow,
  type MeterRow,
  sourceOutputBusId,
  type WebUiState,
} from "@/lib/state/types";
import {
  busCycleColor,
  extOutColor,
  masterColor,
  monoOutColor,
  sendColor,
} from "@/lib/theme/mixerColors";

export type BusMeterGroup = {
  id: string;
  name: string;
  accent: string;
  meters: MeterRow[];
};

/** "audio::out:3" or "direct:3" -> 3; anything else -> null. */
function laneNumber(id: string): number | null {
  if (id.startsWith("audio::out:")) {
    const n = Number(id.slice("audio::out:".length));
    return Number.isFinite(n) ? n : null;
  }
  if (id.startsWith("direct:")) {
    const n = Number(id.slice("direct:".length));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 1-based mono lanes referenced STANDALONE (any mono route / mono master /
 *  mono send / metronome). Such lanes must not be folded into a stereo pair. */
function collectSoloLanes(
  busses: BusRow[],
  tracks: WebUiState["tracks"],
  clickBusId?: string,
  clickSends?: ClickSendRow[],
): Set<number> {
  const solo = new Set<number>();

  for (const b of busses) {
    if (b.id.startsWith("audio::out:") || b.id.startsWith("direct:")) continue;
    if (b.channels <= 1) solo.add(b.startChannel + 1);
  }

  const applyRefs = (id: string | undefined) => {
    if (typeof id !== "string" || !id) return;
    const lanes = id
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t) => /^(?:audio::out:|direct:)(\d+)$/.exec(t))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    // A single-lane route (compounds are a stereo pair of lanes) solos it.
    if (lanes.length <= 1) {
      for (const l of lanes) solo.add(l);
    }
  };

  for (const t of tracks) {
    applyRefs(sourceOutputBusId(t.output));
    for (const s of t.output.sends) applyRefs(s.bus);
  }
  applyRefs(clickBusId);
  for (const cs of clickSends ?? []) applyRefs(cs.busId);

  return solo;
}

/**
 * Preview grouping for the Player "Bus meters" widget. Project busses
 * (main / aux / sends) stay as their own meter columns; Direct Output lanes
 * are folded into consecutive stereo pairs -- "Out 1/2", "Out 3/4" -- unless
 * a lane is targeted standalone anywhere (mono route, mono master, mono send,
 * metronome), in which case it is shown on its own ("Out 5") instead of being
 * glued into a pair. Every direct group shares one colour.
 */
export function busMeterGroups(
  meters: MeterRow[],
  busses: BusRow[],
  tracks: WebUiState["tracks"],
  clickBusId?: string,
  clickSends?: ClickSendRow[],
): BusMeterGroup[] {
  const direct: MeterRow[] = [];
  const groups: BusMeterGroup[] = [];
  let auxIdx = 0;
  for (const m of meters) {
    if (laneNumber(m.id) != null) {
      direct.push(m);
      continue;
    }
    const busObj = busses.find((b) => b.id === m.id);
    const isMaster =
      busObj?.name?.toLowerCase() === "master" ||
      m.id === "audio::main" ||
      m.id === "main" ||
      m.id === "master";
    const accent = isMaster
      ? masterColor()
      : busObj?.isAux
        ? sendColor()
        : busCycleColor(auxIdx++);
    groups.push({
      id: m.id,
      name: busObj?.name || (m.id === "main" ? "Main" : m.id),
      accent,
      meters: [m],
    });
  }

  const soloLanes = collectSoloLanes(busses, tracks, clickBusId, clickSends);
  direct.sort((a, b) => (laneNumber(a.id) ?? 0) - (laneNumber(b.id) ?? 0));
  for (let i = 0; i < direct.length; ) {
    const a = direct[i];
    const laneA = laneNumber(a.id) ?? 0;
    const b = direct[i + 1];
    const laneB = b ? (laneNumber(b.id) ?? -1) : -1;
    const isPair =
      b != null &&
      laneA % 2 === 1 &&
      laneB === laneA + 1 &&
      !soloLanes.has(laneA) &&
      !soloLanes.has(laneB);
    if (isPair) {
      groups.push({
        id: `out:${laneA}/${laneB}`,
        name: `Out ${laneA}/${laneB}`,
        accent: extOutColor(),
        meters: [a, b],
      });
      i += 2;
    } else {
      groups.push({
        id: `out:${laneA}`,
        name: `Out ${laneA}`,
        accent: monoOutColor(),
        meters: [a],
      });
      i += 1;
    }
  }
  return groups;
}
