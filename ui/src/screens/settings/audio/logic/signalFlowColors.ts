/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import type { SignalFlowNode } from "@/screens/settings/audio/logic/signalFlowModel";
import { extOutColor, masterColor, metronomeColor, sendColor } from "@/lib/theme/mixerColors";
import { roleColor } from "@/lib/theme";
import { getTrackColor } from "@/lib/theme/trackColors";

/** Shares project track palette positions and mixer role tokens with nodes, wires and minimap. */
export function signalFlowNodeColor(node: SignalFlowNode): string {
  if (node.kind === "main") return masterColor();
  if (node.kind === "send") return sendColor();
  if (node.kind === "click") return metronomeColor();
  if (node.kind === "output") return extOutColor();
  if ("strip" in node) return getTrackColor(node.trackIndex ?? 0);
  return roleColor("eventCc");
}
