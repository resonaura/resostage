/**
 * LightSidePanel — правая боковая панель в Timeline Light mode.
 *
 * Содержит:
 *   1. Компактный 3D preview текущего состояния рига
 *   2. Настройки выделенного трека (кликабельный заголовок → раскрываются поля)
 *   3. Настройки выделенного cue (цвета, эффекты, fades)
 */
import { useState, useRef } from "react";
import { lighting } from "../../lib/api";
import type {
  BusRow,
  LightCueRow,
  LightFixtureRow,
  LightTrackRow,
  MeterRow,
  WebUiState,
} from "../../lib/types";
import type { LightCueValue } from "../../lib/lightCueInterpolation";
import { ResoLightStage3D } from "./ResoLightStage3D";

const labelCls =
  "text-[11px] font-semibold uppercase tracking-wide text-foreground/50";
const inputCls =
  "w-full rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-xs outline-none focus:border-accent";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  );
}

// ─── HSL Color Picker ─────────────────────────────────────────────────────

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "").match(/(.{2})/g);
  if (!m || m.length < 3) return [255, 255, 255];
  return [parseInt(m[0], 16), parseInt(m[1], 16), parseInt(m[2], 16)];
}

const PRESET_COLORS: [number, number, number][] = [
  [255, 159, 10],   // amber
  [255, 214, 10],   // yellow
  [255, 55, 95],    // rose
  [191, 90, 242],   // purple
  [100, 210, 255],  // cyan
  [48, 209, 88],    // green
  [255, 69, 58],    // red
  [0, 199, 190],    // teal
  [255, 255, 255],  // white
  [0, 91, 255],     // blue
  [255, 120, 0],    // orange
  [200, 200, 200],  // cool white
];

