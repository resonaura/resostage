/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type {
  AutomationDomain,
  AutomationPointRow,
  AutomationScope,
  AutomationTargetRow,
  AutomationWriteMode,
  ParameterValueType,
} from "@/lib/state/types";

export type AutomationTargetCategory = "strip" | "send" | "plugin" | "midi" | "orphan";

export interface AutomationTargetOption {
  id: string;
  domain: AutomationDomain;
  entityId: string;
  parameterId: string;
  label: string;
  category: AutomationTargetCategory;
  valueType: ParameterValueType;
  defaultValue: number;
  minValue: number;
  maxValue: number;
  unit: string;
  disabledReason?: string;
}

export type AutomationPointViewModel = AutomationPointRow;

export interface AutomationLaneViewModel {
  id: string;
  target: AutomationTargetRow;
  scope: AutomationScope;
  writeMode: AutomationWriteMode;
  enabled: boolean;
  muted: boolean;
  points: AutomationPointViewModel[];
  trackId: string;
  songIndex: number;
  isSublane?: boolean;
  color?: string;
}

export type AutomationHitResult =
  | {
      type: "point";
      pointIndex: number;
      point: AutomationPointViewModel;
    }
  | {
      type: "curveHandle";
      segmentIndexBefore: number;
      segmentIndexAfter: number;
      currentCurve: number;
      handleX: number;
      handleY: number;
    }
  | {
      type: "segment";
      segmentIndexBefore: number;
      segmentIndexAfter: number;
      u: number;
      timeBeats: number;
      interpolatedValue: number;
    }
  | {
      type: "none";
    };

export type AutomationDragMode =
  | "point"
  | "points"
  | "segment"
  | "curve"
  | "draw"
  | "marquee";

export interface AutomationDragSession {
  mode: AutomationDragMode;
  songIndex: number;
  laneId: string;
  gestureId: string;
  startClientX: number;
  startClientY: number;
  currentClientX: number;
  currentClientY: number;
  initialPoints: AutomationPointViewModel[];
  draftPoints: AutomationPointViewModel[];
  selectedIndices: Set<number>;
  activePointIndex?: number;
  activeSegmentIndexBefore?: number;
  activeSegmentIndexAfter?: number;
}
