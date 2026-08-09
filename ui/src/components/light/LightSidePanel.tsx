/**
 * LightSidePanel -- right-hand sidebar in the Timeline's Light mode.
 *
 * Contains:
 *   1. Compact 3D preview, driven by the backend-authoritative lightOutput
 *      (see WebUiState.lightOutput's doc comment) -- not a re-simulation.
 *   2. Selected track settings.
 *   3. Selected cue settings (color, audio-reactive effect, fades).
 *
 * Every control here is a HeroUI component; the pieces both light surfaces
 * share (colour picker, gradient editor, effect grid, sliders, fields) live
 * in LightControls.tsx.
 */
import {
  Checkbox,
  CheckboxGroup,
  CloseButton,
  Description,
  EmptyState,
  Input,
  Label,
  ListBox,
  Select,
  Separator,
  TextField,
} from "@heroui/react";
import { Lightbulb, Link2, Link2Off, Palette, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Alert, Button, ToggleButton, ToggleButtonGroup } from "../ui";

import { lighting } from "../../lib/api";
import type { LightCueValue } from "../../lib/lightCueInterpolation";
import type {
  BusRow,
  LightCueRow,
  LightFixtureRow,
  LightTrackRow,
  TrackRow,
  WebUiState,
} from "../../lib/types";
import { SidePanelShell } from "../timeline/SidePanelShell";
import { ResoLightStage3D } from "./LazyResoLightStage3D";
import {
  EffectTypeGrid,
  Field,
  GradientPresetGroup,
  LabeledSlider,
  LightColorPicker,
  NumberFieldControl,
  TextFieldControl,
} from "./LightControls";
import {
  CUE_EFFECT_TYPES,
  EFFECT_META,
  SUBDIVISIONS,
  effectSupportsGradient,
  effectUsesOwnColor,
  type GradientPreset,
  type SourceType,
  type TempoSubdiv,
} from "./lightEffectMeta";
import {
  CAPTION_CLS,
  CHIP_TOGGLE_CLS,
  TIGHT_TOGGLE_CLS,
  TOGGLE_GROUP_CLS,
} from "./lightStyles";

export type { GradientPreset, SourceType, TempoSubdiv };

// Effects with a Rate control -- these are the "rhythmic" ones that make
// sense synced to song tempo. Shared between the effect grid (which decides
// whether to show the Rate/tempo-sync section at all) and the default-on
// tempo-sync behavior when a cue first picks one of these (see
// CueSettingsPanel.handleEffectType).
function effectHasRate(t: EffectType): boolean {
  return (
    t === "strobe" ||
    t === "pulse" ||
    t === "ripple" ||
    t === "converge" ||
    t === "gradientflow" ||
    t === "chase" ||
    t === "helix" ||
    t === "plasma" ||
    t === "twinkle" ||
    t === "sonicboom" ||
    t === "fire" ||
    t === "bouncing" ||
    t === "drip" ||
    t === "fireworks" ||
    t === "colorwaves" ||
    t === "strobeswipe" ||
    t === "scanner" ||
    t === "lightning" ||
    t === "barberpole"
  );
}

/** Beats per cycle for each tempo subdivision, for the Hz readout. */
const SUBDIV_BEATS: Record<TempoSubdiv, number> = {
  "2": 8,
  "1": 4,
  "1/2": 2,
  "1/3": 4 / 3,
  "1/4": 1,
  "1/6": 2 / 3,
  "1/8": 0.5,
  "1/16": 0.25,
  "1/32": 0.125,
  "1/64": 0.0625,
};

export type EffectType =
  | "none"
  | "meter"
  | "strobe"
  | "pulse"
  | "ripple"
  | "converge"
  | "gradientflow"
  | "chase"
  | "helix"
  | "plasma"
  | "twinkle"
  | "sonicboom"
  | "fire"
  | "bouncing"
  | "drip"
  | "fireworks"
  | "colorwaves"
  | "strobeswipe"
  | "vupeak"
  | "geq"
  | "blurz"
  | "scanner"
  | "lightning"
  | "barberpole";

