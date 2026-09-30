import { Footprints } from "lucide-react";
import { Popover, Tooltip } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { patchClickFields } from "../../screens/mixer/logic/mixerUtils";
import type { SongRow, WebUiState } from "../../lib/state/types";
import { ToggleButton } from "../../components/ui";
import { recordTempoTap } from "../logic/tapTempo";

/** Tempo, meter, and Tap Tempo controls for the currently focused song. */
export function SongTempoControl({
  state,
  song,
  songTitle,
  bpm,
  tsNum,
  tsDen,
}: {
  state: WebUiState;
  song: SongRow | null;
  songTitle: string;
  bpm: number;
  tsNum: number;
  tsDen: number;
}) {
  const [meterOpen, setMeterOpen] = useState(false);
  const [draftBpm, setDraftBpm] = useState("");
  const [draftNumerator, setDraftNumerator] = useState("");
  const [draftDenominator, setDraftDenominator] = useState("");
  const tapTimesRef = useRef<number[]>([]);
  const [tapTempoBpm, setTapTempoBpm] = useState<number | null>(null);

  useEffect(() => {
    tapTimesRef.current = [];
    setTapTempoBpm(null);
  }, [state.songIndex]);

  useEffect(() => {
    if (tapTempoBpm !== null && Math.abs(tapTempoBpm - bpm) < 0.05)
      setTapTempoBpm(null);
  }, [bpm, tapTempoBpm]);

  const tapTempo = () => {
    if (!song) return;
    const result = recordTempoTap(tapTimesRef.current, performance.now());
    tapTimesRef.current = result.times;
    if (result.bpm === undefined) return;
    setTapTempoBpm(result.bpm);
    patchClickFields(state, { bpm: result.bpm });
  };

  const openMeter = (open: boolean) => {
    if (open) {
      setDraftBpm(String(bpm));
      setDraftNumerator(String(tsNum));
      setDraftDenominator(String(tsDen));
    }
    setMeterOpen(open);
  };

  const commitMeter = () => {
    const nextBpm = Number(draftBpm);
    const nextNum = Number(draftNumerator);
    const nextDen = Number(draftDenominator);
    if (
      !song ||
      !Number.isFinite(nextBpm) ||
      nextBpm < 20 ||
      nextBpm > 400 ||
      !Number.isInteger(nextNum) ||
      nextNum < 1 ||
      nextNum > 32 ||
      ![1, 2, 4, 8, 16, 32].includes(nextDen)
    )
      return;
    patchClickFields(state, {
      bpm: nextBpm,
      tsNum: nextNum,
      tsDen: nextDen,
    });
    setMeterOpen(false);
  };

  const shownBpm = tapTempoBpm ?? bpm;

  return (
    <>
      <Popover isOpen={meterOpen} onOpenChange={openMeter}>
        <button
          type="button"
          disabled={!song}
          className="flex h-7 w-28 shrink-0 flex-col justify-center rounded-md px-2 text-center transition-colors hover:bg-default/10 disabled:opacity-40 sm:w-36"
          title={`${songTitle || "Song"} · Edit tempo and meter`}
          aria-label="Edit song tempo and time signature"
        >
          <span className="font-mono text-[11px] font-semibold leading-tight tabular-nums text-foreground/85">
            {Number.isInteger(shownBpm) ? shownBpm : shownBpm.toFixed(1)} BPM
          </span>
          <span className="font-mono text-[10px] leading-tight tabular-nums text-foreground/50">
            {tsNum}/{tsDen}
          </span>
        </button>
        <Popover.Content className="w-64 rounded-xl border border-default/30 bg-surface shadow-xl">
          <Popover.Dialog>
            <form
              className="space-y-3 p-3"
              onSubmit={(event) => {
                event.preventDefault();
                commitMeter();
              }}
            >
              <div className="truncate text-xs font-semibold text-foreground/65">
                {songTitle}
              </div>
              <label className="block text-[10px] text-foreground/55">
                Tempo (BPM)
                <input
                  type="number"
                  min="20"
                  max="400"
                  step="0.1"
                  value={draftBpm}
                  onChange={(event) => setDraftBpm(event.target.value)}
                  className="mt-1 w-full rounded-md border border-default/40 bg-background px-2 py-1 text-sm text-foreground"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] text-foreground/55">
                  Beats/bar
                  <input
                    type="number"
                    min="1"
                    max="32"
                    value={draftNumerator}
                    onChange={(event) => setDraftNumerator(event.target.value)}
                    className="mt-1 w-full rounded-md border border-default/40 bg-background px-2 py-1 text-sm text-foreground"
                  />
                </label>
                <label className="text-[10px] text-foreground/55">
                  Beat unit
                  <select
                    value={draftDenominator}
                    onChange={(event) => setDraftDenominator(event.target.value)}
                    className="mt-1 w-full rounded-md border border-default/40 bg-background px-2 py-1 text-sm text-foreground"
                  >
                    {[1, 2, 4, 8, 16, 32].map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                type="submit"
                className="w-full rounded-md bg-accent px-2 py-1.5 text-xs font-semibold text-accent-foreground"
              >
                Apply
              </button>
            </form>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      <Tooltip>
        <ToggleButton
          isIconOnly
          size="sm"
          isSelected={false}
          isDisabled={!song}
          onPress={tapTempo}
          aria-label="Tap Tempo"
          variant="ghost"
          className="h-7 w-7 min-w-7 text-foreground/70 hover:text-accent disabled:opacity-40"
        >
          <Footprints size={15} aria-hidden="true" />
        </ToggleButton>
        <Tooltip.Content>Tap Tempo · tap in time to set the song BPM</Tooltip.Content>
      </Tooltip>
    </>
  );
}
