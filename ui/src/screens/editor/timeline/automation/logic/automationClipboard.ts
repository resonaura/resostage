/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

export interface AutomationClipboardPoint {
  offsetBeats: number;
  value: number;
  curve: number;
}

export interface AutomationPointClipboard {
  spanBeats: number;
  points: AutomationClipboardPoint[];
  sourceDomain?: string;
  sourceParameterId?: string;
}

let activeClipboard: AutomationPointClipboard | null = null;

export function setAutomationClipboard(data: AutomationPointClipboard | null): void {
  activeClipboard = data;
}

export function getAutomationClipboard(): AutomationPointClipboard | null {
  return activeClipboard;
}

export function hasAutomationClipboard(): boolean {
  return activeClipboard !== null && activeClipboard.points.length > 0;
}

export function clearAutomationClipboard(): void {
  activeClipboard = null;
}
