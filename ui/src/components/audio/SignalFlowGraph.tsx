import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AudioLines,
  CircleSlash,
  Headphones,
  Speaker,
  Timer,
  TriangleAlert,
  Volume2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { resolveCssVar, withHexAlpha } from "../../lib/cssColor";
import { extOutColor, masterColor, sendColor } from "../../lib/mixerColors";
import { roleColor } from "../../lib/theme";
import { useThemeVersion } from "../../hooks/useThemeVersion";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  formatDb,
  formatPan,
  layoutSignalFlow,
  pathThrough,
  sourceChannelLabel,
  type MixGraphPayload,
  type MixGraphStrip,
  type MixStripKind,
} from "./signalFlowLayout";

/**
 * The signal flow, drawn from the graph the audio thread is actually
 * rendering (fetched from /api/v1/audio/mixgraph, which projects the engine's
 * MixGraph verbatim). Nothing here re-derives routing: if the diagram and the
 * sound ever disagreed, the diagram would be useless.
 *
 * Colour is meaning, not decoration:
 *   accent   the FOH master
 *   warning  aux / group sends
 *   success  physical output lanes
 *   default  tracks and the metronome
 *   danger   anything currently silenced (muted, or solo'd out)
 */

const KIND_STYLE: Record<
  MixStripKind,
  { ring: string; chip: string; icon: React.ReactNode; label: string }
> = {
  track: {
    ring: "border-default/50",
    chip: "bg-default/30 text-foreground/70",
    icon: <AudioLines size={12} />,
    label: "Track",
  },
  click: {
    ring: "border-default/50",
    chip: "bg-default/30 text-foreground/70",
    icon: <Timer size={12} />,
    label: "Metronome",
  },
  send: {
    ring: "border-warning/50",
    chip: "bg-warning/20 text-warning",
    icon: <Headphones size={12} />,
    label: "Send",
  },
  main: {
    ring: "border-accent/60",
    chip: "tint--soft text-accent",
    icon: <Volume2 size={12} />,
    label: "Master",
  },
  output: {
    ring: "border-success/50",
    chip: "bg-success/20 text-success",
    icon: <Speaker size={12} />,
    label: "Output",
  },
};

type StripNodeData = { strip: MixGraphStrip; dimmed: boolean };

