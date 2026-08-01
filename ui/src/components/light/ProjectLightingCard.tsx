import { useState } from "react";
import { lighting } from "../../lib/api";
import type { LightFixtureRow, LightingState, WebUiState } from "../../lib/types";
import { ResoLightStage3D } from "./ResoLightStage3D";
import { resolveLightCueValue } from "../../lib/lightCueInterpolation";

const selectCls =
  "w-full rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-sm outline-none focus:border-accent";
const labelCls =
  "text-[11px] font-semibold uppercase tracking-wide text-foreground/50";
const numberCls =
  "w-20 rounded-lg border border-default/60 bg-default/20 px-2 py-1 text-sm outline-none focus:border-accent";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  );
}

// ─── Auto-layout positions ────────────────────────────────────────────────

function autoLayoutPositions(fixtures: LightFixtureRow[]): { id: string; posX: number; posZ: number }[] {
  if (fixtures.length === 0) return [];
  const spacing = 1.2;
  const total = fixtures.length;
  const half = (total - 1) / 2;
  return fixtures.map((f, i) => ({
    id: f.id,
    posX: (i - half) * spacing,
    posZ: 0,
  }));
}

// ─── Fixture orientation label ────────────────────────────────────────────

function isHorizontalFixture(f: LightFixtureRow) {
  return Math.abs((f.rotationYDeg % 360) - 180) < 5;
}

// ─── Fixture row ──────────────────────────────────────────────────────────

