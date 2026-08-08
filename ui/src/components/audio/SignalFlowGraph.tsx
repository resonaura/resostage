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
import { useMemo } from "react";
import { extOutColor, masterColor, sendColor } from "../../lib/mixerColors";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  formatDb,
  formatPan,
  layoutSignalFlow,
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

type StripNodeData = { strip: MixGraphStrip };

function StripNode({ data }: NodeProps<Node<StripNodeData>>) {
  const s = data.strip;
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
      } ${s.audible ? "opacity-100" : "opacity-55"}`}
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
  const { nodes, edges } = useMemo(() => {
    const placed = layoutSignalFlow(graph);
    const nodes: Node<StripNodeData>[] = placed.map((item) => ({
      id: item.strip.id,
      type: "strip",
      position: { x: item.x, y: item.y },
      data: { strip: item.strip },
      draggable: true,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }));

    const edgeList: Edge[] = graph.edges.map((e, i) => {
      const label = edgeLabel(e.level, e.preFader, e.sourceChannel);
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
        labelBgStyle: { fill: "rgba(0,0,0,0.55)" },
        labelStyle: { fill: "rgba(255,255,255,0.65)", fontSize: 9 },
        style: {
          // A silenced edge stays visible but clearly dead: hiding it would
          // make a muted track look like it was never routed at all.
          stroke: e.active
            ? e.preFader
              ? "rgba(255,146,48,0.75)"
              : "rgba(255,255,255,0.35)"
            : "rgba(255,69,58,0.35)",
          strokeWidth: e.active ? 1.5 : 1,
          strokeDasharray: e.active ? undefined : "4 3",
        },
      };
    });

    return { nodes, edges: edgeList };
  }, [graph]);

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
        color="rgba(255,255,255,0.07)"
      />
      <MiniMap
        pannable
        zoomable
        maskColor="rgba(0,0,0,0.6)"
        className="!bg-background-secondary"
        nodeColor={(n) => {
          const kind = (n.data as StripNodeData | undefined)?.strip.kind;
          if (kind === "main") return masterColor();
          if (kind === "send") return sendColor();
          if (kind === "output") return extOutColor();
          return "#6b7280";
        }}
      />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
