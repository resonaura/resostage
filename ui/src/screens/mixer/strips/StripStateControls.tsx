/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { StripButton } from "@/screens/mixer/strips/StripButton";
import { Workflow } from "lucide-react";

export function StripStateControls({
  isNarrow,
  recordArmed,
  inputMonitoring,
  isRecording,
  isFocused = false,
  onRecordArm,
  onInputMonitor,
  onShowSignalFlow,
  audioFlowOpen = false,
  audioFlowLabel = "this bus",
  mute,
  solo,
  soloSafe,
  isDimmed,
  onMute,
  onSolo,
  onSoloSafe,
}: {
  isNarrow: boolean;
  recordArmed?: boolean;
  inputMonitoring?: boolean;
  isRecording: boolean;
  isFocused?: boolean;
  onRecordArm?: () => void;
  onInputMonitor?: () => void;
  onShowSignalFlow?: () => void;
  audioFlowOpen?: boolean;
  audioFlowLabel?: string;
  mute: boolean;
  solo: boolean;
  soloSafe: boolean;
  isDimmed: boolean;
  onMute: () => void;
  onSolo: () => void;
  onSoloSafe?: (safe: boolean) => void;
}) {
  return (
    <div className="mt-auto flex w-full shrink-0 flex-col gap-1 pt-1 px-1 border-t border-default/15">
      {(onRecordArm || onInputMonitor) && (
        <div className="flex w-full gap-1">
          <div className="flex-1" aria-hidden="true" />
          <div
            className={`flex flex-1 items-center ${isNarrow ? "gap-0.5" : "gap-1"}`}
          >
            {onRecordArm && (
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onRecordArm}
                title={
                  recordArmed
                    ? isRecording
                      ? "Recording active"
                      : "Record Armed (Click to disarm)"
                    : isFocused
                      ? "Focused track — click to record-arm"
                      : "Record Arm (Click to arm)"
                }
                aria-label={
                  recordArmed
                    ? "Record armed"
                    : isFocused
                      ? "Focused track — click to record-arm"
                      : "Record Arm"
                }
                className={`relative flex h-4.5 flex-1 items-center justify-center rounded border text-[9px] font-bold transition-all select-none ${
                  recordArmed
                    ? isRecording
                      ? "border-(--rs-record) bg-(--rs-record) text-white shadow-[0_0_8px_rgba(255,59,48,0.7)]"
                      : "border-(--rs-record) bg-(--rs-record)/20 text-(--rs-record) rs-recording-blink font-bold"
                    : isFocused
                      ? "border-(--rs-record)/40 bg-surface/60 text-(--rs-record) font-black hover:border-(--rs-record)/80"
                      : "border-default/30 bg-surface/60 text-foreground/75 hover:border-(--rs-record)/60 hover:text-(--rs-record)"
                }`}
              >
                {isRecording ? (
                  <span className="w-1.5 h-1.5 rounded-full bg-white shadow-sm" />
                ) : (
                  "R"
                )}
              </button>
            )}
            {onInputMonitor && (
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onInputMonitor}
                title={
                  inputMonitoring
                    ? "Input Monitoring Active"
                    : isFocused
                      ? "Focused track — input monitored automatically"
                      : "Input Monitoring"
                }
                aria-label={
                  inputMonitoring
                    ? "Input monitoring enabled"
                    : isFocused
                      ? "Focused track — input monitored automatically"
                      : "Input Monitoring"
                }
                className={`relative flex h-4.5 flex-1 items-center justify-center rounded border text-[9px] font-bold transition-all select-none ${
                  inputMonitoring
                    ? "border-(--rs-monitor) bg-(--rs-monitor) text-black font-bold shadow-[0_0_8px_rgba(255,149,0,0.5)]"
                    : isFocused
                      ? "border-(--rs-monitor)/40 bg-surface/60 text-(--rs-monitor) font-black hover:border-(--rs-monitor)/80"
                      : "border-default/30 bg-surface/60 text-foreground/75 hover:bg-surface hover:text-foreground"
                }`}
              >
                I
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex w-full gap-1">
        {onShowSignalFlow && (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onShowSignalFlow}
            title={`Show audio flow for ${audioFlowLabel}`}
            aria-label={`Show audio flow for ${audioFlowLabel}`}
            aria-pressed={audioFlowOpen}
            className={`relative flex h-6 flex-1 items-center justify-center rounded border transition-all select-none ${
              audioFlowOpen
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-default/30 bg-surface/60 text-foreground/75 hover:bg-surface hover:text-foreground"
            }`}
          >
            <Workflow size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
        <StripButton
          active={mute}
          variant="mute"
          blink={isDimmed && !mute}
          title={mute ? "Mute (Active)" : "Mute"}
          onPress={() => onMute()}
        >
          M
        </StripButton>
        <StripButton
          active={solo}
          variant="solo"
          soloSafe={soloSafe}
          title={
            soloSafe
              ? "Solo-Safe Isolate Active (Ctrl+Click or Right-Click to toggle)"
              : "Solo (Ctrl+Click or Right-Click to toggle Solo-Safe)"
          }
          onPress={(event) => {
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault();
              onSoloSafe?.(!soloSafe);
            } else {
              onSolo();
            }
          }}
          onContextMenu={(event) => {
            if (onSoloSafe) {
              event.preventDefault();
              onSoloSafe(!soloSafe);
            }
          }}
        >
          S
        </StripButton>
      </div>
    </div>
  );
}