function FixtureItem({
  fixture,
  selected,
  onSelect,
  previewColor,
}: {
  fixture: LightFixtureRow;
  selected: boolean;
  onSelect: () => void;
  previewColor?: { r: number; g: number; b: number; intensity: number };
}) {
  const hasColor = previewColor && previewColor.intensity > 0.01;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex items-center gap-2.5 w-full rounded-lg border px-3 py-2 text-left transition-all ${
        selected
          ? "border-accent/60 bg-accent/10"
          : "border-default/30 bg-default/10 hover:bg-default/20"
      }`}
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
      <span className="flex-1 truncate text-xs font-medium text-foreground/80">
        {fixture.name}
      </span>
      <span className="shrink-0 text-[9px] text-foreground/40 font-mono">
        {fixture.ledCount}L · {isHorizontalFixture(fixture) ? "H" : "V"}
        {fixture.addressable ? " · addr" : ""}
      </span>
    </button>
  );
}

// ─── ProjectLightingPanel ─────────────────────────────────────────────────
// Renamed from ProjectLightingCard since it no longer has a Card wrapper.
export function ProjectLightingPanel({
  li,
  state,
}: {
  li: LightingState;
  state: WebUiState;
}) {
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(
    li.fixtures[0]?.id ?? null,
  );
  const selected = li.fixtures.find((f) => f.id === selectedFixtureId) ?? null;

  // Live preview colors from current playhead
  const songIndex = state.songIndex;
  const song = state.songs[songIndex];
  const playhead = state.playheadSeconds;

  const previewColors: Record<string, { r: number; g: number; b: number; intensity: number }> = {};
  if (li.enabled && song?.lightCues) {
    for (const track of state.lightTracks) {
      const trackCues = song.lightCues.filter((c) => c.trackId === track.id);
      const val = resolveLightCueValue(trackCues, playhead);
      for (const fixtureId of track.fixtureIds) {
        previewColors[fixtureId] = val;
      }
    }
  }

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

          {li.kind === "dmxGeneric" && (
            <div className="rounded-lg bg-default/10 px-3 py-2 text-xs text-foreground/60">
              Generic fixtures fire through the existing DMX/HTTP timeline
              events (Editor &gt; Events) -- no dedicated setup here yet.
            </div>
          )}

          {li.kind === "resoLight" && (
            <div className="flex flex-col gap-4">
              {/* Rig size + auto-layout */}
              <div className="rounded-xl border border-default/30 bg-default/5 p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className={labelCls}>Rig Layout</span>
                  <button
                    type="button"
                    onClick={() => {
                      const positions = autoLayoutPositions(li.fixtures);
                      for (const p of positions) {
                        void lighting.fixtureUpdate({ fixtureId: p.id, posX: p.posX, posZ: p.posZ });
                      }
                    }}
                    className="rounded-lg border border-default/50 bg-default/20 px-3 py-1 text-xs font-medium text-foreground/70 hover:bg-default/35 transition-colors"
                    title="Evenly spread all fixtures in a horizontal line"
                  >
                    ⚙ Auto-layout
                  </button>
                </div>
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
                          resoLightColumns: Math.max(0, Number(e.target.value) || 0),
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
                          resoLightRows: Math.max(0, Number(e.target.value) || 0),
                        })
                      }
                    />
                  </Field>
                  <div className="flex-1 self-end pb-1.5 text-xs text-foreground/50">
                    {li.fixtures.length} bar{li.fixtures.length === 1 ? "" : "s"} total
                  </div>
                </div>
              </div>

              {/* 3D Viewport */}
              <div className="rounded-xl border border-default/30 overflow-hidden">
                <div
                  className="relative h-72 w-full bg-[#0b0f14]"
                  onWheel={(e) => e.stopPropagation()}
                >
                  <ResoLightStage3D
                    mode="edit"
                    fixtures={li.fixtures}
                    selectedFixtureId={selectedFixtureId}
                    onSelectFixture={setSelectedFixtureId}
                    onFixtureMoved={(id, x, z) =>
                      void lighting.fixtureUpdate({ fixtureId: id, posX: x, posZ: z })
                    }
                    previewColors={previewColors}
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
                    {li.fixtures.map((f) => (
                      <FixtureItem
                        key={f.id}
                        fixture={f}
                        selected={f.id === selectedFixtureId}
                        onSelect={() => setSelectedFixtureId(f.id)}
                        previewColor={previewColors[f.id]}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Selected fixture editor */}
              {selected && (
                <div className="rounded-xl border border-accent/30 bg-accent/5 p-4 flex flex-col gap-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-accent uppercase tracking-wide">
                      Editing: {selected.name}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
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
                    <Field label="LEDs">
                      <input
                        type="number"
                        min={1}
                        className={numberCls}
                        value={selected.ledCount}
                        onChange={(e) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            ledCount: Math.max(1, Number(e.target.value) || 1),
                          })
                        }
                      />
                    </Field>
                  </div>

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

                  {/* Orientation toggle */}
                  <Field label="Orientation">
                    <div className="flex gap-2">
                      {[
                        { label: "⬆ Vertical", value: 0 },
                        { label: "➡ Horizontal", value: 180 },
                      ].map((opt) => {
                        const isActive = Math.abs((selected.rotationYDeg % 360) - opt.value) < 5;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() =>
                              void lighting.fixtureUpdate({
                                fixtureId: selected.id,
                                rotationYDeg: opt.value,
                              })
                            }
                            className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                              isActive
                                ? "border-accent bg-accent/20 text-accent"
                                : "border-default/50 bg-default/10 text-foreground/60 hover:bg-default/20"
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
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

                  {/* Grid position */}
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
                            gridColumn: Math.max(0, Number(e.target.value) || 0),
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

                  {/* DMX fields */}
                  <div className="border-t border-default/20 pt-3 flex flex-col gap-2">
                    <div className={labelCls + " mb-1"}>DMX Output</div>
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
                              dmxStartChannel: Math.max(1, Number(e.target.value) || 1),
                            })
                          }
                        />
                      </Field>
                      <Field label="Ch Count">
                        <input
                          type="number"
                          min={1}
                          max={512}
                          className={numberCls}
                          value={selected.dmxChannelCount}
                          onChange={(e) =>
                            void lighting.fixtureUpdate({
                              fixtureId: selected.id,
                              dmxChannelCount: Math.max(1, Number(e.target.value) || 1),
                            })
                          }
                        />
                      </Field>
                    </div>
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

// Keep backward-compatible named export for any old direct uses
export { ProjectLightingPanel as ProjectLightingCard };
