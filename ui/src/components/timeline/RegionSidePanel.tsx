import { EmptyState, Separator, Switch } from "@heroui/react";
import { AudioWaveform, Blend, Repeat, Rewind } from "lucide-react";
import { useMemo, useRef } from "react";
import { builder } from "../../lib/api";
import { createEditGesture } from "../../lib/editGesture";
import type { RegionRow, SongRow, TrackRow } from "../../lib/types";
import { Button, Select, ToggleButton } from "../ui";
import { Field, LabeledSlider } from "../light/LightControls";
import {
  CROSSFADE_SHAPES,
  crossfadeBetween,
  type CrossfadeRegion,
  type CrossfadeShape,
} from "./crossfade";
import { SidePanelShell } from "./SidePanelShell";
import type { RegionSelKey } from "./regionUtils";
import { lookupRegion } from "./regionUtils";

const GAIN_MIN_DB = -24;
const GAIN_MAX_DB = 12;
/** Longest fade the slider reaches. Beyond this, drag the region's corner. */
const FADE_MAX_SECONDS = 5;

function fmtSeconds(v: number): string {
  return v >= 1 ? `${v.toFixed(2)}s` : `${Math.round(v * 1000)}ms`;
}

function fmtDb(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
}

/** Which stored curve value each named shape corresponds to, for the picker. */
const SHAPE_OPTIONS = [
  { id: "equalPower", label: "Equal power" },
  { id: "linear", label: "Linear" },
  { id: "sCurve", label: "S-curve" },
] as const;

function shapeOfCurve(curve: number): CrossfadeShape | null {
  for (const [name, value] of Object.entries(CROSSFADE_SHAPES)) {
    if (Math.abs(curve - value) < 1e-6) return name as CrossfadeShape;
  }
  return null;
}

/**
 * The audio counterpart to LightSidePanel: everything about the selected
 * region that is fiddly to do by dragging.
 *
 * Dragging owns the things that are spatial -- where a region starts, how
 * long it is, roughly how long its fades are. This panel owns the rest: exact
 * fade lengths, curve shape, clip gain, loop length, and the crossfade at a
 * join, which has no handle of its own because it belongs to two regions at
 * once rather than to either.
 */
