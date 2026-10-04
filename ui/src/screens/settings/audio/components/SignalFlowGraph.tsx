/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { resolveCssVar, withHexAlpha } from "@/lib/theme/cssColor";
import { roleColor } from "@/lib/theme";
import { useThemeVersion } from "@/hooks/useThemeVersion";
import { NODE_HEIGHT, NODE_WIDTH, layoutSignalFlow, sourceChannelLabel } from "@/screens/settings/audio/logic/signalFlowLayout";
import { pathThroughSignalFlow, type SignalFlowEdge, type SignalFlowModel } from "@/screens/settings/audio/logic/signalFlowModel";
import { SignalFlowNodeCard, type FlowNodeData } from "@/screens/settings/audio/components/SignalFlowNodes";
import { signalFlowNodeColor } from "@/screens/settings/audio/logic/signalFlowColors";

const NODE_TYPES = { route: SignalFlowNodeCard };

function edgeLabel(edge: SignalFlowEdge): string {
  if (edge.protocol === "midi") return edge.label || "MIDI";
  if (edge.protocol === "sidechain") {
    const mode = edge.channelMode === "automatic" ? "auto" : edge.channelMode;
    return `SC · ${edge.pluginName || edge.pluginSlotId || "plug-in"} · bus ${edge.inputBusIndex} · ${mode}`;
  }
  const parts: string[] = [];
  if (Math.round(edge.level) !== 100) parts.push(`${Math.round(edge.level)}%`);
  if (edge.preFader) parts.push("pre");
  const channel = sourceChannelLabel(edge.sourceChannel);
  if (channel) parts.push(channel);
  return parts.join(" · ");
}

/** Audio and sidechain wiring come from Core verbatim; dotted MIDI paths describe published configuration. */
export const SignalFlowGraph = memo(function SignalFlowGraph({
  model,
  focusNodeId,
}: {
  model: SignalFlowModel;
  /** `null` explicitly shows the whole graph; undefined keeps interactive focus. */
  focusNodeId?: string | null;
}) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const focusId = focusNodeId !== undefined ? focusNodeId : pinnedId ?? hoverId;
  const themeVersion = useThemeVersion();
  const colors = useMemo(() => {
    const ink = resolveCssVar("--foreground", "#ffffff");
    return {
      silenced: withHexAlpha(roleColor("meterClip"), "80"),
      label: withHexAlpha(ink, "bf"),
      labelBg: resolveCssVar("--background-secondary", "#111111"),
      dots: withHexAlpha(ink, "12"),
      mask: withHexAlpha(resolveCssVar("--background", "#000000"), "99"),
    };
    // Resolved colour values must be recalculated when the theme invalidates
    // its CSS cache, even though the registry lookup arguments stay the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeVersion]);
  const geometryCache = useRef<{ model: SignalFlowModel; positions: Array<{ id: string; x: number; y: number }> } | null>(null);
  const placed = useMemo(() => {
    const previous = geometryCache.current;
    // Meter/fader updates do not change placement. Keep one geometry cache so
    // the bounded crossing-order sweeps only run when wiring actually changes.
    if (previous && previous.model.strips.length === model.strips.length && previous.model.edges.length === model.edges.length &&
      model.strips.every((node, index) => node.id === previous.model.strips[index].id && node.kind === previous.model.strips[index].kind) &&
      model.edges.every((edge, index) => edge.from === previous.model.edges[index].from && edge.to === previous.model.edges[index].to)) return previous.positions;
    const positions = layoutSignalFlow(model).map(({ strip, x, y }) => ({ id: strip.id, x, y }));
    geometryCache.current = { model, positions };
    return positions;
  }, [model]);
  const focused = useMemo(() => focusId
    ? pathThroughSignalFlow(model, focusId, focusNodeId != null)
    : null, [model, focusId, focusNodeId]);

  const { nodes, edges } = useMemo(() => {
    const nodeColors = new Map(model.strips.map((node) => [node.id, signalFlowNodeColor(node)]));
    const nodeById = new Map(model.strips.map((node) => [node.id, node]));
    const nodes: Node<FlowNodeData>[] = placed.map((item) => ({
      id: item.id, type: "route", position: { x: item.x, y: item.y },
      data: { node: nodeById.get(item.id)!, color: nodeColors.get(item.id)!, dimmed: focused != null && !focused.strips.has(item.id) },
      draggable: false, width: NODE_WIDTH, height: NODE_HEIGHT,
    }));
    const edges: Edge[] = model.edges.map((edge, index) => {
      const offPath = focused != null && !focused.edges.has(index);
      const midi = edge.protocol === "midi";
      const sidechain = edge.protocol === "sidechain";
      const label = edgeLabel(edge);
      // Audio routes follow their source's track/strip colour. MIDI ingress
      // follows its destination track, preserving the same visual identity.
      const color = midi && nodeColors.has(edge.to) ? nodeColors.get(edge.to)! : nodeColors.get(edge.from)!;
      return {
        id: `${edge.from}->${edge.to}#${index}`, source: edge.from, target: edge.to,
        // A higher Bézier curvature separates a configured sidechain from an
        // ordinary route with the same source and destination IDs.
        type: sidechain ? "default" : undefined,
        pathOptions: sidechain ? { curvature: 0.5 } : undefined,
        animated: false, label: label || undefined,
        labelBgPadding: [4, 2] as [number, number], labelBgBorderRadius: 3,
        labelBgStyle: { fill: colors.labelBg },
        style: {
          stroke: edge.active ? withHexAlpha(color, "b3") : midi ? withHexAlpha(color, "59") : colors.silenced,
          strokeWidth: offPath ? 1 : 1.5,
          strokeDasharray: midi ? "2 4" : sidechain ? "7 4" : edge.active ? undefined : "5 3",
          opacity: offPath ? 0.12 : 1,
          transition: "opacity 140ms ease-out",
        },
        labelStyle: { fill: colors.label, fontSize: 9, opacity: offPath ? 0 : 1 },
      };
    });
    return { nodes, edges };
  }, [model, placed, colors, focused]);

  const onNodeEnter = useCallback((_event: React.MouseEvent, node: Node) => setHoverId(node.id), []);
  const onNodeLeave = useCallback(() => setHoverId(null), []);
  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => setPinnedId((previous) => previous === node.id ? null : node.id), []);
  const onPaneClick = useCallback(() => setPinnedId(null), []);

  if (model.strips.length === 0) return <div className="flex h-full items-center justify-center text-sm text-foreground/40">No routing to show — open a project or select MIDI endpoints.</div>;
  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES}
      onNodeMouseEnter={onNodeEnter} onNodeMouseLeave={onNodeLeave} onNodeClick={onNodeClick} onPaneClick={onPaneClick}
      fitView minZoom={0.1} maxZoom={2} proOptions={{ hideAttribution: true }} nodesConnectable={false} edgesFocusable={false} colorMode="dark">
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color={colors.dots} />
      <MiniMap pannable zoomable maskColor={colors.mask} className="bg-background-secondary!" nodeColor={(node) => (node.data as FlowNodeData).color} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
});
