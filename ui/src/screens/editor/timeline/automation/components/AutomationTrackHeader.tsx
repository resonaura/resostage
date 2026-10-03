/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useMemo, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui";
import { AutomationTrackControls } from "@/screens/editor/timeline/automation/components/AutomationTrackControls";
import {
  automationLaneCollapseKey,
  automationPseudoTrackHeightPx,
} from "@/screens/editor/timeline/automation/logic/automationLayout";
import { getTrackAutomationTargets } from "@/screens/editor/timeline/automation/logic/automationTargets";

/** The track header and every automation pseudo-track share body row geometry. */
export function AutomationTrackHeader({
  height,
  visible,
  children,
  collapseScope,
  collapsedLaneKeys,
  onToggleLane,
  ...controls
}: ComponentProps<typeof AutomationTrackControls> & {
  height: number;
  visible: boolean;
  children?: ReactNode;
  collapseScope: string;
  collapsedLaneKeys: ReadonlySet<string>;
  onToggleLane: (key: string) => void;
}) {
  const reducedMotion = useReducedMotion();
  const lanes = controls.lanes;
  const targetGroups = useMemo(
    () => getTrackAutomationTargets(controls.track, controls.buses, lanes, controls.parameters),
    [controls.track, controls.buses, lanes, controls.parameters],
  );
  const targetOptions = useMemo(
    () => targetGroups.flatMap((group) => group.targets),
    [targetGroups],
  );
  const laneHeights = lanes.map((lane) => automationPseudoTrackHeightPx(
    height,
    collapsedLaneKeys.has(automationLaneCollapseKey(collapseScope, lane.id)),
  ));
  const totalHeight = height + (visible ? laneHeights.reduce((sum, laneHeight) => sum + laneHeight, 0) : 0);
  const duration = reducedMotion ? 0 : 0.15;

  return (
    <div className="relative overflow-hidden" style={{ height: totalHeight }}>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={visible ? "automation" : "strip"}
          className="absolute inset-x-0 top-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration }}
        >
          {visible ? (
            <>
              <div
                className="flex items-center justify-between border-b border-default/20 bg-background-secondary px-2 text-[10px] font-semibold text-foreground/70"
                style={{ height }}
              >
                {lanes.length > 0 ? (
                  <>
                    <span className="truncate">Automation · {controls.track.name}</span>
                    <span className="shrink-0 tabular-nums text-foreground/45">{lanes.length}</span>
                  </>
                ) : (
                  <AutomationTrackControls
                    {...controls}
                    targetGroups={targetGroups}
                    targetOptions={targetOptions}
                    compact={height <= 32}
                    showAdd
                  />
                )}
              </div>
              {lanes.map((lane, index) => {
                const key = automationLaneCollapseKey(collapseScope, lane.id);
                const collapsed = collapsedLaneKeys.has(key);
                const rowHeight = laneHeights[index] ?? automationPseudoTrackHeightPx(height, false);
                return (
                  <div
                    key={lane.id}
                    data-automation-lane-row={lane.id}
                    className="flex min-w-0 items-center border-b border-default/15 bg-background-secondary/90"
                    style={{ height: rowHeight }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onContextMenu={(event) => event.stopPropagation()}
                  >
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      aria-label={`${collapsed ? "Expand" : "Collapse"} automation lane ${index + 1}`}
                      aria-expanded={!collapsed}
                      className="h-6 min-w-6 w-6 shrink-0"
                      onPress={() => onToggleLane(key)}
                    >
                      <motion.span
                        className="flex"
                        animate={{ rotate: collapsed ? -90 : 0 }}
                        transition={{ duration }}
                      >
                        <ChevronDown size={13} />
                      </motion.span>
                    </Button>
                    <AutomationTrackControls
                      {...controls}
                      targetGroups={targetGroups}
                      targetOptions={targetOptions}
                      laneId={lane.id}
                      activeLaneId={lane.id}
                      compact={rowHeight <= 36}
                      showAdd={index === lanes.length - 1}
                    />
                  </div>
                );
              })}
            </>
          ) : (
            children
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