export function RegionSidePanel({
  songs,
  tracks,
  selectedRegionKeys,
  onClearSelection,
}: {
  songs: SongRow[];
  tracks: TrackRow[];
  selectedRegionKeys: RegionSelKey[];
  onClearSelection: () => void;
}) {
  // The last-clicked region is the primary, matching how the light panel
  // treats a multi-selection of cues.
  const primaryKey = selectedRegionKeys[selectedRegionKeys.length - 1] ?? null;
  const hit = primaryKey ? lookupRegion(songs, primaryKey) : null;
  const region = hit?.region ?? null;
  const songIndex = hit?.songIndex ?? 0;

  const trackName =
    tracks.find((t) => t.id === region?.trackId)?.name ?? "Track";

  /**
   * Every write from this panel, tagged so a slider drag is one undo step.
   *
   * Without it each tick of Gain, Speed, Transpose or a fade was its own
   * history entry -- a single pass over a slider buried whatever the user
   * actually wanted to undo under a hundred of them. See editGesture.ts.
   */
  const gesture = useRef(createEditGesture()).current;

  const patch = (
    fields: Omit<Parameters<typeof builder.regionUpdate>[0], "songIndex" | "regionId">,
  ) => {
    if (!region) return;
    void builder.regionUpdate({
      songIndex,
      regionId: region.id,
      gestureId: gesture.id(),
      ...fields,
    });
  };

  /**
   * Speed, with the region resized to match.
   *
   * Speed does not change WHAT the region plays, it changes how long that
   * takes -- so the block on the timeline has to get shorter or longer with
   * it, the way it does in any other DAW. The engine already reads it this
   * way (AudioEngine's shaped path takes the region's source window as
   * regLen * speed), so leaving the duration alone meant the same source
   * material at 2x played through in half the region and left the rest
   * silent, with nothing on screen to explain why.
   *
   * The source span is what stays fixed: duration * speed before the change
   * equals duration * speed after it. Trim, loop and reverse are untouched --
   * a looped region simply loops in its new length.
   */
  const applySpeed = (nextSpeed: number) => {
    if (!region) return;
    const prevSpeed = region.playback?.speed ?? 1;
    const safeNext = nextSpeed > 0 ? nextSpeed : 1;
    // Duration 0 means "runs to the end of the song" -- there is no authored
    // length to scale, so only the speed changes.
    const nextDuration =
      region.durationSeconds > 0
        ? Math.max(0.05, (region.durationSeconds * prevSpeed) / safeNext)
        : undefined;
    patch(
      nextDuration === undefined
        ? { speed: safeNext }
        : { speed: safeNext, durationSeconds: nextDuration },
    );
  };

  // The neighbour this region overlaps, if any -- that overlap IS the
  // crossfade, so the shape control only appears when one exists.
  const join = useMemo(() => {
    if (!region) return null;
    const song = songs[songIndex];
    if (!song?.regions) return null;
    const songEnd = song.endSeconds && song.endSeconds > 0 ? song.endSeconds : 0;
    const resolve = (r: RegionRow) =>
      r.durationSeconds > 0
        ? r.durationSeconds
        : Math.max(0.05, songEnd - r.startSeconds);
    const asXf = (r: RegionRow): CrossfadeRegion => ({
      id: r.id,
      trackId: r.trackId,
      startSeconds: r.startSeconds,
      durationSeconds: resolve(r),
      fadeInSeconds: r.fade?.inSeconds ?? 0,
      fadeOutSeconds: r.fade?.outSeconds ?? 0,
      fadeInCurve: r.fade?.inCurve ?? 0,
      fadeOutCurve: r.fade?.outCurve ?? 0,
    });
    const self = asXf(region);
    for (const other of song.regions) {
      if (other.id === region.id) continue;
      if (other.trackId !== region.trackId) continue;
      const pair = crossfadeBetween(self, asXf(other));
      if (pair) return { pair, otherId: other.id };
    }
    return null;
  }, [region, songs, songIndex]);

  const joinShape = join
    ? shapeOfCurve(
        join.pair.earlier.regionId === region?.id
          ? join.pair.earlier.fadeOutCurve
          : join.pair.later.fadeInCurve,
      )
    : null;

  const applyJoinShape = (shape: CrossfadeShape) => {
    if (!join || !region) return;
    const song = songs[songIndex];
    const other = song?.regions?.find((r) => r.id === join.otherId);
    if (!other) return;
    // One gesture id: the two halves of a crossfade are one edit.
    const gestureId = crypto.randomUUID();
    const curve = CROSSFADE_SHAPES[shape];
    const earlierId = join.pair.earlier.regionId;
    void builder.regionUpdate({
      songIndex,
      regionId: earlierId,
      fadeOutSeconds: join.pair.earlier.fadeOutSeconds,
      fadeOutCurve: curve,
      gestureId,
    });
    void builder.regionUpdate({
      songIndex,
      regionId: join.pair.later.regionId,
      fadeInSeconds: join.pair.later.fadeInSeconds,
      fadeInCurve: curve,
      gestureId,
    });
  };

  const fade = region?.fade;
  const loop = region?.loop;
  const playback = region?.playback;

  return (
    <SidePanelShell
      title="Region"
      icon={<AudioWaveform size={13} />}
      storageKey="resostage.timeline.regionPanelOpen"
      hasSelection={!!region}
      selectionLabel={region ? trackName : undefined}
    >
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {!region && (
          <EmptyState className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center text-xs">
            <AudioWaveform size={28} strokeWidth={1} />
            <span>Select a region to edit its gain, fades and loop</span>
          </EmptyState>
        )}

        {region && (
          <>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-xs font-semibold">
                {trackName}
              </span>
              <span className="truncate text-[10px] text-muted">
                {songs[songIndex]?.name ?? `Song ${songIndex + 1}`}
                {selectedRegionKeys.length > 1
                  ? ` · ${selectedRegionKeys.length} selected`
                  : ""}
              </span>
            </div>

            <Separator />

            <LabeledSlider
              label="Clip gain"
              defaultValue={0}
              value={region.gainDb ?? 0}
              min={GAIN_MIN_DB}
              max={GAIN_MAX_DB}
              step={0.1}
              format={fmtDb}
              onChange={(gainDb) => patch({ gainDb })}
            />

            <Separator />

            <LabeledSlider
              label="Fade in"
              defaultValue={0}
              value={fade?.inSeconds ?? 0}
              min={0}
              max={FADE_MAX_SECONDS}
              step={0.01}
              format={fmtSeconds}
              onChange={(fadeInSeconds) => patch({ fadeInSeconds })}
            />
            <LabeledSlider
              label="Fade in curve"
              defaultValue={0}
              value={fade?.inCurve ?? 0}
              min={-1}
              max={1}
              step={0.05}
              format={(v) => (v === 0 ? "linear" : v.toFixed(2))}
              onChange={(fadeInCurve) => patch({ fadeInCurve })}
            />
            <LabeledSlider
              label="Fade out"
              defaultValue={0}
              value={fade?.outSeconds ?? 0}
              min={0}
              max={FADE_MAX_SECONDS}
              step={0.01}
              format={fmtSeconds}
              onChange={(fadeOutSeconds) => patch({ fadeOutSeconds })}
            />
            <LabeledSlider
              label="Fade out curve"
              defaultValue={0}
              value={fade?.outCurve ?? 0}
              min={-1}
              max={1}
              step={0.05}
              format={(v) => (v === 0 ? "linear" : v.toFixed(2))}
              onChange={(fadeOutCurve) => patch({ fadeOutCurve })}
            />

            {join && (
              <>
                <Separator />
                <div className="flex items-center gap-1.5">
                  <Blend size={12} className="shrink-0 text-muted" />
                  <span className="text-[11px] font-semibold">
                    Crossfade · {fmtSeconds(join.pair.later.fadeInSeconds)}
                  </span>
                </div>
                <Field
                  label="Shape"
                  description="Equal power holds the level through the middle of the join; linear dips about 3dB unless the two sides are phase-coherent."
                >
                  <Select
                    size="sm"
                    aria-label="Crossfade shape"
                    value={joinShape ?? "equalPower"}
                    options={SHAPE_OPTIONS.map((o) => ({
                      id: o.id,
                      label: o.label,
                    }))}
                    onChange={(id) => applyJoinShape(id as CrossfadeShape)}
                  />
                </Field>
              </>
            )}

            <Separator />

            {/* A button, not a switch: reversing a region is an edit you
                apply to it, the same shape of action as Split or Mute, and it
                is one of the few here worth being able to hit without aiming
                at a 20px control. Speed is a separate parameter below --
                reversing does not change it, and neither of them turns off
                looping. */}
            <ToggleButton
              size="sm"
              tone="accent-soft"
              className="w-full justify-center gap-1.5"
              aria-label="Play region backwards"
              isSelected={playback?.reverse ?? false}
              onChange={(reverse) => patch({ reverse })}
            >
              <Rewind size={12} className="shrink-0" />
              Reverse
            </ToggleButton>
            <LabeledSlider
              label="Speed"
              defaultValue={1}
              value={playback?.speed ?? 1}
              min={0.25}
              max={4}
              // Twentieths, not hundredths: speed is a value you pick, not one
              // you sweep, and a coarse enough step turns the slider into a
              // row of positions the trackpad can tick through (see the
              // Slider wrapper's DETENT_LIMIT).
              step={0.05}
              format={(v) => `${v.toFixed(2)}×`}
              onChange={applySpeed}
            />
            <LabeledSlider
              label="Transpose"
              defaultValue={0}
              value={playback?.semitones ?? 0}
              min={-12}
              max={12}
              step={1}
              format={(v) =>
                v === 0 ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(0)} st`
              }
              onChange={(semitones) => patch({ semitones })}
            />
            <p className="text-[10px] leading-snug text-muted">
              Speed carries pitch with it, like tape; Transpose moves the pitch
              on its own and leaves the timing alone. Reverse and any speed
              other than 1× need the clip held in memory, so a long one takes a
              moment to take effect after loading.
            </p>

            <Separator />

            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold">
                <Repeat size={12} className="shrink-0 text-muted" />
                Loop
              </span>
              <Switch
                aria-label="Loop region"
                isSelected={loop?.enabled ?? false}
                onChange={(enabled) => patch({ loop: enabled })}
              />
            </div>
            {loop?.enabled && (
              <LabeledSlider
                label="Loop length"
              defaultValue={0}
                value={loop.lengthSeconds ?? 0}
                min={0}
                max={Math.max(1, region.durationSeconds || 8)}
                step={0.01}
                // 0 is not "no loop" here -- it means "use whatever source
                // material is left", which is the default and the common case.
                format={(v) => (v <= 0 ? "source" : fmtSeconds(v))}
                onChange={(loopLengthSeconds) => patch({ loopLengthSeconds })}
              />
            )}

            <Separator />

            <Button
              size="sm"
              variant="default-soft"
              onPress={onClearSelection}
              className="w-full"
            >
              Clear selection
            </Button>
          </>
        )}
      </div>
    </SidePanelShell>
  );
}
