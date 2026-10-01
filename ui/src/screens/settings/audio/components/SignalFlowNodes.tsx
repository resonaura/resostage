/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { AudioLines, Headphones, Music2, Speaker, Timer, Volume2 } from "lucide-react";
import type { SignalFlowNode } from "@/screens/settings/audio/logic/signalFlowModel";
import { NODE_HEIGHT, NODE_WIDTH, formatDb, formatPan } from "@/screens/settings/audio/logic/signalFlowLayout";
import { withHexAlpha } from "@/lib/theme/cssColor";

export type FlowNodeData = { node: SignalFlowNode; dimmed: boolean; color: string };

const AUDIO_KINDS = {
  track: { label: "Track", icon: <AudioLines size={12} /> },
  click: { label: "Metronome", icon: <Timer size={12} /> },
  send: { label: "Aux", icon: <Headphones size={12} /> },
  main: { label: "Master", icon: <Volume2 size={12} /> },
  output: { label: "Physical output", icon: <Speaker size={12} /> },
};

export function SignalFlowNodeCard({ data }: NodeProps<Node<FlowNodeData>>) {
  const { node, color, dimmed } = data;
  const strip = "strip" in node ? node.strip : null;
  const isDestination = node.kind === "output" || node.kind === "midi-output";
  const isSource = ["midi-input", "midi-sequencer", "midi-events", "midi-transport"].includes(node.kind);
  const unavailable = strip ? strip.kind === "output" && strip.physicalChannel < 0 : Boolean("unavailable" in node && node.unavailable);
  const title = strip ? strip.name || strip.id : "name" in node ? node.name : node.id;
  const kind = strip ? AUDIO_KINDS[strip.kind] : { label: node.kind === "midi-input" ? "MIDI input" : node.kind === "midi-output" ? "MIDI destination" : "MIDI", icon: <Music2 size={12} /> };

  return (
    <div
      className={`flex flex-col justify-between rounded-lg border bg-background-secondary px-2.5 py-1.5 transition-opacity ${dimmed ? "opacity-15" : strip && !strip.audible ? "opacity-55" : "opacity-100"}`}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT, borderColor: withHexAlpha(color, "85") }}
    >
      {!isSource && <Handle type="target" position={Position.Left} className="h-2! w-2! border-0!" style={{ background: color }} />}
      {!isDestination && <Handle type="source" position={Position.Right} className="h-2! w-2! border-0!" style={{ background: color }} />}
      <div className="flex items-center gap-1 whitespace-nowrap text-[9px] font-bold uppercase tracking-wide">
        <span className="flex items-center gap-1 rounded px-1 py-px" style={{ color, background: withHexAlpha(color, "26") }}>
          {kind.icon}{kind.label}
        </span>
        {strip?.solo && <span className="rounded bg-warning/20 px-1 text-warning">S</span>}
        {strip?.mute && <span className="rounded bg-danger/20 px-1 text-danger">Mute</span>}
        {strip && !strip.audible && !strip.mute && <span className="text-danger/80">Solo out</span>}
        {unavailable && <span className="text-warning" title="The configured endpoint is unavailable on the current device">Offline</span>}
      </div>
      <div className="truncate text-xs font-semibold text-foreground" title={title}>{title}</div>
      <div className="truncate text-[9px] text-foreground/50" title={node.detail || node.id}>
        {strip?.kind === "output" ? unavailable ? "Referenced lane · not on device" : `Device channel ${strip.physicalChannel + 1}` : node.detail || (strip ? `${strip.channels === 1 ? "Mono" : "Stereo"} audio` : "Configured MIDI route")}
      </div>
      {strip ? (
        <div className="flex items-center justify-between font-mono text-[9px] text-foreground/45">
          <span>{strip.kind === "output" ? "Physical egress" : `${formatDb(strip.gainDb)} dB · ${formatPan(strip.pan)}`}</span>
          <span className={strip.peakDb > -3 ? "text-danger" : strip.peakDb > -9 ? "text-warning" : ""}>{formatDb(strip.peakDb)} dB</span>
        </div>
      ) : <div className="text-[9px] text-foreground/35">Configured · no delivery meter</div>}
    </div>
  );
}
