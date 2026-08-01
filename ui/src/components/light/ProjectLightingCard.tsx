import { Card } from "@heroui/react";
import { useState } from "react";
import { lighting } from "../../lib/api";
import type { LightingState } from "../../lib/types";
import { ResoLightStage3D } from "./ResoLightStage3D";

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

// Project-scoped settings card (per-show data, not rig-wide AppSettings --
// see RESTORE_POINT.md Feature 6). Currently just the "Light" section;
// titled generically since other project-level settings may land here later.
export function ProjectLightingCard({ li }: { li: LightingState }) {
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(
    li.fixtures[0]?.id ?? null,
  );
  const selected = li.fixtures.find((f) => f.id === selectedFixtureId) ?? null;

  return (
    <Card>
      <Card.Header>
        <Card.Title>Project</Card.Title>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">Light</div>
            <div className="text-xs text-foreground/50">
              Drive a light rig alongside the show, synced to the timeline.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void lighting.setConfig({ enabled: !li.enabled })}
            className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors ${
              li.enabled
                ? "border-accent bg-accent/20 text-accent"
                : "border-default/60 bg-default/20 text-foreground/60 hover:bg-default/30"
            }`}
          >
            {li.enabled ? "Enabled" : "Disabled"}
          </button>
        </div>

        {li.enabled && (
          <>
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

            {li.kind === "dmxGeneric" && (
              <div className="rounded-lg bg-default/10 px-3 py-2 text-xs text-foreground/60">
                Generic fixtures fire through the existing DMX/HTTP timeline
                events (Editor &gt; Events) -- no dedicated setup here yet.
              </div>
            )}

            {li.kind === "resoLight" && (
              <>
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
                    -- drag one below to place it, or pick it from the list.
                  </div>
                </div>

                <div className="overflow-hidden rounded-lg border border-default/40">
                  <div
                    className="relative h-72 w-full bg-background-secondary"
                    // Prevent the page itself from scrolling while orbiting the camera.
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
                    />
                  </div>
                </div>

                {selected && (
                  <div className="flex flex-wrap items-end gap-3 rounded-lg bg-default/10 p-3">
                    <Field label="Selected fixture">
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
                    <Field label="Rotation (°)">
                      <input
                        type="number"
                        step={5}
                        className={numberCls}
                        value={selected.rotationYDeg}
                        onChange={(e) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            rotationYDeg: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </Field>
                    <label className="flex items-center gap-2 pb-1.5 text-sm">
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
                      Addressable strip
                    </label>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </Card.Content>
    </Card>
  );
}