function HslColorPicker({
  r, g, b,
  onChange,
}: {
  r: number;
  g: number;
  b: number;
  onChange: (r: number, g: number, b: number) => void;
}) {
  const [hsl, setHsl] = useState<[number, number, number]>(() => rgbToHsl(r, g, b));
  const lastRgb = useRef<[number, number, number]>([r, g, b]);

  // Sync from outside only when not dragging
  if (lastRgb.current[0] !== r || lastRgb.current[1] !== g || lastRgb.current[2] !== b) {
    lastRgb.current = [r, g, b];
    const newHsl = rgbToHsl(r, g, b);
    if (Math.abs(newHsl[0] - hsl[0]) > 2 || Math.abs(newHsl[1] - hsl[1]) > 2 || Math.abs(newHsl[2] - hsl[2]) > 2) {
      setHsl(newHsl);
    }
  }

  const applyHsl = (newHsl: [number, number, number]) => {
    setHsl(newHsl);
    const [nr, ng, nb] = hslToRgb(...newHsl);
    lastRgb.current = [nr, ng, nb];
    onChange(nr, ng, nb);
  };

  const hex = rgbToHex(r, g, b);

  return (
    <div className="flex flex-col gap-3">
      {/* Presets swatches */}
      <div className="flex flex-wrap gap-1.5">
        {PRESET_COLORS.map(([pr, pg, pb], i) => (
          <button
            key={i}
            type="button"
            title={`rgb(${pr},${pg},${pb})`}
            onClick={() => {
              lastRgb.current = [pr, pg, pb];
              onChange(pr, pg, pb);
              setHsl(rgbToHsl(pr, pg, pb));
            }}
            className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 active:scale-95"
            style={{
              background: `rgb(${pr},${pg},${pb})`,
              borderColor: pr === r && pg === g && pb === b ? "#fff" : "transparent",
            }}
          />
        ))}
      </div>

      {/* Hex + native color picker */}
      <div className="flex items-center gap-2">
        <div
          className="h-8 w-8 shrink-0 rounded-lg border border-white/20"
          style={{ background: hex }}
        />
        <input
          type="color"
          value={hex}
          onChange={(e) => {
            const [nr, ng, nb] = hexToRgb(e.target.value);
            lastRgb.current = [nr, ng, nb];
            onChange(nr, ng, nb);
            setHsl(rgbToHsl(nr, ng, nb));
          }}
          className="h-8 w-10 cursor-pointer rounded border border-default/40 bg-transparent p-0.5"
          title="Native color picker"
        />
        <input
          type="text"
          value={hex.toUpperCase()}
          onChange={(e) => {
            if (e.target.value.match(/^#?[0-9a-fA-F]{6}$/)) {
              const clean = e.target.value.startsWith("#") ? e.target.value : "#" + e.target.value;
              const [nr, ng, nb] = hexToRgb(clean);
              lastRgb.current = [nr, ng, nb];
              onChange(nr, ng, nb);
              setHsl(rgbToHsl(nr, ng, nb));
            }
          }}
          className="flex-1 rounded-lg border border-default/60 bg-default/20 px-2 py-1 text-xs font-mono outline-none focus:border-accent uppercase"
          maxLength={7}
        />
      </div>

      {/* HSL sliders */}
      {[
        { label: "H", index: 0, max: 360, unit: "°", color: `hsl(${hsl[0]}, 100%, 50%)` },
        { label: "S", index: 1, max: 100, unit: "%", color: `hsl(${hsl[0]}, ${hsl[1]}%, 50%)` },
        { label: "L", index: 2, max: 100, unit: "%", color: `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)` },
      ].map(({ label, index, max, unit, color }) => (
        <div key={label} className="flex items-center gap-2">
          <span className="w-4 shrink-0 text-xs text-foreground/50 font-mono">{label}</span>
          <div className="relative flex-1 h-3 flex items-center">
            {/* Gradient track */}
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background: index === 0
                  ? `linear-gradient(to right, hsl(0,${hsl[1]}%,${hsl[2]}%), hsl(60,${hsl[1]}%,${hsl[2]}%), hsl(120,${hsl[1]}%,${hsl[2]}%), hsl(180,${hsl[1]}%,${hsl[2]}%), hsl(240,${hsl[1]}%,${hsl[2]}%), hsl(300,${hsl[1]}%,${hsl[2]}%), hsl(360,${hsl[1]}%,${hsl[2]}%))`
                  : index === 1
                  ? `linear-gradient(to right, hsl(${hsl[0]},0%,${hsl[2]}%), hsl(${hsl[0]},100%,${hsl[2]}%))`
                  : `linear-gradient(to right, hsl(${hsl[0]},${hsl[1]}%,0%), hsl(${hsl[0]},${hsl[1]}%,50%), hsl(${hsl[0]},${hsl[1]}%,100%))`,
              }}
            />
            <input
              type="range"
              min={0}
              max={max}
              value={hsl[index]}
              onChange={(e) => {
                const next = [...hsl] as [number, number, number];
                next[index] = Number(e.target.value);
                applyHsl(next);
              }}
              className="relative w-full h-full opacity-0 cursor-pointer z-10"
            />
            {/* Thumb */}
            <div
              className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 -translate-x-1/2 rounded-full border-2 border-white shadow-md"
              style={{
                left: `${(hsl[index] / max) * 100}%`,
                background: color,
              }}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-xs font-mono text-foreground/50">
            {hsl[index]}{unit}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Audio effect selector ────────────────────────────────────────────────

type EffectType = "none" | "meter" | "strobe" | "pulse" | "ripple";

const EFFECT_DESCRIPTIONS: Record<EffectType, string> = {
  none: "Static color, no modulation",
  meter: "Brightness follows audio level (VU meter)",
  strobe: "Rapid on/off flashes at set rate",
  pulse: "Smooth brightness pulse synced to BPM",
  ripple: "Travelling wave across fixtures left→right",
};

function EffectPanel({
  cueId,
  busses,
  meters,
}: {
  cueId: string;
  busses: BusRow[];
  meters: MeterRow[];
}) {
  // Frontend-only: not persisted to backend (engine ignores these fields).
  const [effectType, setEffectType] = useState<EffectType>("none");
  const [effectBusId, setEffectBusId] = useState("");
  const [effectIntensity, setEffectIntensity] = useState(0.8);
  const [effectRate, setEffectRate] = useState(2);

  // Reset when cue changes
  const prevCueId = useRef(cueId);
  if (prevCueId.current !== cueId) {
    prevCueId.current = cueId;
    setEffectType("none");
    setEffectBusId("");
    setEffectIntensity(0.8);
    setEffectRate(2);
  }


  return (
    <div className="flex flex-col gap-3">
      {/* Effect type pills */}
      <Field label="Audio Effect">
        <div className="flex flex-wrap gap-1.5">
          {(["none", "meter", "strobe", "pulse", "ripple"] as EffectType[]).map((et) => (
            <button
              key={et}
              type="button"
              title={EFFECT_DESCRIPTIONS[et]}
              onClick={() => setEffectType(et)}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                effectType === et
                  ? "border-accent bg-accent/20 text-accent"
                  : "border-default/40 bg-default/10 text-foreground/60 hover:bg-default/20"
              }`}
            >
              {et === "none" ? "— None" : et === "meter" ? "📊 Meter" : et === "strobe" ? "⚡ Strobe" : et === "pulse" ? "〜 Pulse" : "〰 Ripple"}
            </button>
          ))}
        </div>
        {effectType !== "none" && (
          <div className="mt-1 text-[10px] text-foreground/40 italic">
            {EFFECT_DESCRIPTIONS[effectType]}
          </div>
        )}
      </Field>

      {effectType !== "none" && (
        <>
          {/* Bus/source selector */}
          <Field label="Audio Source (Bus)">
            <select
              className="w-full rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-xs outline-none focus:border-accent"
              value={effectBusId}
              onChange={(e) => setEffectBusId(e.target.value)}
            >
              <option value="">— Master mix</option>
              {busses.map((bus) => {
                const meter = meters.find((m) => m.id === bus.id);
                const db = meter?.peakDb ?? -100;
                const dbStr = db > -100 ? `${db.toFixed(1)} dB` : "silence";
                return (
                  <option key={bus.id} value={bus.id}>
                    {bus.name} · {dbStr}
                  </option>
                );
              })}
            </select>
          </Field>

          {/* Intensity */}
          <Field label={`Effect Intensity (${Math.round(effectIntensity * 100)}%)`}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={effectIntensity}
              onChange={(e) => setEffectIntensity(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </Field>

          {/* Rate (for strobe/pulse/ripple) */}
          {(effectType === "strobe" || effectType === "pulse" || effectType === "ripple") && (
            <Field label={`Rate: ${effectRate.toFixed(1)} Hz`}>
              <input
                type="range"
                min={0.1}
                max={20}
                step={0.1}
                value={effectRate}
                onChange={(e) => setEffectRate(Number(e.target.value))}
                className="w-full accent-accent"
              />
            </Field>
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
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className={labelCls}>Track: {track.name}</span>
        {onRequestClose && (
          <button
            type="button"
            onClick={onRequestClose}
            className="text-foreground/40 hover:text-foreground text-xs"
          >
            ✕
          </button>
        )}
      </div>

      <Field label="Name">
        <input
          type="text"
          value={track.name}
          placeholder="Light track name"
          className={inputCls}
          onChange={(e) =>
            void lighting.trackUpdate({ index, name: e.target.value })
          }
        />
      </Field>

      <Field label="Assigned Fixtures">
        <div className="flex flex-col gap-1">
          {fixtures.length === 0 ? (
            <div className="text-[10px] text-foreground/40 italic">
              No fixtures — add bars in Settings → Light first.
            </div>
          ) : (
            fixtures.map((f) => (
              <label
                key={f.id}
                className="flex items-center gap-2 py-0.5 text-xs text-foreground/70 cursor-pointer hover:text-foreground"
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={track.fixtureIds.includes(f.id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...track.fixtureIds, f.id]
                      : track.fixtureIds.filter((id) => id !== f.id);
                    void lighting.trackUpdate({ index, fixtureIds: next });
                  }}
                />
                <span className="truncate">{f.name}</span>
              </label>
            ))
          )}
        </div>
      </Field>

      <button
        type="button"
        onClick={() => {
          void lighting.trackRemove(index);
          onRequestClose?.();
        }}
        className="self-start rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/20 transition-colors"
      >
        🗑 Remove Track
      </button>
    </div>
  );
}

// ─── Cue Settings panel ───────────────────────────────────────────────────

function CueSettingsPanel({
  cue,
  songIndex,
  busses,
  meters,
}: {
  cue: LightCueRow;
  songIndex: number;
  busses: BusRow[];
  meters: MeterRow[];
}) {
  const update = (patch: Omit<Parameters<typeof lighting.cueUpdate>[0], "songIndex" | "cueId">) =>
    void lighting.cueUpdate({ songIndex, cueId: cue.id, ...patch });

  return (
    <div className="flex flex-col gap-4">
      {/* Color section */}
      <div>
        <div className={labelCls + " mb-2"}>Color</div>
        <HslColorPicker
          r={cue.colorR}
          g={cue.colorG}
          b={cue.colorB}
          onChange={(r, g, b) => update({ colorR: r, colorG: g, colorB: b })}
        />
      </div>

      {/* Label */}
      <Field label="Label">
        <input
          type="text"
          value={cue.label}
          placeholder="Cue label (optional)"
          className={inputCls}
          onChange={(e) => update({ label: e.target.value })}
        />
      </Field>

      {/* Intensity */}
      <Field label={`Intensity: ${Math.round(cue.intensity * 100)}%`}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={cue.intensity}
          onChange={(e) => update({ intensity: Number(e.target.value) })}
          className="w-full accent-accent"
        />
      </Field>

      {/* Fades */}
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Fade In: ${cue.fadeInSeconds.toFixed(1)}s`}>
          <input
            type="range"
            min={0}
            max={Math.min(cue.durationSeconds / 2, 10)}
            step={0.1}
            value={cue.fadeInSeconds}
            onChange={(e) => update({ fadeInSeconds: Number(e.target.value) })}
            className="w-full accent-accent"
          />
        </Field>
        <Field label={`Fade Out: ${cue.fadeOutSeconds.toFixed(1)}s`}>
          <input
            type="range"
            min={0}
            max={Math.min(cue.durationSeconds / 2, 10)}
            step={0.1}
            value={cue.fadeOutSeconds}
            onChange={(e) => update({ fadeOutSeconds: Number(e.target.value) })}
            className="w-full accent-accent"
          />
        </Field>
      </div>

      {/* Audio Effects */}
      <div className="border-t border-default/20 pt-3">
        <EffectPanel
          cueId={cue.id}
          busses={busses}
          meters={meters}
        />
      </div>
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
  return (
    <div
      className="flex flex-col shrink-0 border-l border-default/30 bg-surface/30 overflow-hidden"
      style={{ width: 288 }}
    >
      {/* 3D Preview */}
      <div
        className="shrink-0 border-b border-default/20 bg-[#0b0f14]"
        style={{ height: 200 }}
        onWheel={(e) => e.stopPropagation()}
      >
        <ResoLightStage3D
          mode="preview"
          fixtures={fixtures}
          previewColors={previewColors}
        />
      </div>

      {/* Settings content */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {!selection && (
          <div className="flex flex-col items-center justify-center flex-1 gap-2 text-foreground/30 text-xs text-center py-8">
            <span className="text-2xl">💡</span>
            <span>Click a track header or cue block to edit it</span>
          </div>
        )}

        {selection?.type === "cue" && (
          <>
            {/* Cue color first */}
            <div className="rounded-xl border border-default/30 bg-default/10 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-foreground/80">
                  🎨 Cue: {selection.cue.label || selection.cue.id.slice(0, 8)}
                </span>
                <button
                  type="button"
                  onClick={onClearSelection}
                  className="text-foreground/40 hover:text-foreground text-xs"
                >
                  ✕
                </button>
              </div>
              <CueSettingsPanel
                cue={selection.cue}
                songIndex={selection.songIndex}
                busses={state.busses}
                meters={state.meters}
              />
            </div>

            {/* Then track settings below */}
            <div className="rounded-xl border border-default/20 bg-default/5 p-3">
              <TrackSettingsPanel
                track={selection.track}
                index={selection.trackIndex}
                fixtures={fixtures}
              />
            </div>
          </>
        )}

        {selection?.type === "track" && (
          <div className="rounded-xl border border-default/30 bg-default/10 p-3">
            <TrackSettingsPanel
              track={selection.track}
              index={selection.trackIndex}
              fixtures={fixtures}
              onRequestClose={onClearSelection}
            />
          </div>
        )}
      </div>
    </div>
  );
}
