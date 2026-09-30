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