type BlendModeUi =
  | "normal"
  | "additive"
  | "multiply"
  | "difference"
  | "lighten"
  | "subtractive";
const BLEND_META: Record<BlendModeUi, string> = {
  normal: "Normal (replace)",
  additive: "Additive",
  multiply: "Multiply",
  difference: "Difference",
  lighten: "Lighten",
  subtractive: "Subtractive",
};

// ─── Audio effect selector (props-driven — state lives in LightSidePanel) ──

function EffectPanel({
  effectType,
  effectSourceType,
  effectSourceId,
  effectIntensity,
  effectRate,
  tempoSync,
  tempoSubdiv,
  gradientPreset,
  gradientColors,
  blendMode,
  showGradient,
  hasAddressableFixture,
  onType,
  onSourceType,
  onSourceId,
  onIntensity,
  onRate,
  onTempoSync,
  onTempoSubdiv,
  onGradientPreset,
  onGradientColors,
  onBlendMode,
  busses,
  tracks,
  bpm,
}: {
  effectType: EffectType;
  effectSourceType: SourceType;
  effectSourceId: string;
  effectIntensity: number;
  effectRate: number;
  tempoSync: boolean;
  tempoSubdiv: TempoSubdiv;
  gradientPreset: GradientPreset;
  gradientColors: string;
  blendMode: BlendModeUi;
  /** Only meaningful (and only shown) when the effect is Meter and at least
   * one assigned fixture is addressable -- a non-addressable bar has no
   * per-LED concept for a gradient to apply to. */
  showGradient: boolean;
  /** Whether the track/cue's assigned fixtures include an addressable one. */
  hasAddressableFixture: boolean;
  onType: (t: EffectType) => void;
  onSourceType: (t: SourceType) => void;
  onSourceId: (id: string) => void;
  onIntensity: (v: number) => void;
  onRate: (v: number) => void;
  onTempoSync: (v: boolean) => void;
  onTempoSubdiv: (v: TempoSubdiv) => void;
  onGradientPreset: (g: GradientPreset) => void;
  onGradientColors: (colors: string) => void;
  onBlendMode: (b: BlendModeUi) => void;
  busses: BusRow[];
  tracks: TrackRow[];
  bpm: number;
}) {
  const hasRate = effectHasRate(effectType);
  const sourceItems = effectSourceType === "track" ? tracks : busses;
  return (
    <div className="flex flex-col gap-3">
      <EffectTypeGrid
        isDense
        label="Audio Effect"
        types={CUE_EFFECT_TYPES}
        value={effectType}
        hasAddressableFixture={hasAddressableFixture}
        onChange={onType}
      />

      {effectType !== "none" && (
        <>
          <Field label="Audio Source">
            <div className="flex gap-1.5">
              <Select
                aria-label="Audio source kind"
                className="w-24 shrink-0"
                value={effectSourceType}
                onChange={(v) => {
                  onSourceType(v as SourceType);
                  // Switching pools invalidates whatever id was picked from
                  // the other one -- reset to "master mix" (bus) / nothing
                  // selected (track) rather than silently keeping a stale id.
                  onSourceId("");
                }}
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="bus" textValue="Bus">
                      Bus
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="track" textValue="Track">
                      Track
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
              <Select
                aria-label="Audio source"
                className="flex-1 min-w-0"
                value={effectSourceId}
                onChange={(v) => onSourceId(String(v ?? ""))}
              >
                <Select.Trigger className="min-w-0">
                  {/* Track names plus their live dB readout are longer than a
                      288px sidebar column; wrapping them doubles the row's
                      height on every level change. */}
                  <Select.Value className="truncate" />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {effectSourceType === "bus" ? (
                      <ListBox.Item id="" textValue="Master mix">
                        — Master mix
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ) : null}
                    {sourceItems.map((item) => {
                      const db = item.peakDb ?? -100;
                      const dbStr =
                        db > -100 ? `${db.toFixed(1)} dB` : "silence";
                      return (
                        <ListBox.Item
                          key={item.id}
                          id={item.id}
                          textValue={`${item.name} · ${dbStr}`}
                        >
                          {item.name} · {dbStr}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      );
                    })}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
          </Field>

          {showGradient && (
            <GradientPresetGroup
              isDense
              value={gradientPreset}
              colors={gradientColors}
              onChange={onGradientPreset}
              onColorsChange={onGradientColors}
            />
          )}

          <LabeledSlider
            label="Depth"
            defaultValue={0.8}
            value={effectIntensity}
            onChange={onIntensity}
            step={0.05}
          />

          <Field
            label="Layer Blend"
            description="Only matters if another track's cue is active on the same fixture at the same time (base + accent layers)."
          >
            <Select
              aria-label="Layer blend mode"
              value={blendMode}
              onChange={(v) => onBlendMode(v as BlendModeUi)}
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {(Object.keys(BLEND_META) as BlendModeUi[]).map((b) => (
                    <ListBox.Item key={b} id={b} textValue={BLEND_META[b]}>
                      {BLEND_META[b]}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </Field>

          {hasRate && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label className={CAPTION_CLS}>Rate</Label>
                <ToggleButton
                  size="sm"
                  variant="ghost"
                  className={CHIP_TOGGLE_CLS}
                  isSelected={tempoSync}
                  aria-label={
                    tempoSync
                      ? `Synced to tempo (${bpm.toFixed(0)} BPM)`
                      : "Free rate — click to sync to tempo"
                  }
                  onChange={onTempoSync}
                >
                  {tempoSync ? <Link2 /> : <Link2Off />}
                  <span>{tempoSync ? `♩${bpm.toFixed(0)}` : "Free"}</span>
                </ToggleButton>
              </div>

              {tempoSync ? (
                <ToggleButtonGroup
                  isDetached
                  aria-label="Tempo subdivision"
                  className={`grid grid-cols-5 gap-1 ${TOGGLE_GROUP_CLS}`}
                  disallowEmptySelection
                  selectionMode="single"
                  selectedKeys={[tempoSubdiv]}
                  size="sm"
                  onSelectionChange={(keys) => {
                    const next = [...keys][0] as TempoSubdiv | undefined;
                    if (next) onTempoSubdiv(next);
                  }}
                >
                  {SUBDIVISIONS.map((sub) => (
                    <ToggleButton
                      key={sub}
                      id={sub}
                      className={TIGHT_TOGGLE_CLS}
                    >
                      {sub}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              ) : (
                <LabeledSlider
                  label="Free rate"
                  defaultValue={2}
                  value={effectRate}
                  onChange={onRate}
                  min={0.1}
                  max={20}
                  step={0.1}
                  format={(v) => `${v.toFixed(1)} Hz`}
                />
              )}
              {tempoSync && (
                <Description className="text-right text-[10px]">
                  = {(bpm / 60 / (SUBDIV_BEATS[tempoSubdiv] ?? 1)).toFixed(2)}{" "}
                  Hz
                </Description>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Track Settings panel ─────────────────────────────────────────────────

function TrackSettingsPanel({
  track,
  index,
  fixtures,
  onRequestClose,
}: {
  track: LightTrackRow;
  index: number;
  fixtures: LightFixtureRow[];
  onRequestClose?: () => void;
}) {
  // Local draft so live WS re-renders (and remote name echoes) never clobber
  // an in-progress edit or kill text selection mid-drag / mid-Cmd+A. Commit
  // on blur only -- same pattern as MixerScreen track rename.
  const [nameDraft, setNameDraft] = useState(track.name);
  const [nameFocused, setNameFocused] = useState(false);
  if (!nameFocused && nameDraft !== track.name) {
    setNameDraft(track.name);
  }

  const commitName = () => {
    setNameFocused(false);
    const next = nameDraft.trim();
    if (next.length === 0 || next === track.name) {
      setNameDraft(track.name);
      return;
    }
    void lighting.trackUpdate({ index, name: next });
  };

  return (
    <div className="flex flex-col gap-3 select-text">
      <div className="flex items-center justify-between">
        <Label className={CAPTION_CLS}>Track Settings</Label>
        {onRequestClose && (
          <CloseButton aria-label="Close" onPress={onRequestClose} />
        )}
      </div>

      <TextField
        value={nameDraft}
        onChange={setNameDraft}
        className="gap-1"
        aria-label="Light track name"
      >
        <Label className={CAPTION_CLS}>Name</Label>
        <Input
          placeholder="Light track name"
          className="select-text"
          onFocus={(e) => {
            setNameFocused(true);
            // Select the whole name on focus so a rename is one keystroke
            // away.
            e.currentTarget.select();
          }}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setNameDraft(track.name);
              e.currentTarget.blur();
            }
          }}
        />
      </TextField>

      {fixtures.length > 0 && track.fixtureIds.length === 0 && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description className="text-[10px]">
              No fixtures checked below — cues on this track won&apos;t drive
              anything yet.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {/* Fixtures are owned by the track, never by individual cues. */}
      {fixtures.length === 0 ? (
        <Field label="Assigned Fixtures">
          <Description className="text-[10px]">
            No fixtures — add bars in Settings → Light first.
          </Description>
        </Field>
      ) : (
        <CheckboxGroup
          className="gap-1"
          value={track.fixtureIds}
          onChange={(ids) =>
            void lighting.trackUpdate({ index, fixtureIds: ids })
          }
        >
          <Label className={CAPTION_CLS}>Assigned Fixtures</Label>
          {fixtures.map((f) => (
            <Checkbox key={f.id} value={f.id}>
              <Checkbox.Content className="w-full gap-2">
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Label className="truncate text-xs font-normal">{f.name}</Label>
              </Checkbox.Content>
            </Checkbox>
          ))}
        </CheckboxGroup>
      )}

      <Button
        size="sm"
        variant="danger-soft"
        className="self-start"
        onPress={() => {
          void lighting.trackRemove(index);
          onRequestClose?.();
        }}
      >
        <Trash2 size={11} />
        Remove Track
      </Button>
    </div>
  );
}

// ─── Cue Settings panel ───────────────────────────────────────────────────

function CueSettingsPanel({
  cue,
  songIndex,
  busses,
  tracks,
  bpm,
  hasAddressableFixture,
  effectType,
  effectSourceType,
  effectSourceId,
  effectIntensity,
  effectRate,
  tempoSync,
  tempoSubdiv,
  gradientPreset,
  gradientColors,
  blendMode,
  onEffectType,
  onEffectSourceType,
  onEffectSourceId,
  onEffectIntensity,
  onEffectRate,
  onTempoSync,
  onTempoSubdiv,
  onGradientPreset,
  onGradientColors,
  onBlendMode,
}: {
  cue: LightCueRow;
  songIndex: number;
  busses: BusRow[];
  tracks: TrackRow[];
  bpm: number;
  hasAddressableFixture: boolean;
  effectType: EffectType;
  effectSourceType: SourceType;
  effectSourceId: string;
  effectIntensity: number;
  effectRate: number;
  tempoSync: boolean;
  tempoSubdiv: TempoSubdiv;
  gradientPreset: GradientPreset;
  gradientColors: string;
  blendMode: BlendModeUi;
  onEffectType: (t: EffectType) => void;
  onEffectSourceType: (t: SourceType) => void;
  onEffectSourceId: (id: string) => void;
  onEffectIntensity: (v: number) => void;
  onEffectRate: (v: number) => void;
  onTempoSync: (v: boolean) => void;
  onTempoSubdiv: (v: TempoSubdiv) => void;
  onGradientPreset: (g: GradientPreset) => void;
  onGradientColors: (colors: string) => void;
  onBlendMode: (b: BlendModeUi) => void;
}) {
  const update = (
    patch: Omit<
      Parameters<typeof lighting.cueUpdate>[0],
      "songIndex" | "cueId"
    >,
  ) => void lighting.cueUpdate({ songIndex, cueId: cue.id, ...patch });

  // Persist effect changes to the backend immediately.
  const handleEffectType = (t: EffectType) => {
    onEffectType(t);
    // Rhythmic effects (anything with a Rate control) default to tempo
    // sync -- only when *newly* turning an effect on (previous type was
    // "none"), so flipping between two rhythmic effects never silently
    // re-syncs a rate the user deliberately freed from tempo.
    const nextTempoSync =
      effectType === "none" && effectHasRate(t) ? true : tempoSync;
    if (nextTempoSync !== tempoSync) onTempoSync(nextTempoSync);
    update({
      effectType: t,
      effectSourceType,
      effectSourceId,
      effectIntensity,
      tempoSync: nextTempoSync,
      tempoSubdiv,
      effectRateHz: effectRate,
      gradientPreset,
      gradientColors,
      blendMode,
    });
  };
  const handleEffectSourceType = (t: SourceType) => {
    onEffectSourceType(t);
    update({ effectSourceType: t });
  };
  const handleEffectSourceId = (id: string) => {
    onEffectSourceId(id);
    update({ effectSourceId: id });
  };
  const handleEffectIntensity = (v: number) => {
    onEffectIntensity(v);
    update({ effectIntensity: v });
  };
  const handleEffectRate = (v: number) => {
    onEffectRate(v);
    update({ effectRateHz: v });
  };
  const handleTempoSync = (v: boolean) => {
    onTempoSync(v);
    update({ tempoSync: v, tempoSubdiv });
  };
  const handleTempoSubdiv = (v: TempoSubdiv) => {
    onTempoSubdiv(v);
    update({ tempoSync: true, tempoSubdiv: v });
  };
  const handleGradientPreset = (g: GradientPreset) => {
    onGradientPreset(g);
    update({ gradientPreset: g });
  };
  const handleGradientColors = (colors: string) => {
    onGradientColors(colors);
    update({ gradientColors: colors });
  };
  const handleBlendMode = (b: BlendModeUi) => {
    onBlendMode(b);
    update({ blendMode: b });
  };

  const usesOwnColor = effectUsesOwnColor(effectType, gradientPreset);
  const supportsGradient = effectSupportsGradient(effectType);

  // Fades may fill the whole cue but must not overlap:
  //   fadeIn  ≤ duration − fadeOut  (up to the fade-out start / cue end)
  //   fadeOut ≤ duration − fadeIn   (remaining after fade-in ends)
  // Matches resolveLightCueValue in lightCueInterpolation.ts.
  const dur = Math.max(0, cue.durationSeconds);
  const fadeIn = Math.max(0, cue.fade.inSeconds);
  const fadeOut = Math.max(0, cue.fade.outSeconds);
  const maxFadeIn = Math.max(0, dur - fadeOut);
  const maxFadeOut = Math.max(0, dur - fadeIn);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label className={CAPTION_CLS}>Color</Label>
        {usesOwnColor ? (
          <Alert status="default">
            <Alert.Content>
              <Alert.Description className="text-xs italic">
                Color is driven by{" "}
                {EFFECT_META[effectType]?.label || effectType} palette
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : (
          <LightColorPicker
            r={cue.color.r}
            g={cue.color.g}
            b={cue.color.b}
            onChange={(r, g, b) => update({ colorR: r, colorG: g, colorB: b })}
          />
        )}
      </div>

      <TextFieldControl
        label="Label"
        placeholder="Cue label (optional)"
        value={cue.label ?? ""}
        onCommit={(v) => update({ label: v })}
      />

      <LabeledSlider
        label="Intensity"
        defaultValue={1}
        value={cue.intensity}
        onChange={(v) => update({ intensity: v })}
      />

      {/* Stacked, not side by side: two steppers plus their captions do not
          fit across a 288px sidebar without clipping. */}
      <div className="flex flex-col gap-3">
        <NumberFieldControl
          label="Fade In (s)"
          value={Math.min(fadeIn, maxFadeIn)}
          min={0}
          max={maxFadeIn}
          step={0.1}
          onCommit={(v) =>
            update({ fadeInSeconds: Math.min(Math.max(0, v), maxFadeIn) })
          }
        />
        <NumberFieldControl
          label="Fade Out (s)"
          value={Math.min(fadeOut, maxFadeOut)}
          min={0}
          max={maxFadeOut}
          step={0.1}
          onCommit={(v) =>
            update({ fadeOutSeconds: Math.min(Math.max(0, v), maxFadeOut) })
          }
        />
      </div>

      <Separator />

      <EffectPanel
        effectType={effectType}
        effectSourceType={effectSourceType}
        effectSourceId={effectSourceId}
        effectIntensity={effectIntensity}
        effectRate={effectRate}
        tempoSync={tempoSync}
        tempoSubdiv={tempoSubdiv}
        gradientPreset={gradientPreset}
        gradientColors={gradientColors}
        blendMode={blendMode}
        showGradient={supportsGradient && hasAddressableFixture}
        hasAddressableFixture={hasAddressableFixture}
        onType={handleEffectType}
        onSourceType={handleEffectSourceType}
        onSourceId={handleEffectSourceId}
        onIntensity={handleEffectIntensity}
        onRate={handleEffectRate}
        onTempoSync={handleTempoSync}
        onTempoSubdiv={handleTempoSubdiv}
        onGradientPreset={handleGradientPreset}
        onGradientColors={handleGradientColors}
        onBlendMode={handleBlendMode}
        busses={busses}
        tracks={tracks}
        bpm={bpm}
      />
    </div>
  );
}

// ─── Main LightSidePanel ──────────────────────────────────────────────────

export type LightSidePanelSelection =
  | {
      type: "track";
      trackIndex: number;
      track: LightTrackRow;
    }
  | {
      type: "cue";
      songIndex: number;
      cue: LightCueRow;
      trackIndex: number;
      track: LightTrackRow;
    };

export function LightSidePanel({
  state,
  selection,
  fixtures,
  previewColors,
  onClearSelection,
}: {
  state: WebUiState;
  selection: LightSidePanelSelection | null;
  fixtures: LightFixtureRow[];
  previewColors: Record<string, LightCueValue>;
  onClearSelection: () => void;
}) {
  // ── Effect editor state, seeded from the selected cue's real (persisted)
  // values -- not hardcoded defaults, since state.lightCues now actually
  // carries them (see RESTORE_POINT.md Feature 6's sync fix). ──
  const [effectType, setEffectType] = useState<EffectType>("none");
  const [effectSourceType, setEffectSourceType] = useState<SourceType>("bus");
  const [effectSourceId, setEffectSourceId] = useState("");
  const [effectIntensity, setEffectIntensity] = useState(0.8);
  const [effectRate, setEffectRate] = useState(2);
  const [tempoSync, setTempoSync] = useState(false);
  const [tempoSubdiv, setTempoSubdiv] = useState<TempoSubdiv>("1/4");
  const [gradientPreset, setGradientPreset] = useState<GradientPreset>("solid");
  const [gradientColors, setGradientColors] = useState("");
  const [blendMode, setBlendMode] = useState<BlendModeUi>("normal");

  // BPM for the currently active song
  const currentSongIdx = selection?.type === "cue" ? selection.songIndex : 0;
  const currentBpm = state.songs[currentSongIdx]?.bpm ?? 120;

  // Re-seed the editor fields whenever the selected cue changes.
  const prevCueId = useRef<string | null>(null);
  const currentCueId = selection?.type === "cue" ? selection.cue.id : null;
  if (prevCueId.current !== currentCueId) {
    prevCueId.current = currentCueId;
    const cue = selection?.type === "cue" ? selection.cue : null;
    setEffectType((cue?.effect.type || "none") as EffectType);
    setEffectSourceType((cue?.effect.sourceType || "bus") as SourceType);
    setEffectSourceId(cue?.effect.sourceId ?? "");
    setEffectIntensity(cue?.effect.intensity ?? 0.8);
    setEffectRate(cue?.effect.rateHz ?? 2);
    setTempoSync(cue?.effect.tempoSync ?? false);
    setTempoSubdiv((cue?.effect.tempoSubdivision || "1/4") as TempoSubdiv);
    setGradientPreset((cue?.gradient.preset || "solid") as GradientPreset);
    setGradientColors(cue?.gradient.colors ?? "");
    setBlendMode(((cue?.blendMode as BlendModeUi) || "normal") as BlendModeUi);
  }

  const hasAddressableFixture =
    selection?.type === "cue" || selection?.type === "track"
      ? fixtures.some(
          (f) => selection.track.fixtureIds.includes(f.id) && f.addressable,
        )
      : false;

  // previewColors kept in props for API stability -- ResoLightStage3D now
  // sources live colors itself (per-fixture, see useLiveFixtureColor), not
  // used for paint here.
  void previewColors;

  return (
    <SidePanelShell
      title="Light"
      icon={<Lightbulb size={13} />}
      storageKey="resostage.timeline.lightPanelOpen"
      hasSelection={!!selection}
      selectionLabel={
        selection?.type === "cue"
          ? selection.cue.label || "Cue"
          : selection?.type === "track"
            ? selection.track.name || "Track"
            : undefined
      }
      header={
        /* 3D Preview — shows modulated colors when an effect is active.
           In the shell's header slot rather than the scroll area: it is the
           one thing here that must not scroll away, and collapsing the panel
           unmounts it, which is the cheapest way to stop a WebGL context the
           user cannot see. */
        <div
          className="shrink-0 border-b border-default bg-background"
          style={{ height: 200 }}
          onWheel={(e) => e.stopPropagation()}
        >
          <ResoLightStage3D mode="preview" fixtures={fixtures} />
        </div>
      }
    >

      {/* One flat column, no cards: at 288px a card's own padding and radius
          eat most of the room the controls need, and stacking two of them
          reads as clutter rather than structure. A separator does the same
          job for free. */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {!selection && (
          <EmptyState className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center text-xs">
            <Lightbulb size={28} strokeWidth={1} />
            <span>Click a track header or cue block to edit it</span>
          </EmptyState>
        )}

        {selection?.type === "cue" && (
          <>
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <Palette size={13} className="shrink-0 text-muted" />
                <span className="truncate text-xs font-semibold">
                  {selection.cue.label || selection.cue.id.slice(0, 8)}
                </span>
              </div>
              <CloseButton
                aria-label="Clear selection"
                onPress={onClearSelection}
              />
            </div>
            <CueSettingsPanel
              cue={selection.cue}
              songIndex={selection.songIndex}
              busses={state.busses}
              tracks={state.tracks}
              bpm={currentBpm}
              hasAddressableFixture={hasAddressableFixture}
              effectType={effectType}
              effectSourceType={effectSourceType}
              effectSourceId={effectSourceId}
              effectIntensity={effectIntensity}
              effectRate={effectRate}
              tempoSync={tempoSync}
              tempoSubdiv={tempoSubdiv}
              gradientPreset={gradientPreset}
              gradientColors={gradientColors}
              blendMode={blendMode}
              onEffectType={setEffectType}
              onEffectSourceType={setEffectSourceType}
              onEffectSourceId={setEffectSourceId}
              onEffectIntensity={setEffectIntensity}
              onEffectRate={setEffectRate}
              onTempoSync={setTempoSync}
              onTempoSubdiv={setTempoSubdiv}
              onGradientPreset={setGradientPreset}
              onGradientColors={setGradientColors}
              onBlendMode={setBlendMode}
            />

            {/* Fixtures / track name live on the track only — still shown while
                editing a cue so assignment stays one click away, labeled as
                Track Settings (not cue settings). */}
            <Separator />
            <TrackSettingsPanel
              track={selection.track}
              index={selection.trackIndex}
              fixtures={fixtures}
            />
          </>
        )}

        {selection?.type === "track" && (
          <TrackSettingsPanel
            track={selection.track}
            index={selection.trackIndex}
            fixtures={fixtures}
            onRequestClose={onClearSelection}
          />
        )}
      </div>
    </SidePanelShell>
  );
}
