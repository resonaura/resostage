/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { PluginCatalogEntry } from "@/lib/state/api";
import type {
  BusRow,
  ClickSendRow,
  MeterRow,
  PluginSlotRow,
  SettingsState,
  TrackRow,
} from "@/lib/state/types";
import type {
  StripFormatToggle,
  StripInputRouting,
} from "@/screens/mixer/strips/StripInputControls";
import type { RotaryMidiTarget } from "@/components/daw/logic/rotaryMidiTarget";

export type ChannelStripProps = {
  stripId: string;
  /** Identity fence for eased telemetry readouts. */
  motionKey?: string;
  name: string;
  subtitle?: string;
  color: string;
  busses?: BusRow[];
  busId?: string;
  onBusSelect?: (id: string) => void;
  directOutput?: {
    settings: SettingsState;
    allBusses: BusRow[];
    mono?: boolean;
    onMonoChange?: (mono: boolean) => void;
    onDirectOutput: (
      mono: boolean,
      startChannel: number,
      pair: boolean,
    ) => void;
  };
  sends?: {
    auxBusses: BusRow[];
    values: ClickSendRow[];
    trackIndex: number;
    /** Overrides the default per-track write. `level` is 0-100 percent. */
    onSendChange?: (busId: string, level: number, enabled?: boolean) => void;
    onSendEnabledChange?: (busId: string, enabled: boolean) => void;
  };
  busDestination?: React.ReactNode;
  gainDb: number;
  automatedGainDb?: number | null;
  pan: number | null;
  automatedPan?: number | null;
  panMidiTarget?: RotaryMidiTarget;
  peakDb: number | undefined;
  peakDbL?: number;
  peakDbR?: number;
  getLiveDb?: () => number;
  getLiveDbL?: () => number;
  getLiveDbR?: () => number;
  mute: boolean;
  solo: boolean;
  soloSafe?: boolean;
  anySoloInGroup?: boolean;
  recordArmed?: boolean;
  inputMonitoring?: boolean;
  isRecording?: boolean;
  isFocused?: boolean;
  isMaster?: boolean;
  shortTermLufs?: number;
  onRecordArm?: () => void;
  onInputMonitor?: () => void;
  onShowSignalFlow?: () => void;
  audioFlowOpen?: boolean;
  audioFlowLabel?: string;
  formatToggle?: StripFormatToggle;
  inputRouting?: StripInputRouting;
  pluginSlots?: PluginSlotRow[];
  pluginCatalog?: PluginCatalogEntry[];
  onPlugins?: () => void;
  onGain: (value: number) => void;
  onPan: ((value: number) => void) | null;
  onMute: () => void;
  onSolo: () => void;
  onSoloSafe?: (safe: boolean) => void;
  density?: "narrow" | "standard" | "wide";
  targetPluginSlots?: number;
};

export type TrackStripProps = {
  t: TrackRow;
  motionKey?: string;
  index: number;
  destinationBusses: BusRow[];
  allBusses: BusRow[];
  auxBusses: BusRow[];
  meters: MeterRow[];
  settings: SettingsState;
  anySoloInGroup?: boolean;
  pluginCatalog: PluginCatalogEntry[];
  isRecording?: boolean;
  isFocused?: boolean;
  density?: "narrow" | "standard" | "wide";
  targetPluginSlots?: number;
  onDirectOutput: (
    trackIndex: number,
    mono: boolean,
    startChannel: number,
    pair: boolean,
  ) => void;
  onOpenPlugins: (stripId: string, stripName: string) => void;
};
