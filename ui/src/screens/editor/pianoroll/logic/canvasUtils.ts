import type { AutomationLaneRow } from "../../../../lib/state/types";
import type { PianoRollBottomLane } from "./types";

export function isPrimaryModifier(
  event: Pick<PointerEvent, "metaKey" | "ctrlKey">,
): boolean {
  const usesMetaKey = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  return usesMetaKey ? event.metaKey : event.ctrlKey;
}

export function noteTextColor(
  fill: string,
  background: string,
  opacity: number,
): string {
  const parse = (value: string): [number, number, number] | null => {
    const match = /^#([\da-f]{6})$/i.exec(value);
    if (!match) return null;
    return [0, 2, 4].map((offset) =>
      parseInt(match[1].slice(offset, offset + 2), 16),
    ) as [number, number, number];
  };
  const foreground = parse(fill);
  const behind = parse(background);
  if (!foreground || !behind) return "#fff";
  const mixed = foreground.map(
    (component, index) =>
      (component * opacity + behind[index] * (1 - opacity)) / 255,
  );
  const linear = mixed.map((component) =>
    component <= 0.04045
      ? component / 12.92
      : ((component + 0.055) / 1.055) ** 2.4,
  );
  const luminance =
    linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return luminance > 0.179 ? "#111" : "#fff";
}

export function controllerParameterId(lane: PianoRollBottomLane): string {
  if (lane === "pitchBend") return "pitchBend";
  return `cc:${lane.slice(2)}`;
}

export function isControllerLane(
  lane: AutomationLaneRow,
  selected: PianoRollBottomLane,
): boolean {
  const parameterId = lane.target.parameterId;
  return (
    parameterId === selected ||
    parameterId === controllerParameterId(selected) ||
    (selected !== "pitchBend" && parameterId === selected.slice(2))
  );
}

export function controllerValueFromY(
  y: number,
  gridBottom: number,
  height: number,
  pitchBend: boolean,
): number {
  const top = gridBottom + 18;
  const bottom = height - 6;
  const normalized = Math.max(
    0,
    Math.min(1, (bottom - y) / Math.max(1, bottom - top)),
  );
  return pitchBend
    ? Math.round(normalized * 16383 - 8192)
    : Math.round(normalized * 127);
}

export function controllerYFromValue(
  value: number,
  gridBottom: number,
  height: number,
  pitchBend: boolean,
): number {
  const top = gridBottom + 18;
  const bottom = height - 6;
  const normalized = pitchBend ? (value + 8192) / 16383 : value / 127;
  return bottom - normalized * (bottom - top);
}

export const DEFAULT_NOTE_VELOCITY = 0.8;
