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
 * How many pairs of edges cross, given a row assignment.
 *
 * Exported for the tests: "the diagram is less tangled" is otherwise a matter
 * of opinion, and this makes it a number.
 */
export function countCrossings(
  edges: MixGraphEdge[],
  columnOf: Map<string, number>,
  rowOf: Map<string, number>,
): number {
  let crossings = 0;
  // Only edges between the same pair of adjacent columns can cross.
  const byColumn = new Map<number, MixGraphEdge[]>();
  for (const e of edges) {
    const c = columnOf.get(e.from);
    if (c === undefined) continue;
    const list = byColumn.get(c);
    if (list) list.push(e);
    else byColumn.set(c, [e]);
  }
  for (const list of byColumn.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const a0 = rowOf.get(a.from) ?? 0;
        const a1 = rowOf.get(a.to) ?? 0;
        const b0 = rowOf.get(b.from) ?? 0;
        const b1 = rowOf.get(b.to) ?? 0;
        // Two edges cross when their endpoints are in opposite orders.
        if ((a0 - b0) * (a1 - b1) < 0) crossings++;
      }
    }
  }
  return crossings;
}

/** Sweeps of barycentre ordering. Past this the ordering stops improving. */
const ORDERING_SWEEPS = 4;

/**
 * Reorders each column so connected strips line up across the gap.
 *
 * Rows used to be the engine's own strip order, which is meaningful inside a
 * column (tracks in project order, sends in order, lanes by channel) and says
 * nothing at all about what connects to what. On a real desk -- a dozen
 * tracks, four sends, a handful of output lanes, every track feeding every
 * send -- that produced a diagram where the wires were the only thing you
 * could see, and following any one of them was impossible.
 *
 * This is the barycentre heuristic: put each strip at the average row of the
 * things it connects to, sweep forwards and backwards a few times, keep the
 * best result. It is the standard first move for layered graph drawing, it is
 * cheap, and it does not need to be optimal -- crossing minimisation is
 * NP-hard, and "far fewer" is the whole requirement.
 *
 * Ties keep the engine's order, so a column nothing constrains still reads in
 * project order rather than being shuffled arbitrarily.
 */
function orderRows(
  payload: MixGraphPayload,
  columns: Map<string, number>,
): Map<string, number> {
  const byColumn = new Map<number, string[]>();
  for (const strip of payload.strips) {
    const c = columns.get(strip.id) ?? 0;
    const list = byColumn.get(c);
    if (list) list.push(strip.id);
    else byColumn.set(c, [strip.id]);
  }

  const rowOf = new Map<string, number>();
  const original = new Map<string, number>();
  for (const list of byColumn.values()) {
    list.forEach((id, i) => {
      rowOf.set(id, i);
      original.set(id, i);
    });
  }

  const targets = new Map<string, string[]>();
  const sources = new Map<string, string[]>();
  for (const e of payload.edges) {
    (targets.get(e.from) ?? targets.set(e.from, []).get(e.from)!).push(e.to);
    (sources.get(e.to) ?? sources.set(e.to, []).get(e.to)!).push(e.from);
  }

  const columnIndices = [...byColumn.keys()].sort((a, b) => a - b);
  let best = new Map(rowOf);
  let bestCrossings = countCrossings(payload.edges, columns, rowOf);

  const sweep = (forwards: boolean) => {
    const order = forwards ? columnIndices : [...columnIndices].reverse();
    for (const c of order) {
      const list = byColumn.get(c);
      if (!list || list.length < 2) continue;
      const neighbours = forwards ? sources : targets;
      const score = new Map<string, number>();
      for (const id of list) {
        const linked = neighbours.get(id) ?? [];
        if (linked.length === 0) {
          // Nothing pulling on it: leave it where it is rather than letting
          // it drift to the top and push connected strips out of line.
          score.set(id, rowOf.get(id) ?? 0);
          continue;
        }
        let sum = 0;
        for (const other of linked) sum += rowOf.get(other) ?? 0;
        score.set(id, sum / linked.length);
      }
      list.sort((a, b) => {
        const d = (score.get(a) ?? 0) - (score.get(b) ?? 0);
        if (Math.abs(d) > 1e-9) return d;
        return (original.get(a) ?? 0) - (original.get(b) ?? 0);
      });
      list.forEach((id, i) => rowOf.set(id, i));
    }
    const crossings = countCrossings(payload.edges, columns, rowOf);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = new Map(rowOf);
    }
  };

  for (let i = 0; i < ORDERING_SWEEPS; i++) {
    sweep(true);
    sweep(false);
  }
  return best;
}

/**
 * Assigns every strip a column and a row, then absolute pixel coordinates.
 * Columns come from the signal flow; rows are chosen to keep the wires
 * between them as untangled as the heuristic can manage -- see orderRows.
 */
export function layoutSignalFlow(payload: MixGraphPayload): PlacedStrip[] {
  const columns = layerStrips(payload);
  const rows = orderRows(payload, columns);
  const usedRows = new Map<number, number>();
  const placed: PlacedStrip[] = [];

  for (const strip of payload.strips) {
    const column = columns.get(strip.id) ?? 0;
    const row = rows.get(strip.id) ?? 0;
    usedRows.set(column, Math.max(usedRows.get(column) ?? 0, row + 1));
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

/** Everything on the signal path that runs through one strip. */
export interface FocusedPath {
  strips: Set<string>;
  /** Indices into `edges`, so the caller can key its own edge list by them. */
  edges: Set<number>;
}

/**
 * The whole path through `stripId`: everything feeding it, and everything it
 * feeds, all the way to the ends.
 *
 * Not just the immediate neighbours. The question this answers is "where does
 * this actually go" -- a track through a group send through the master to a
 * pair of output lanes -- and stopping one hop out would answer a different,
 * less useful question. Once a rig has thirty strips the diagram is mostly
 * wires; being able to pick one and have the rest fall back is what makes it
 * readable at all.
 *
 * Both directions are walked breadth-first with a visited set, so a routing
 * loop (which the engine forbids, but nothing here should depend on that)
 * terminates instead of hanging the render.
 */
export function pathThrough(
  edges: MixGraphEdge[],
  stripId: string,
): FocusedPath {
  const strips = new Set<string>([stripId]);
  const kept = new Set<number>();

  const walk = (direction: "up" | "down") => {
    const frontier = [stripId];
    const seen = new Set<string>([stripId]);
    while (frontier.length > 0) {
      const node = frontier.pop() as string;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const matches = direction === "down" ? e.from === node : e.to === node;
        if (!matches) continue;
        kept.add(i);
        const next = direction === "down" ? e.to : e.from;
        strips.add(next);
        if (seen.has(next)) continue;
        seen.add(next);
        frontier.push(next);
      }
    }
  };

  walk("down");
  walk("up");
  return { strips, edges: kept };
}