function StripNode({ data }: NodeProps<Node<StripNodeData>>) {
  const s = data.strip;
  const dimmed = data.dimmed;
  const style = KIND_STYLE[s.kind];
  const isLane = s.kind === "output";
  const shadow = isLane && s.physicalChannel < 0;
  // Solo'd out is a different failure from muted, and on a stage you need to
  // tell them apart instantly -- so they get different words, not one "off".
  const silencedBySolo = !s.audible && !s.mute;

  return (
    <div
      className={`flex h-[74px] w-[190px] flex-col justify-between rounded-lg border bg-background-secondary px-2.5 py-1.5 transition-opacity ${
        style.ring
      } ${dimmed ? "opacity-15" : s.audible ? "opacity-100" : "opacity-55"}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-0 !bg-foreground/30"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-0 !bg-foreground/30"
      />

      <div className="flex items-center gap-1.5">
        <span
          className={`flex items-center gap-1 rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide ${style.chip}`}
        >
          {style.icon}
          {style.label}
        </span>
        {s.solo && (
          <span className="rounded tint--soft px-1 py-px text-[9px] font-bold text-accent">
            SOLO
          </span>
        )}
        {s.mute && (
          <span className="flex items-center gap-0.5 rounded bg-danger/20 px-1 py-px text-[9px] font-bold text-danger">
            <CircleSlash size={9} />
            MUTE
          </span>
        )}
        {silencedBySolo && (
          <span className="rounded bg-danger/15 px-1 py-px text-[9px] font-bold text-danger/80">
            SOLO'D OUT
          </span>
        )}
        {shadow && (
          <span
            className="flex items-center gap-0.5 rounded bg-warning/20 px-1 py-px text-[9px] font-bold text-warning"
            title="Referenced by the project, but this channel is not on the current device"
          >
            <TriangleAlert size={9} />
            OFFLINE
          </span>
        )}
      </div>

      <div
        className="truncate text-[12px] font-semibold text-foreground"
        title={s.name || s.id}
      >
        {s.name || s.id}
      </div>

      <div className="flex items-center justify-between text-[9px] font-mono text-foreground/45">
        <span className="truncate" title={s.id}>
          {isLane
            ? s.physicalChannel >= 0
              ? `ch ${s.physicalChannel + 1}`
              : "no channel"
            : `${formatDb(s.gainDb)} dB · ${formatPan(s.pan)} · ${
                s.channels === 1 ? "mono" : "stereo"
              }`}
        </span>
        <span
          className={
            s.peakDb > -3
              ? "text-danger"
              : s.peakDb > -9
                ? "text-warning"
                : "text-foreground/45"
          }
        >
          {formatDb(s.peakDb)}
        </span>
      </div>
    </div>
  );
}

const NODE_TYPES = { strip: StripNode };

function edgeLabel(
  level: number,
  preFader: boolean,
  sourceChannel: number,
): string {
  const parts: string[] = [];
  // A plain 100% main route needs no label -- only the things that differ
  // from "all of it, straight through" are worth the ink.
  if (Math.round(level) !== 100) parts.push(`${Math.round(level)}%`);
  if (preFader) parts.push("pre");
  const channel = sourceChannelLabel(sourceChannel);
  if (channel) parts.push(channel);
  return parts.join(" · ");
}

export function SignalFlowGraph({ graph }: { graph: MixGraphPayload }) {
  /**
   * The strip whose path is being followed.
   *
   * Hover picks it up, clicking pins it. Pinning matters because the reason to
   * trace a path is usually to read the numbers along it -- levels, pre/post,
   * channel splits -- and the pointer has to leave the node to do that, which
   * would drop a hover-only focus exactly when it became useful.
   */
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const focusId = pinnedId ?? hoverId;
  // React Flow writes these into SVG styles, which cannot resolve var(), so
  // every one has to be a concrete colour. Resolved per render rather than
  // memoised on the theme version -- resolveCssVar is already a cached DOM
  // probe, and a memo keyed on the version is what went stale elsewhere.
  const themeVersion = useThemeVersion();

  const flowColors = useMemo(() => {
    const ink = resolveCssVar("--foreground", "#ffffff");
    return {
      edgeActive: withHexAlpha(ink, "59"), // ~35%
      edgePreFader: withHexAlpha(roleColor("send"), "bf"), // ~75%
      edgeSilenced: withHexAlpha(roleColor("meterClip"), "59"),
      label: withHexAlpha(ink, "a6"), // ~65%
      labelBg: withHexAlpha(resolveCssVar("--overlay", "#111111"), "8c"),
      dots: withHexAlpha(ink, "12"),
      mask: withHexAlpha(resolveCssVar("--background", "#000000"), "99"),
      unknownNode: resolveCssVar("--muted", "#6b7280"),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeVersion]);

  // Recomputed only when the focus moves, not per edge: a rig with thirty
  // strips has hundreds of edges and this runs on every pointer move over a
  // node otherwise.
  const focused = useMemo(
    () => (focusId ? pathThrough(graph.edges, focusId) : null),
    [graph.edges, focusId],
  );

  const { nodes, edges } = useMemo(() => {
    const placed = layoutSignalFlow(graph);
    const nodes: Node<StripNodeData>[] = placed.map((item) => ({
      id: item.strip.id,
      type: "strip",
      position: { x: item.x, y: item.y },
      data: {
        strip: item.strip,
        dimmed: focused != null && !focused.strips.has(item.strip.id),
      },
      draggable: true,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }));

    const edgeList: Edge[] = graph.edges.map((e, i) => {
      const label = edgeLabel(e.level, e.preFader, e.sourceChannel);
      // Off-path wires fade rather than disappear: the shape of the rest of
      // the rig is the context that makes one path mean something.
      const offPath = focused != null && !focused.edges.has(i);
      return {
        id: `${e.from}->${e.to}#${i}`,
        source: e.from,
        target: e.to,
        // Deliberately NOT React Flow's `animated`: that renders a dashed
        // marching line, which would collide with dashes meaning "silenced".
        // Dash is reserved for one thing here.
        animated: false,
        label: label || undefined,
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
        labelBgStyle: { fill: flowColors.labelBg },
        style: {
          // A silenced edge stays visible but clearly dead: hiding it would
          // make a muted track look like it was never routed at all.
          stroke: e.active
            ? e.preFader
              ? flowColors.edgePreFader
              : flowColors.edgeActive
            : flowColors.edgeSilenced,
          strokeWidth: offPath ? 1 : e.active ? 1.5 : 1,
          strokeDasharray: e.active ? undefined : "4 3",
          opacity: offPath ? 0.12 : 1,
          transition: "opacity 140ms ease-out",
        },
        labelStyle: {
          fill: flowColors.label,
          fontSize: 9,
          opacity: offPath ? 0 : 1,
        },
      };
    });

    return { nodes, edges: edgeList };
  }, [graph, flowColors, focused]);

  const onNodeEnter = useCallback(
    (_e: React.MouseEvent, node: Node) => setHoverId(node.id),
    [],
  );
  const onNodeLeave = useCallback(() => setHoverId(null), []);
  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node) =>
      setPinnedId((p) => (p === node.id ? null : node.id)),
    [],
  );
  const onPaneClick = useCallback(() => setPinnedId(null), []);

  if (graph.strips.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-foreground/40">
        No routing to show — open a project first.
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodeMouseEnter={onNodeEnter}
      onNodeMouseLeave={onNodeLeave}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      fitView
      minZoom={0.1}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      edgesFocusable={false}
      colorMode="dark"
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={18}
        size={1}
        color={flowColors.dots}
      />
      <MiniMap
        pannable
        zoomable
        maskColor={flowColors.mask}
        className="!bg-background-secondary"
        nodeColor={(n) => {
          const kind = (n.data as StripNodeData | undefined)?.strip.kind;
          if (kind === "main") return masterColor();
          if (kind === "send") return sendColor();
          if (kind === "output") return extOutColor();
          return flowColors.unknownNode;
        }}
      />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
