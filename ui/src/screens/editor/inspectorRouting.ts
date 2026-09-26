import {
  outputSendsToClickRows,
  sourceOutputBusId,
  type BusRow,
  type TrackRow,
} from "../../lib/types";
import { isMainBusId, MAIN_BUS_ID } from "../mixer/mixerIds";

export function busFeedsMaster(bus: BusRow, master?: BusRow): boolean {
  if (!master) return false;
  const busOut = (bus as { output?: { type?: string; target?: string | null } }).output;
  if (busOut?.type === "main") return true;
  if (busOut?.target === MAIN_BUS_ID || (master.id && busOut?.target === master.id)) return true;
  if (bus.isDirectOut) return false;
  return bus.channels === master.channels && bus.startChannel === master.startChannel;
}

export const DEFAULT_INSPECTOR_WIDTH = 218; // Width of 2 tracks in standard mode (2 * 96 + 8 gap + 16 padding + 2 border)
export const DEFAULT_INSPECTOR_2_25_WIDTH = 242; // Exact 2.25 tracks (2 * 96 + 2 * 8 gap + 8 pad-left + 2 border + 24px [0.25 * 96] peek)
export const DEFAULT_INSPECTOR_2_3_WIDTH = 247; // Exact 2.30 tracks (2 * 96 + 2 * 8 gap + 8 pad-left + 2 border + 29px [0.30 * 96] peek)
export const DEFAULT_INSPECTOR_OVERFLOW_WIDTH = DEFAULT_INSPECTOR_2_3_WIDTH; // Default to 2.3 tracks under ScrollShadow
export const MIN_INSPECTOR_WIDTH = 112; // Minimum width (1 track + padding)
export const MAX_INSPECTOR_WIDTH = 680; // Maximum inspector width

export interface InspectorBussesResolution {
  sendBusses: BusRow[];
  showMaster: boolean;
  master?: BusRow;
  stripCount: number;
  computedWidth: number;
}

export function resolveInspectorBusses({
  selectedTrack,
  busses,
}: {
  selectedTrack: TrackRow | null;
  busses: BusRow[];
}): InspectorBussesResolution {
  const master = busses.find((b) => isMainBusId(b.id)) ?? busses[0];
  const auxBusses = busses.filter((b) => b.isAux);

  const assignedSends = selectedTrack
    ? outputSendsToClickRows(selectedTrack.output)
    : [];

  const sendBusses: BusRow[] = [];
  for (const s of assignedSends) {
    const bus = auxBusses.find((b) => b.id === s.busId);
    if (bus && !sendBusses.some((b) => b.id === bus.id)) {
      sendBusses.push(bus);
    }
  }

  // If track main output explicitly routes into an aux bus:
  if (selectedTrack?.output?.type === "bus" && selectedTrack.output.target) {
    const directBus = auxBusses.find((b) => b.id === selectedTrack.output.target);
    if (directBus && !sendBusses.some((b) => b.id === directBus.id)) {
      sendBusses.push(directBus);
    }
  }

  // Master visibility rules:
  // - Show if track routes directly to master
  // - Show if any of the active send buses fed by this track routes to master
  // - Hide if track routes to physical outs (ext-out) or sends-only, and no send feeds master
  const trackFeedsMasterDirectly = Boolean(
    selectedTrack &&
      (selectedTrack.output?.type === "main" ||
        sourceOutputBusId(selectedTrack.output) === MAIN_BUS_ID ||
        (master && sourceOutputBusId(selectedTrack.output) === master.id)),
  );

  const anySendFeedsMaster = sendBusses.some((bus) => busFeedsMaster(bus, master));

  const showMaster = Boolean(master && (trackFeedsMasterDirectly || anySendFeedsMaster));

  const stripCount =
    (selectedTrack ? 1 : 0) + sendBusses.length + (showMaster && master ? 1 : 0);
  const computedWidth =
    stripCount > 0
      ? Math.min(500, Math.max(120, stripCount * 96 + (stripCount - 1) * 8 + 16))
      : 120;

  return {
    sendBusses,
    showMaster,
    master,
    stripCount,
    computedWidth,
  };
}
