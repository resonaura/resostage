import { useMemo, useState } from "react";
import {
  Circle,
  Copy,
  Disc3,
  Grid3x3,
  Lamp,
  MoveHorizontal,
  Move3D,
  MoveVertical,
  Plus,
  Rows3,
  Spotlight,
  Trash2,
  TriangleAlert,
  Wand2,
} from "lucide-react";
import { lighting } from "../../lib/api";
import type {
  LightFixtureRow,
  LightingState,
  WebUiState,
} from "../../lib/types";
import {
  ResoLightStage3D,
  useLiveFixtureColor,
  type PreviewColor,
} from "./ResoLightStage3D";
import {
  HslColorPicker,
  LabeledSlider,
  EFFECT_META,
  GRADIENT_META,
  GradientStopEditor,
  effectUsesOwnColor,
  effectSupportsGradient,
  type EffectType,
  type GradientPreset,
} from "./LightSidePanel";
import {
  CHANNEL_PROFILES,
  DMX_GENERIC_SHAPES,
  RESOLIGHT_COLOR_TYPE_META,
  RESOLIGHT_COLOR_TYPES,
  RESOLIGHT_SHAPES,
  SHAPE_META,
  channelRoleLabels,
  resoLightRealChannelCount,
  type ChannelProfile,
  type FixtureShape,
  type ResoLightColorType,
} from "../../lib/dmxProfiles";

const SHAPE_ICON: Record<
  FixtureShape,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  bar: Rows3,
  strip: Rows3,
  ring: Circle,
  matrix: Grid3x3,
  par: Lamp,
  wash: Disc3,
  spot: Spotlight,
  movingHead: Move3D,
};

const selectCls =
  "w-full rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-sm outline-none focus:border-accent";
const labelCls =
  "text-[11px] font-semibold uppercase tracking-wide text-foreground/50";
const numberCls =
  "w-20 rounded-lg border border-default/60 bg-default/20 px-2 py-1 text-sm outline-none focus:border-accent";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  );
}

// ─── Auto-layout positions ────────────────────────────────────────────────

function autoLayoutPositions(
  fixtures: LightFixtureRow[],
): { id: string; posX: number; posZ: number }[] {
  if (fixtures.length === 0) return [];
  // Matches the backend's default column spacing (regenerateResoLightFixtures
  // in MainComponentLighting.cpp) so manual auto-layout produces the same
  // rig spacing as the initial grid, instead of a denser 1.2m guess.
  const spacing = 2.0;
  const total = fixtures.length;
  const half = (total - 1) / 2;
  return fixtures.map((f, i) => ({
    id: f.id,
    posX: (i - half) * spacing,
    posZ: 0,
  }));
}

// ─── DMX channel conflicts ─────────────────────────────────────────────────
//
// DmxGeneric fixtures use their own explicit universe/start channel/count
// (see ResoLightChannelMap.h's assignResoLightChannels), so two of them can
// silently be pointed at overlapping channels with nothing to catch it until
// the actual hardware misbehaves. Only checks DmxGeneric against DmxGeneric:
// ResoLightBar channels are auto-packed sequentially by the backend from
// each bar's ledCount/addressable (not from its own dmxUniverse/dmxStartChannel
// fields, which the auto-pack never reads), so replicating that packing here
// just to cross-check would drift the moment the packer's algorithm changes.
function findDmxChannelConflicts(fixtures: LightFixtureRow[]): Set<string> {
  const conflicting = new Set<string>();
  const generic = fixtures.filter((f) => f.kind === "dmxGeneric");
  for (let i = 0; i < generic.length; i++) {
    const a = generic[i];
    const aEnd = a.dmxStartChannel + Math.max(1, a.dmxChannelCount);
    for (let j = i + 1; j < generic.length; j++) {
      const b = generic[j];
      if (a.dmxUniverse !== b.dmxUniverse) continue;
      const bEnd = b.dmxStartChannel + Math.max(1, b.dmxChannelCount);
      const overlaps = a.dmxStartChannel < bEnd && b.dmxStartChannel < aEnd;
      if (overlaps) {
        conflicting.add(a.id);
        conflicting.add(b.id);
      }
    }
  }
  return conflicting;
}

// ─── Fixture row ──────────────────────────────────────────────────────────

/**
 * Collapses a preview color (possibly a live per-LED array, straight off
 * the same backend websocket stream the Timeline's Light mode reads -- see
 * ProjectLightingPanel's displayColors) into one flat r/g/b/intensity for
 * this row's single swatch dot, which has no notion of per-LED detail.
 */
