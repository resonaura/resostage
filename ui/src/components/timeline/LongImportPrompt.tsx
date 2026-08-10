import { Checkbox } from "@heroui/react";
import { Scissors, MoveHorizontal } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import type { LongImportChoice } from "../../lib/importPrefs";
import { Button } from "../ui";
import type { LongImportPrompt as LongImportPromptData } from "./useLongImportGuard";

/** mm:ss.s — short enough to read in a dialog, precise enough to compare. */
function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * "This file is longer than the song. Now what?"
 *
 * Both answers are destructive-ish in opposite directions, which is why this
 * asks rather than picking: trimming loses the tail, extending moves an end
 * marker the user placed deliberately. The overrun is spelled out in seconds
 * because "longer than the song" by half a second and by four minutes call for
 * different answers.
 */
export function LongImportPrompt({
  data,
  onResolve,
  onDismiss,
}: {
  data: LongImportPromptData;
  onResolve: (choice: LongImportChoice, remember: boolean) => void;
  onDismiss: () => void;
}) {
  const [remember, setRemember] = useState(false);
  const overrun = data.regionEndSeconds - data.songEndSeconds;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[9998] bg-background/70 backdrop-blur-sm"
        onClick={onDismiss}
      />
      <div
        role="dialog"
        aria-label="Imported audio is longer than the song"
        className="fixed left-1/2 top-1/2 z-[9999] w-[26rem] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-default/40 bg-surface p-4 shadow-2xl"
      >
        <div className="text-sm font-semibold">
          This audio runs past the end of the song
        </div>
        <p className="mt-1 text-xs leading-relaxed text-foreground/60">
          It ends at {fmt(data.regionEndSeconds)}, and the song ends at{" "}
          {fmt(data.songEndSeconds)} — {fmt(overrun)} longer.
        </p>

        <div className="mt-3 flex flex-col gap-2">
          <Button
            size="sm"
            variant="accent-soft"
            className="w-full justify-start gap-2"
            onPress={() => onResolve("extend", remember)}
          >
            <MoveHorizontal size={13} className="shrink-0" />
            <span className="flex flex-col items-start leading-tight">
              Stretch the song to fit
              <span className="text-[10px] font-normal opacity-60">
                Moves the end marker to {fmt(data.regionEndSeconds)}
              </span>
            </span>
          </Button>
          <Button
            size="sm"
            variant="default-soft"
            className="w-full justify-start gap-2"
            onPress={() => onResolve("trim", remember)}
          >
            <Scissors size={13} className="shrink-0" />
            <span className="flex flex-col items-start leading-tight">
              Trim the region
              <span className="text-[10px] font-normal opacity-60">
                Cuts it at {fmt(data.songEndSeconds)}; the audio stays on disk
              </span>
            </span>
          </Button>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <Checkbox
            isSelected={remember}
            onChange={setRemember}
            className="text-[11px] text-foreground/60"
          >
            <Checkbox.Content className="gap-2">
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              Always do this
            </Checkbox.Content>
          </Checkbox>
          <Button size="sm" variant="default-soft" onPress={onDismiss}>
            Leave it
          </Button>
        </div>
      </div>
    </>,
    document.body,
  );
}
