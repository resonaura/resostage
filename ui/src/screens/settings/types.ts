// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import type {
  PerformanceSettings,
  PerformanceTier,
} from "@/performance/logic/performance";
import type { ThemeName } from "@/lib/theme";

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
