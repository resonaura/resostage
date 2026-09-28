import { Separator, Switch } from "@heroui/react";
import { Music } from "lucide-react";
import { useRef } from "react";
import { createEditGesture } from "../../lib/interaction/editGesture";
import { builder, mixer } from "../../lib/state/api";
import type { MidiRegionRow, TrackRow } from "../../lib/state/types";
import { LabeledSlider } from "../light/LightControls";
import { SidePanelShell } from "../timeline/SidePanelShell";
import { TrackStateButtons } from "../timeline/TrackStateButtons";
import { Select } from "../ui";

export function MidiRegionSidePanel({
  songIndex,
  region,
  track,
  trackIndex,
  persisted,
}: {
  songIndex: number;
  region: MidiRegionRow;
  track: TrackRow | null;
  trackIndex: number;
  persisted: boolean;
}) {
  const gesture = useRef(createEditGesture()).current;
  const patch = (
    fields: Omit<
      Parameters<typeof builder.midiRegionUpdate>[0],
      "songIndex" | "regionId"
    >,
  ) => {
    if (!persisted) return;
    void builder.midiRegionUpdate({
      songIndex,
      regionId: region.id,
      gestureId: gesture.id(),
      ...fields,
    });
  };

  return (
    <SidePanelShell
      title="Track & Region"
      icon={<Music size={13} />}
      storageKey="resostage.pianoroll.regionPanelOpen"
      hasSelection
      selectionLabel={region.name || "MIDI Region"}
    >
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-xs font-semibold">
            {region.name || "MIDI Region"}
          </span>
          <span className="truncate text-[10px] text-muted">
            {track?.name ?? region.trackId} · MIDI
          </span>
        </div>

        <Separator />
        <span className="text-[11px] font-semibold">
          Track · {track?.name ?? "MIDI"}
        </span>
        {track && trackIndex >= 0 && (
          <>
            <TrackStateButtons track={track} index={trackIndex} focused />
            <div className="flex items-center justify-between text-[10px] text-muted">
              <span>MIDI input</span>
              <span className="text-foreground">
                {track.midiInputDevice || "All"} · Ch {track.midiInputChannel || "All"}
              </span>
            </div>
            <Select
              aria-label="MIDI input channel"
              options={[
                { id: "0", label: "All channels" },
                ...Array.from({ length: 16 }, (_, index) => ({
                  id: String(index + 1),
                  label: `Channel ${index + 1}`,
                })),
              ]}
              value={String(track.midiInputChannel ?? 0)}
              onChange={(value) => void mixer.setTrackInputSource(
                trackIndex,
                track.inputSource ?? "none",
                Number(value),
                track.midiInputDevice ?? "all",
              )}
            />
          </>
        )}

        <Separator />
        <span className="text-[11px] font-semibold">Region · MIDI</span>
        {!persisted && (
          <p className="text-[10px] leading-snug text-muted">
            Default Settings · draw a note to create this region.
          </p>
        )}
        <div className="flex items-center justify-between text-[11px] font-semibold">
          <span>Mute</span>
          <Switch
            aria-label="Mute MIDI region"
            isSelected={region.muted ?? false}
            isDisabled={!persisted}
            onChange={(muted) => patch({ muted })}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] font-semibold">
          <span>Loop</span>
          <Switch
            aria-label="Loop MIDI region"
            isSelected={region.loop}
            isDisabled={!persisted}
            onChange={(loop) => patch({ loop })}
          />
        </div>
        <LabeledSlider
          label="Position"
          defaultValue={0}
          value={region.startBeats}
          min={0}
          max={Math.max(64, region.startBeats + region.durationBeats)}
          step={0.25}
          format={(value) => `${value.toFixed(2)} beats`}
          onChange={(startBeats) => patch({ startBeats })}
        />
        <LabeledSlider
          label="Length"
          defaultValue={4}
          value={region.durationBeats}
          min={0.25}
          max={Math.max(64, region.durationBeats * 2)}
          step={0.25}
          format={(value) => `${value.toFixed(2)} beats`}
          onChange={(durationBeats) => patch({ durationBeats })}
        />
        {region.loop && (
          <LabeledSlider
            label="Loop length"
            defaultValue={region.durationBeats}
            value={region.loopLengthBeats}
            min={0.25}
            max={Math.max(64, region.durationBeats * 2)}
            step={0.25}
            format={(value) => `${value.toFixed(2)} beats`}
            onChange={(loopLengthBeats) => patch({ loopLengthBeats })}
          />
        )}
      </div>
    </SidePanelShell>
  );
}
