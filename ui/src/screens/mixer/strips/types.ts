import type { PluginCatalogEntry } from "../../../lib/state/api";
import type {
  BusRow,
  ClickSendRow,
  PluginSlotRow,
  SettingsState,
} from "../../../lib/state/types";
import type {
  StripFormatToggle,
  StripInputRouting,
} from "./StripInputControls";

export type ChannelStripProps = {
  stripId: string;
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
  pan: number | null;
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
  isMaster?: boolean;
  shortTermLufs?: number;
  onRecordArm?: () => void;
  onInputMonitor?: () => void;
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
