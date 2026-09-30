import type {
  PerformanceSettings,
  PerformanceTier,
} from "../../performance/logic/performance";
import type { ThemeName } from "../../lib/theme";

export interface ThemeControls {
  name: ThemeName;
  setName: (name: ThemeName) => void;
}

export interface PerformanceControls {
  settings: PerformanceSettings;
  setSettings: (settings: PerformanceSettings) => void;
  effectiveTier: PerformanceTier;
  degraded: boolean;
}
