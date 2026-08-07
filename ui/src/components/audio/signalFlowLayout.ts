/**
 * Turning the engine's MixGraph into a left-to-right diagram.
 *
 * Kept apart from the React Flow component so the placement rules are plain
 * functions over plain data, and can be unit-tested without a renderer (see
 * signalFlowLayout.test.ts).
 */

export type MixStripKind = "track" | "click" | "send" | "main" | "output";
export type MixSoloGroup = "sources" | "sends" | "main" | "none";

/** One strip, exactly as core/engine/audio/MixGraph.h publishes it. */
export interface MixGraphStrip {
  id: string;
  name: string;
  kind: MixStripKind;
  soloGroup: MixSoloGroup;
  channels: number;
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Resolved: false when muted OR silenced by another strip's solo. */
  audible: boolean;
  /** Output lanes only. -1 = shadow lane (referenced, not on the device). */
  physicalChannel: number;
  peakDb: number;
}

export interface MixGraphEdge {
  from: string;
  to: string;
  /** 0-100 percent, 100 = unity. */
  level: number;
  preFader: boolean;
  /** False when the source is muted or solo-silenced. */
  active: boolean;
  /** -1 = sum L+R into a mono destination, 0 = left only, 1 = right only. */
  sourceChannel: number;
}

export interface MixGraphPayload {
  strips: MixGraphStrip[];
  edges: MixGraphEdge[];
}

export interface PlacedStrip {
  strip: MixGraphStrip;
  /** Layer index, 0 = leftmost. */
  column: number;
  /** Position within the column, 0 = topmost. */
  row: number;
  x: number;
  y: number;
}

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 74;
const COLUMN_GAP = 90;
const ROW_GAP = 18;

/**
 * Longest-path layering: a strip sits one column right of its furthest-left
 * source. Not "column per kind" -- a send that folds into Main has to land
 * left of Main, while a send that owns its own output lanes can sit in the
 * same column as Main, and only the edges know which is which.
 *
 * The graph is a DAG by construction (buildMixGraph refuses bus -> bus, the
 * one edge that could close a loop), so a single pass in strip order is
 * enough: every edge runs from a lower strip index to a higher one.
 */
export function layerStrips(payload: MixGraphPayload): Map<string, number> {
  const columns = new Map<string, number>();
  for (const strip of payload.strips) columns.set(strip.id, 0);

  const incoming = new Map<string, string[]>();
  for (const edge of payload.edges) {
    const list = incoming.get(edge.to);
    if (list) list.push(edge.from);
    else incoming.set(edge.to, [edge.from]);
  }

  for (const strip of payload.strips) {
    const sources = incoming.get(strip.id);
    if (!sources || sources.length === 0) continue;
    let deepest = 0;
    for (const from of sources) {
      const at = columns.get(from);
      if (at !== undefined && at + 1 > deepest) deepest = at + 1;
    }
    columns.set(strip.id, deepest);
  }

  return columns;
}

/**
 * Assigns every strip a column and a row, then absolute pixel coordinates.
 * Rows keep the engine's own strip order inside a column, which is already
 * meaningful (tracks in project order, then the click; sends in order, then
 * Main; lanes by channel number).
 */
export function layoutSignalFlow(payload: MixGraphPayload): PlacedStrip[] {
  const columns = layerStrips(payload);
  const usedRows = new Map<number, number>();
  const placed: PlacedStrip[] = [];

  for (const strip of payload.strips) {
    const column = columns.get(strip.id) ?? 0;
    const row = usedRows.get(column) ?? 0;
    usedRows.set(column, row + 1);
    placed.push({
      strip,
      column,
      row,
      x: column * (NODE_WIDTH + COLUMN_GAP),
      y: row * (NODE_HEIGHT + ROW_GAP),
    });
  }

  // Centre every column vertically against the tallest one, so the diagram
  // reads as a flow rather than as ragged top-aligned stacks.
  let tallest = 0;
  for (const count of usedRows.values()) tallest = Math.max(tallest, count);
  const columnHeight = (count: number) =>
    count * NODE_HEIGHT + Math.max(0, count - 1) * ROW_GAP;
  const fullHeight = columnHeight(tallest);
  for (const item of placed) {
    const count = usedRows.get(item.column) ?? 1;
    item.y += (fullHeight - columnHeight(count)) / 2;
  }

  return placed;
}

/** Human label for what an edge carries into a one-channel destination. */
export function sourceChannelLabel(sourceChannel: number): string | null {
  if (sourceChannel === 0) return "L";
  if (sourceChannel === 1) return "R";
  return null;
}

/** dB for display: the engine's floor reads as silence, not "-144.0". */
export function formatDb(db: number): string {
  if (!Number.isFinite(db) || db <= -99) return "−∞";
  return `${db > 0 ? "+" : ""}${db.toFixed(1)}`;
}

/** Pan for display: centre, or a side with its amount. */
export function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.005) return "C";
  const side = pan < 0 ? "L" : "R";
  return `${side}${Math.round(Math.abs(pan) * 100)}`;
}