function summarizeSwatchColor(
  c?: PreviewColor,
): { r: number; g: number; b: number; intensity: number } | undefined {
  if (!c) return undefined;
  if (!c.ledColors || c.ledColors.length === 0) return c;
  let r = 0,
    g = 0,
    b = 0;
  for (const led of c.ledColors) {
    r += led.r;
    g += led.g;
    b += led.b;
  }
  const n = c.ledColors.length;
  r = Math.round(r / n);
  g = Math.round(g / n);
  b = Math.round(b / n);
  return { r, g, b, intensity: Math.max(r, g, b) / 255 };
}

function FixtureItem({
  fixture,
  fixtureIndex,
  live,
  selected,
  onSelect,
  onRemove,
  hasChannelConflict,
}: {
  fixture: LightFixtureRow;
  fixtureIndex: number;
  live: boolean;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  hasChannelConflict: boolean;
}) {
  const previewColor = summarizeSwatchColor(
    useLiveFixtureColor(fixtureIndex, live),
  );
  const hasColor = previewColor && previewColor.intensity > 0.01;
  // Only worth a badge when it's not the plain default for the kind --
  // every ResoLightBar starts as "bar", so showing the icon for that case
  // would just be visual noise on every single row.
  const ShapeIcon =
    fixture.kind === "dmxGeneric" || fixture.shape !== "bar"
      ? SHAPE_ICON[fixture.shape]
      : null;
  return (
    <div
      className={`flex items-center gap-1 w-full rounded-lg border transition-all ${
        hasChannelConflict
          ? "border-warning/60 bg-warning/10"
          : selected
            ? "border-accent/60 bg-accent/10"
            : "border-default/30 bg-default/10 hover:bg-default/20"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex flex-1 min-w-0 items-center gap-2.5 px-3 py-2 text-left"
      >
        {/* Live color dot */}
        <div
          className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/10 transition-colors"
          style={{
            background: hasColor
              ? `rgb(${previewColor.r},${previewColor.g},${previewColor.b})`
              : "#334155",
            boxShadow: hasColor
              ? `0 0 6px rgb(${previewColor.r},${previewColor.g},${previewColor.b})`
              : "none",
          }}
        />
        {ShapeIcon && (
          <ShapeIcon size={11} className="shrink-0 text-foreground/40" />
        )}
        <span className="flex-1 truncate text-xs font-medium text-foreground/80">
          {fixture.name}
        </span>
        {hasChannelConflict && (
          <TriangleAlert
            size={11}
            className="shrink-0 text-warning"
            aria-label="DMX channel conflict"
          />
        )}
        <span
          className={`shrink-0 text-[9px] font-mono ${hasChannelConflict ? "text-warning" : "text-foreground/40"}`}
          title={
            hasChannelConflict
              ? "Overlaps another fixture's DMX channels"
              : undefined
          }
        >
          {fixture.kind === "dmxGeneric"
            ? `U${fixture.dmxUniverse}:${fixture.dmxStartChannel}`
            : `${fixture.ledCount}L · ${fixture.mountedHorizontally ? "H" : "V"}${fixture.addressable ? " · addr" : ""}`}
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${fixture.name}`}
        title="Remove fixture"
        className="shrink-0 rounded-md p-1.5 mr-1 text-foreground/30 hover:bg-danger/15 hover:text-danger transition-colors"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

// ─── ProjectLightingPanel ─────────────────────────────────────────────────
// No Card wrapper -- SettingsScreen.tsx renders this inside its own Card.
export function ProjectLightingPanel({
  li,
  state: _state,
}: {
  li: LightingState;
  state: WebUiState;
}) {
  void _state;
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(
    li.fixtures[0]?.id ?? null,
  );
  const selected = li.fixtures.find((f) => f.id === selectedFixtureId) ?? null;

  const dmxConflicts = useMemo(
    () => findDmxChannelConflicts(li.fixtures),
    [li.fixtures],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Enable toggle */}
      <div className="flex items-center justify-between rounded-xl border border-default/30 bg-default/10 px-4 py-3">
        <div>
          <div className="text-sm font-semibold">Light System</div>
          <div className="text-xs text-foreground/50">
            Drive a light rig alongside the show, synced to the timeline.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void lighting.setConfig({ enabled: !li.enabled })}
          className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors ${
            li.enabled
              ? "border-accent bg-accent/20 text-accent"
              : "border-default/60 bg-default/20 text-foreground/60 hover:bg-default/30"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full transition-colors ${
              li.enabled ? "bg-accent" : "bg-default/40"
            }`}
          />
          {li.enabled ? "Enabled" : "Disabled"}
        </button>
      </div>

      {li.enabled && (
        <>
          {/* Fixture type */}
          <div className="rounded-xl border border-default/30 bg-default/5 px-4 py-3">
            <Field label="Fixture type">
              <select
                className={selectCls}
                value={li.kind}
                onChange={(e) =>
                  void lighting.setConfig({
                    kind: e.target.value as LightingState["kind"],
                  })
                }
              >
                <option value="none">Not set</option>
                <option value="resoLight">ResoLight (vertical LED bars)</option>
                <option value="dmxGeneric">Generic DMX / Art-Net / HTTP</option>
              </select>
            </Field>
          </div>

          {/* Idle behavior -- what fixtures show while the transport is stopped */}
          <div className="rounded-xl border border-default/30 bg-default/5 px-4 py-3 flex flex-col gap-3">
            <Field label="When playback is stopped">
              <div className="grid grid-cols-2 gap-1.5">
                {(
                  [
                    {
                      value: "holdLast",
                      label: "Hold Last",
                      desc: "Keep showing whatever the frozen playhead position resolves to",
                    },
                    {
                      value: "blackout",
                      label: "Blackout",
                      desc: "Force every fixture off",
                    },
                    {
                      value: "staticColor",
                      label: "Static Color",
                      desc: "Force every fixture to a fixed idle color",
                    },
                    {
                      value: "effect",
                      label: "Effect",
                      desc: "Run a rhythm-independent effect over the rig, still animating while stopped",
                    },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    title={opt.desc}
                    onClick={() =>
                      void lighting.setConfig({ idleBehavior: opt.value })
                    }
                    className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                      li.idleBehavior === opt.value
                        ? "border-accent bg-accent/20 text-accent"
                        : "border-default/40 bg-default/10 text-foreground/60 hover:bg-default/20"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Field>

            {li.idleBehavior === "staticColor" && (
              <div className="flex flex-col gap-3 border-t border-default/20 pt-3">
                <HslColorPicker
                  r={li.idleColorR}
                  g={li.idleColorG}
                  b={li.idleColorB}
                  onChange={(r, g, b) =>
                    void lighting.setConfig({
                      idleColorR: r,
                      idleColorG: g,
                      idleColorB: b,
                    })
                  }
                />
                <LabeledSlider
                  label={`Intensity: ${Math.round(li.idleIntensity * 100)}%`}
                  value={li.idleIntensity}
                  onChange={(v) =>
                    void lighting.setConfig({ idleIntensity: v })
                  }
                />
              </div>
            )}

            {li.idleBehavior === "effect" &&
              (() => {
                const idleEt = li.idleEffectType as EffectType;
                const idlePreset = (li.idleGradientPreset ||
                  "solid") as GradientPreset;
                const idleUsesOwnColor = effectUsesOwnColor(idleEt, idlePreset);
                const idleSupportsGradient = effectSupportsGradient(idleEt);

                return (
                  <div className="flex flex-col gap-3 border-t border-default/20 pt-3">
                    <Field label="Effect">
                      <div className="grid grid-cols-4 gap-1">
                        {(
                          [
                            "none",
                            "strobe",
                            "pulse",
                            "ripple",
                            "converge",
                            "gradientflow",
                            "chase",
                            "helix",
                            "plasma",
                            "twinkle",
                            "sonicboom",
                            "fire",
                            "bouncing",
                            "drip",
                            "fireworks",
                            "colorwaves",
                            "strobeswipe",
                            "scanner",
                            "lightning",
                            "barberpole",
                          ] as EffectType[]
                        ).map((et) => {
                          const meta = EFFECT_META[et];
                          return (
                            <button
                              key={et}
                              type="button"
                              title={meta.desc}
                              onClick={() =>
                                void lighting.setConfig({ idleEffectType: et })
                              }
                              className={`flex flex-col items-center gap-0.5 rounded-lg border py-1.5 px-1 text-[10px] font-medium transition-colors ${
                                li.idleEffectType === et
                                  ? "border-accent bg-accent/20 text-accent"
                                  : "border-default/40 bg-default/10 text-foreground/60 hover:bg-default/20"
                              }`}
                            >
                              {meta.icon}
                              <span>{meta.label}</span>
                            </button>
                          );
                        })}
                      </div>
                      {li.idleEffectType && li.idleEffectType !== "none" && (
                        <div className="mt-1 text-[10px] text-foreground/40 italic">
                          {EFFECT_META[idleEt]?.desc}
                        </div>
                      )}
                    </Field>

                    {li.idleEffectType !== "none" && (
                      <>
                        <LabeledSlider
                          label={`Rate: ${li.idleEffectRateHz.toFixed(1)} Hz`}
                          min={0.05}
                          max={10}
                          step={0.05}
                          value={li.idleEffectRateHz}
                          onChange={(v) =>
                            void lighting.setConfig({ idleEffectRateHz: v })
                          }
                        />

                        {idleSupportsGradient && (
                          <Field label="Gradient Palette">
                            <div className="grid grid-cols-2 gap-1.5">
                              {(
                                Object.keys(GRADIENT_META) as GradientPreset[]
                              ).map((g) => (
                                <button
                                  key={g}
                                  type="button"
                                  onClick={() =>
                                    void lighting.setConfig({
                                      idleGradientPreset: g,
                                    })
                                  }
                                  className={`rounded-lg border px-2 py-1 text-left text-xs font-medium transition-colors ${
                                    (li.idleGradientPreset || "solid") === g
                                      ? "border-accent bg-accent/20 text-accent"
                                      : "border-default/50 bg-default/10 text-foreground/60 hover:bg-default/20"
                                  }`}
                                >
                                  {GRADIENT_META[g]}
                                </button>
                              ))}
                            </div>
                            {li.idleGradientPreset === "custom" && (
                              <div className="mt-2">
                                <GradientStopEditor
                                  value={li.idleGradientColors || ""}
                                  onChange={(colors) =>
                                    void lighting.setConfig({
                                      idleGradientColors: colors,
                                    })
                                  }
                                />
                              </div>
                            )}
                          </Field>
                        )}
                      </>
                    )}

                    {idleUsesOwnColor ? (
                      <div className="rounded-lg border border-default/30 bg-default/10 px-3 py-2 text-xs text-foreground/50 italic">
                        Color is driven by{" "}
                        {EFFECT_META[idleEt]?.label || idleEt} palette
                      </div>
                    ) : (
                      <HslColorPicker
                        r={li.idleColorR}
                        g={li.idleColorG}
                        b={li.idleColorB}
                        onChange={(r, g, b) =>
                          void lighting.setConfig({
                            idleColorR: r,
                            idleColorG: g,
                            idleColorB: b,
                          })
                        }
                      />
                    )}

                    <LabeledSlider
                      label={`Intensity: ${Math.round(li.idleIntensity * 100)}%`}
                      value={li.idleIntensity}
                      onChange={(v) =>
                        void lighting.setConfig({ idleIntensity: v })
                      }
                    />
                  </div>
                );
              })()}
          </div>

          {/* Default DMX send rate -- a universe is one shared wire, so a
              fixture can only slow it down (not speed it up) below this;
              see LightFixture::refreshRateHz for the per-fixture override
              and why the slowest one on a universe wins. */}
          <div className="rounded-xl border border-default/30 bg-default/5 px-4 py-3">
            <Field label="Default DMX Output Rate (Hz)">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={60}
                  className={numberCls}
                  value={li.defaultRefreshRateHz}
                  onChange={(e) =>
                    void lighting.setConfig({
                      defaultRefreshRateHz: Math.min(
                        60,
                        Math.max(1, Number(e.target.value) || 44),
                      ),
                    })
                  }
                />
                <span className="text-[10px] text-foreground/40">
                  Applies to every fixture that doesn&apos;t set its own rate
                  below.
                </span>
              </div>
            </Field>
          </div>

          {/* DMX generic fixtures are driven through the exact same
              rig editor, track/cue assignment, and effects pipeline as
              ResoLight bars below -- resolveLightOutputs/LightOutputResolver
              never distinguish fixture kind, only addressable/ledCount, so
              the only thing DMX fixtures were actually missing was a way to
              create/remove them and see this editor at all. */}
          {(li.kind === "resoLight" || li.kind === "dmxGeneric") && (
            <div className="flex flex-col gap-4">
              {/* Rig size + auto-layout */}
              <div className="rounded-xl border border-default/30 bg-default/5 p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className={labelCls}>Rig Layout</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        const positions = autoLayoutPositions(li.fixtures);
                        for (const p of positions) {
                          void lighting.fixtureUpdate({
                            fixtureId: p.id,
                            posX: p.posX,
                            posZ: p.posZ,
                          });
                        }
                      }}
                      className="flex items-center gap-1.5 rounded-lg border border-default/50 bg-default/20 px-3 py-1 text-xs font-medium text-foreground/70 hover:bg-default/35 transition-colors"
                      title="Evenly spread all fixtures in a horizontal line"
                    >
                      <Wand2 size={12} />
                      Auto-layout
                    </button>
                    {li.kind === "dmxGeneric" && (
                      <button
                        type="button"
                        onClick={() => void lighting.fixtureAdd()}
                        className="flex items-center gap-1.5 rounded-lg border border-accent/50 bg-accent/15 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/25 transition-colors"
                        title="Add a new DMX fixture"
                      >
                        <Plus size={12} />
                        Add Fixture
                      </button>
                    )}
                  </div>
                </div>
                {li.kind === "resoLight" ? (
                  <div className="flex flex-wrap gap-3">
                    <Field label="Columns">
                      <input
                        type="number"
                        min={0}
                        max={32}
                        className={numberCls}
                        value={li.resoLightColumns}
                        onChange={(e) =>
                          void lighting.setConfig({
                            resoLightColumns: Math.max(
                              0,
                              Number(e.target.value) || 0,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label="Rows">
                      <input
                        type="number"
                        min={0}
                        max={32}
                        className={numberCls}
                        value={li.resoLightRows}
                        onChange={(e) =>
                          void lighting.setConfig({
                            resoLightRows: Math.max(
                              0,
                              Number(e.target.value) || 0,
                            ),
                          })
                        }
                      />
                    </Field>
                    <div className="flex-1 self-end pb-1.5 text-xs text-foreground/50">
                      {li.fixtures.length} bar
                      {li.fixtures.length === 1 ? "" : "s"} total
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-foreground/50">
                    {li.fixtures.length} fixture
                    {li.fixtures.length === 1 ? "" : "s"} total -- add or remove
                    individually below; each drives through the same
                    tracks/cues/effects as a ResoLight bar.
                  </div>
                )}
              </div>

              {/* 3D Viewport */}
              <div className="rounded-xl border border-default/30 overflow-hidden">
                <div
                  className="relative h-72 w-full bg-background"
                  onWheel={(e) => e.stopPropagation()}
                >
                  <ResoLightStage3D
                    mode="edit"
                    fixtures={li.fixtures}
                    selectedFixtureId={selectedFixtureId}
                    onSelectFixture={setSelectedFixtureId}
                    onFixtureMoved={(id, x, z) =>
                      void lighting.fixtureUpdate({
                        fixtureId: id,
                        posX: x,
                        posZ: z,
                      })
                    }
                    live={li.enabled}
                  />
                </div>
              </div>

              {/* Fixture list */}
              {li.fixtures.length > 0 && (
                <div className="rounded-xl border border-default/30 bg-default/5 p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className={labelCls}>Fixtures</span>
                    <span className="text-[10px] text-foreground/40">
                      Click to select · drag in 3D to reposition
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
                    {li.fixtures.map((f, i) => (
                      <FixtureItem
                        key={f.id}
                        fixture={f}
                        fixtureIndex={i}
                        live={li.enabled}
                        selected={f.id === selectedFixtureId}
                        onSelect={() => setSelectedFixtureId(f.id)}
                        onRemove={() => {
                          if (selectedFixtureId === f.id)
                            setSelectedFixtureId(null);
                          void lighting.fixtureRemove(f.id);
                        }}
                        hasChannelConflict={dmxConflicts.has(f.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Selected fixture editor */}
              {selected && (
                <div className="rounded-xl border border-accent/30 bg-accent/5 p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-xs font-semibold text-accent uppercase tracking-wide">
                      Editing: {selected.name}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void lighting.fixtureDuplicate(selected.id)
                      }
                      className="flex items-center gap-1 rounded-lg border border-default/50 bg-default/20 px-2 py-1 text-[10px] font-medium text-foreground/70 hover:bg-default/35 transition-colors"
                      title="Duplicate this fixture (same settings, offset position, next free DMX channels)"
                    >
                      <Copy size={11} />
                      Duplicate
                    </button>
                  </div>

                  <div
                    className={
                      selected.kind === "dmxGeneric"
                        ? "grid grid-cols-1 gap-3"
                        : "grid grid-cols-2 gap-3"
                    }
                  >
                    <Field label="Name">
                      <input
                        type="text"
                        className={selectCls}
                        value={selected.name}
                        onChange={(e) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            name: e.target.value,
                          })
                        }
                      />
                    </Field>
                    {selected.kind === "resoLightBar" && (
                      <Field label="LEDs">
                        <input
                          type="number"
                          min={1}
                          className={numberCls}
                          value={selected.ledCount}
                          onChange={(e) =>
                            void lighting.fixtureUpdate({
                              fixtureId: selected.id,
                              ledCount: Math.max(
                                1,
                                Number(e.target.value) || 1,
                              ),
                            })
                          }
                        />
                      </Field>
                    )}
                  </div>

                  {/* Shape -- purely cosmetic (which 3D layout the stage
                      draws). For DmxGeneric it's the housing silhouette
                      (which real fixture type this is); for ResoLightBar
                      it rearranges the same linear pixel array into a
                      different physical layout (see ResoLightStage3D.tsx). */}
                  <Field label="Fixture Shape">
                    <div className="grid grid-cols-5 gap-1.5">
                      {(selected.kind === "resoLightBar"
                        ? RESOLIGHT_SHAPES
                        : DMX_GENERIC_SHAPES
                      ).map((shape) => {
                        const Icon = SHAPE_ICON[shape];
                        return (
                          <button
                            key={shape}
                            type="button"
                            onClick={() =>
                              void lighting.fixtureUpdate(
                                // A Ring is always uniform-color -- force
                                // addressable off so stale per-pixel data
                                // from a previous shape never lingers.
                                shape === "ring"
                                  ? {
                                      fixtureId: selected.id,
                                      shape,
                                      addressable: false,
                                    }
                                  : { fixtureId: selected.id, shape },
                              )
                            }
                            title={SHAPE_META[shape].label}
                            className={`flex flex-col items-center gap-1 rounded-lg border py-2 text-[10px] font-medium transition-colors ${
                              selected.shape === shape
                                ? "border-accent bg-accent/20 text-accent"
                                : "border-default/40 bg-default/10 text-foreground/60 hover:bg-default/20"
                            }`}
                          >
                            <Icon size={16} />
                            {SHAPE_META[shape].label}
                          </button>
                        );
                      })}
                    </div>
                  </Field>

                  {selected.kind === "resoLightBar" &&
                    selected.shape === "matrix" && (
                      <Field label="Matrix Columns (0 = auto)">
                        <input
                          type="number"
                          min={0}
                          max={31}
                          className={numberCls}
                          value={selected.matrixCols}
                          onChange={(e) =>
                            void lighting.fixtureUpdate({
                              fixtureId: selected.id,
                              matrixCols: Math.max(
                                0,
                                Number(e.target.value) || 0,
                              ),
                            })
                          }
                        />
                      </Field>
                    )}

                  {/* Color Type -- unlike DmxGeneric's Channel Profile (a UI
                      label only), this genuinely changes how many bytes get
                      written per pixel (see resoLightRealChannelCount /
                      ResoLightChannelMap.h's colorProfileByteCount). */}
                  {selected.kind === "resoLightBar" &&
                    (() => {
                      // Only dimmer/rgb/rgbw are offered, but the stored field
                      // is the wider shared ChannelProfile type -- fall back to
                      // "rgb" (the struct default) for the description/count
                      // readout if it's ever something else (e.g. hand-edited
                      // project data).
                      const colorType: ResoLightColorType =
                        selected.channelProfile === "dimmer" ||
                        selected.channelProfile === "rgbw"
                          ? selected.channelProfile
                          : "rgb";
                      return (
                        <Field label="Color Type">
                          <div className="grid grid-cols-3 gap-1.5">
                            {RESOLIGHT_COLOR_TYPES.map((ct) => (
                              <button
                                key={ct}
                                type="button"
                                onClick={() =>
                                  void lighting.fixtureUpdate({
                                    fixtureId: selected.id,
                                    channelProfile: ct,
                                  })
                                }
                                title={
                                  RESOLIGHT_COLOR_TYPE_META[ct].description
                                }
                                className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                                  colorType === ct
                                    ? "border-accent bg-accent/20 text-accent"
                                    : "border-default/40 bg-default/10 text-foreground/60 hover:bg-default/20"
                                }`}
                              >
                                {RESOLIGHT_COLOR_TYPE_META[ct].label}
                              </button>
                            ))}
                          </div>
                          <div className="mt-1 text-[10px] text-foreground/40 italic">
                            {RESOLIGHT_COLOR_TYPE_META[colorType].description}{" "}
                            Real channel count:{" "}
                            {resoLightRealChannelCount(
                              colorType,
                              selected.ledCount,
                              selected.addressable,
                            )}
                            .
                          </div>
                        </Field>
                      );
                    })()}

                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Height (m)">
                      <input
                        type="number"
                        step={0.1}
                        className={numberCls}
                        value={selected.posY}
                        onChange={(e) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            posY: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </Field>
                    <Field label="Pos X (m)">
                      <input
                        type="number"
                        step={0.1}
                        className={numberCls}
                        value={selected.posX.toFixed(2)}
                        onChange={(e) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            posX: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </Field>
                    <Field label="Pos Z (m)">
                      <input
                        type="number"
                        step={0.1}
                        className={numberCls}
                        value={selected.posZ.toFixed(2)}
                        onChange={(e) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            posZ: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </Field>
                  </div>

                  {/* Mount: standing vs. laid on its side -- a physical
                      mount choice, independent of yaw (which way it faces).
                      Only meaningful for a ResoLight bar's shape. */}
                  {selected.kind === "resoLightBar" && (
                    <Field label="Mount">
                      <div className="flex gap-2">
                        {(
                          [
                            {
                              label: "Vertical",
                              icon: MoveVertical,
                              value: false,
                            },
                            {
                              label: "Horizontal",
                              icon: MoveHorizontal,
                              value: true,
                            },
                          ] as const
                        ).map((opt) => (
                          <button
                            key={opt.label}
                            type="button"
                            onClick={() =>
                              void lighting.fixtureUpdate({
                                fixtureId: selected.id,
                                mountedHorizontally: opt.value,
                              })
                            }
                            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                              selected.mountedHorizontally === opt.value
                                ? "border-accent bg-accent/20 text-accent"
                                : "border-default/50 bg-default/10 text-foreground/60 hover:bg-default/20"
                            }`}
                          >
                            <opt.icon size={13} />
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </Field>
                  )}

                  <Field label="Yaw (°) -- which way it faces">
                    <div className="flex gap-2">
                      {/* Custom rotation */}
                      <input
                        type="number"
                        step={5}
                        className="w-20 rounded-lg border border-default/60 bg-default/20 px-2 py-1 text-xs outline-none focus:border-accent text-center"
                        value={selected.rotationYDeg}
                        title="Custom rotation (°)"
                        onChange={(e) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            rotationYDeg: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </div>
                  </Field>

                  {/* Tilt: cosmetic aim/pitch off vertical -- a real hung
                      fixture is angled at the stage via its yoke, not
                      standing bolt upright like a ResoLightBar. */}
                  {selected.kind === "dmxGeneric" && (
                    <Field label="Tilt (°) -- aim off vertical">
                      <div className="flex gap-2">
                        <input
                          type="number"
                          step={5}
                          min={-90}
                          max={90}
                          className="w-20 rounded-lg border border-default/60 bg-default/20 px-2 py-1 text-xs outline-none focus:border-accent text-center"
                          value={selected.tiltDeg}
                          onChange={(e) =>
                            void lighting.fixtureUpdate({
                              fixtureId: selected.id,
                              tiltDeg: Number(e.target.value) || 0,
                            })
                          }
                        />
                      </div>
                    </Field>
                  )}

                  {/* Grid position -- only meaningful for a ResoLight bar
                      seeded from the Columns x Rows layout above. */}
                  {selected.kind === "resoLightBar" && (
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Grid Column">
                        <input
                          type="number"
                          min={0}
                          max={31}
                          className={numberCls}
                          value={selected.gridColumn}
                          onChange={(e) =>
                            void lighting.fixtureUpdate({
                              fixtureId: selected.id,
                              gridColumn: Math.max(
                                0,
                                Number(e.target.value) || 0,
                              ),
                            })
                          }
                        />
                      </Field>
                      <Field label="Grid Row">
                        <input
                          type="number"
                          min={0}
                          max={31}
                          className={numberCls}
                          value={selected.gridRow}
                          onChange={(e) =>
                            void lighting.fixtureUpdate({
                              fixtureId: selected.id,
                              gridRow: Math.max(0, Number(e.target.value) || 0),
                            })
                          }
                        />
                      </Field>
                    </div>
                  )}

                  {/* A Ring is always uniform-color (no per-pixel control) --
                      not offering the option at all instead of showing it
                      forced-unchecked. */}
                  {selected.kind === "resoLightBar" &&
                    selected.shape !== "ring" && (
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selected.addressable}
                          onChange={(e) =>
                            void lighting.fixtureUpdate({
                              fixtureId: selected.id,
                              addressable: e.target.checked,
                            })
                          }
                        />
                        <span>Addressable strip (individual LED control)</span>
                      </label>
                    )}

                  {/* DMX fields -- only meaningful for a DmxGeneric fixture.
                      A ResoLightBar's real channels are auto-packed by
                      assignResoLightChannels from its ledCount/addressable,
                      never from these stored fields, so showing them here
                      for a bar would just be lying about what controls the
                      real output. */}
                  {selected.kind === "dmxGeneric" && (
                    <div className="border-t border-default/20 pt-3 flex flex-col gap-2">
                      <div className={labelCls + " mb-1"}>DMX Output</div>
                      {dmxConflicts.has(selected.id) && (
                        <div className="flex items-center gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[10px] text-warning">
                          <TriangleAlert size={12} className="shrink-0" />
                          Overlaps another fixture's DMX channels in this
                          universe.
                        </div>
                      )}

                      {/* Channel Profile: a named personality preset --
                          picking one sets Ch Count for you and labels what
                          each channel actually does (real fixtures ship
                          with a fixed channel layout; this documents it
                          instead of making the user remember it). Custom
                          leaves Ch Count exactly as typed below. */}
                      <Field label="Channel Profile">
                        <select
                          className={selectCls}
                          value={selected.channelProfile}
                          onChange={(e) => {
                            const profile = e.target.value as ChannelProfile;
                            const meta = CHANNEL_PROFILES[profile];
                            void lighting.fixtureUpdate(
                              meta.channelCount > 0
                                ? {
                                    fixtureId: selected.id,
                                    channelProfile: profile,
                                    dmxChannelCount: meta.channelCount,
                                  }
                                : {
                                    fixtureId: selected.id,
                                    channelProfile: profile,
                                  },
                            );
                          }}
                        >
                          {(
                            Object.keys(CHANNEL_PROFILES) as ChannelProfile[]
                          ).map((p) => (
                            <option key={p} value={p}>
                              {CHANNEL_PROFILES[p].label}
                              {CHANNEL_PROFILES[p].channelCount > 0
                                ? ` (${CHANNEL_PROFILES[p].channelCount}ch)`
                                : ""}
                            </option>
                          ))}
                        </select>
                      </Field>
                      {selected.channelProfile !== "custom" && (
                        <div className="text-[10px] text-foreground/40 font-mono">
                          {channelRoleLabels(
                            selected.channelProfile,
                            selected.dmxStartChannel,
                          ).join(" · ")}
                        </div>
                      )}

                      <div className="grid grid-cols-3 gap-3">
                        <Field label="Universe">
                          <input
                            type="number"
                            min={0}
                            className={numberCls}
                            value={selected.dmxUniverse}
                            onChange={(e) =>
                              void lighting.fixtureUpdate({
                                fixtureId: selected.id,
                                dmxUniverse: Number(e.target.value) || 0,
                              })
                            }
                          />
                        </Field>
                        <Field label="Start Ch">
                          <input
                            type="number"
                            min={1}
                            max={512}
                            className={numberCls}
                            value={selected.dmxStartChannel}
                            onChange={(e) =>
                              void lighting.fixtureUpdate({
                                fixtureId: selected.id,
                                dmxStartChannel: Math.max(
                                  1,
                                  Number(e.target.value) || 1,
                                ),
                              })
                            }
                          />
                        </Field>
                        <Field label="Ch Count">
                          <input
                            type="number"
                            min={1}
                            max={512}
                            disabled={selected.channelProfile !== "custom"}
                            title={
                              selected.channelProfile !== "custom"
                                ? "Set by the Channel Profile above -- switch to Custom to edit directly"
                                : undefined
                            }
                            className={`${numberCls} disabled:opacity-50 disabled:cursor-not-allowed`}
                            value={selected.dmxChannelCount}
                            onChange={(e) =>
                              void lighting.fixtureUpdate({
                                fixtureId: selected.id,
                                dmxChannelCount: Math.max(
                                  1,
                                  Number(e.target.value) || 1,
                                ),
                              })
                            }
                          />
                        </Field>
                      </div>
                    </div>
                  )}

                  {/* Refresh Rate override -- applies to either fixture
                      kind, since a universe is one shared wire regardless
                      of what's patched into it (see LightFixture::
                      refreshRateHz's doc comment on why the SLOWEST rate
                      on a universe wins). */}
                  <div className="border-t border-default/20 pt-3">
                    <Field
                      label={`Refresh Rate Override (Hz, 0 = use default: ${li.defaultRefreshRateHz})`}
                    >
                      <input
                        type="number"
                        min={0}
                        max={60}
                        className={numberCls}
                        value={selected.refreshRateHz}
                        onChange={(e) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            refreshRateHz: Math.min(
                              60,
                              Math.max(0, Number(e.target.value) || 0),
                            ),
                          })
                        }
                      />
                    </Field>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
