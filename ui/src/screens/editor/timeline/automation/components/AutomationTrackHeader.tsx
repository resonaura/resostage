/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ComponentProps, ReactNode } from "react";
import { AutomationTrackControls } from "@/screens/editor/timeline/automation/components/AutomationTrackControls";

/** Crossfade within the original row, never append height only to the sidebar. */
export function AutomationTrackHeader({ height, visible, children, ...controls }:
  ComponentProps<typeof AutomationTrackControls> & { height: number; visible: boolean; children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  return <div className="relative overflow-hidden" style={{ height }}>
    <AnimatePresence initial={false}>
      <motion.div key={visible ? "automation" : "strip"} className="absolute inset-0"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.15 }}>
        {visible ? <div className="flex h-full flex-col justify-center bg-background-secondary">
          {height >= 44 && <div className="truncate px-2 text-xs font-semibold text-foreground" title={controls.track.name}>{controls.track.name}</div>}
          <AutomationTrackControls {...controls} />
        </div> : children}
      </motion.div>
    </AnimatePresence>
  </div>;
}
