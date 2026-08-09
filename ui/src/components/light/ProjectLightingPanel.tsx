import {
  Checkbox,
  Chip,
  Description,
  Input,
  Label,
  ListBox,
  Select,
  Separator,
  TextField,
  Tooltip,
} from "@heroui/react";
import {
  Circle,
  Copy,
  Disc3,
  Grid3x3,
  Lamp,
  Move3D,
  MoveHorizontal,
  MoveVertical,
  Plus,
  Rows3,
  Spotlight,
  Trash2,
  TriangleAlert,
  Wand2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useLiveFixtureColor } from "../../hooks/useLiveFixtureColor";
import { lighting } from "../../lib/api";
import {
  CHANNEL_PROFILES,
  DMX_GENERIC_SHAPES,
  RESOLIGHT_COLOR_TYPES,
  RESOLIGHT_COLOR_TYPE_META,
  RESOLIGHT_SHAPES,
  SHAPE_META,
  channelRoleLabels,
  resoLightRealChannelCount,
  type ChannelProfile,
  type FixtureShape,
  type ResoLightColorType,
} from "../../lib/dmxProfiles";
import type {
  LightFixtureRow,
  LightingState,
  WebUiState,
} from "../../lib/types";
import {
  Alert,
  Button,
  ButtonGroup,
  Card,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
} from "../ui";
import { ResoLightStage3D, type PreviewColor } from "./LazyResoLightStage3D";
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
  EFFECT_META,
  IDLE_EFFECT_TYPES,
  effectSupportsGradient,
  effectUsesOwnColor,
  type GradientPreset,
} from "./lightEffectMeta";
import type { EffectType } from "./LightSidePanel";
import { CAPTION_CLS, TOGGLE_GROUP_CLS } from "./lightStyles";

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
  "moving-head": Move3D,
};

/** What the rig shows while the transport is stopped (LightingState.idle
 *  stores it untyped; these are the four the backend accepts). */
type IdleBehavior = NonNullable<
  Parameters<typeof lighting.setConfig>[0]["idleBehavior"]
>;

/** One bordered block of the panel. */
function Section({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <Card.Content className="flex flex-col gap-3 p-4">
        {(title || action) && (
          <div className="flex items-center justify-between gap-2">
            {title ? <Label className={CAPTION_CLS}>{title}</Label> : <span />}
            {action}
          </div>
        )}
        {children}
      </Card.Content>
    </Card>
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
  const generic = fixtures.filter((f) => f.kind === "dmx::generic");
  for (let i = 0; i < generic.length; i++) {
    const a = generic[i];
    const aEnd = a.dmx.startChannel + Math.max(1, a.dmx.channelCount);
    for (let j = i + 1; j < generic.length; j++) {
      const b = generic[j];
      if (a.dmx.universe !== b.dmx.universe) continue;
      const bEnd = b.dmx.startChannel + Math.max(1, b.dmx.channelCount);
      const overlaps = a.dmx.startChannel < bEnd && b.dmx.startChannel < aEnd;
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

/**
 * One row of the fixture list: a ToggleButton carrying the selection (the
 * whole list is one single-selection ToggleButtonGroup) plus its own remove
 * button as a sibling, since a button inside a button is not a thing.
 */
function FixtureItem({
  fixture,
  fixtureIndex,
  live,
  onRemove,
  hasChannelConflict,
}: {
  fixture: LightFixtureRow;
  fixtureIndex: number;
  live: boolean;
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
    fixture.kind === "dmx::generic" || fixture.shape !== "bar"
      ? SHAPE_ICON[fixture.shape]
      : null;
  return (
    <div className="flex w-full items-center gap-1">
      <ToggleButton
        id={fixture.id}
        variant="ghost"
        className={`min-w-0 flex-1 justify-start gap-2.5 ${
          hasChannelConflict ? "border border-warning" : ""
        }`}
      >
        {/* Live color dot */}
        <span
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
        {ShapeIcon && <ShapeIcon size={11} className="shrink-0 text-muted" />}
        <span className="flex-1 truncate text-left text-xs font-medium">
          {fixture.name}
        </span>
        {fixture.kind === "resolight::bar" && fixture.networkHost ? (
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              fixture.hwConnected ? "bg-success" : "bg-default"
            }`}
            title={
              fixture.hwConnected
                ? `Hardware linked · ${fixture.networkHost}`
                : `Hardware configured · ${fixture.networkHost} (not linked)`
            }
          />
        ) : null}
        {hasChannelConflict && (
          <TriangleAlert
            size={11}
            className="shrink-0 text-warning"
            aria-label="DMX channel conflict"
          />
        )}
        <span
          className={`shrink-0 font-mono text-[9px] ${
            hasChannelConflict ? "text-warning" : "text-muted"
          }`}
          title={
            hasChannelConflict
              ? "Overlaps another fixture's DMX channels"
              : undefined
          }
        >
          {fixture.kind === "dmx::generic"
            ? `U${fixture.dmx.universe}:${fixture.dmx.startChannel}`
            : `${fixture.ledCount}L · ${fixture.mountedHorizontally ? "H" : "V"}${fixture.addressable ? " · addr" : ""}`}
        </span>
      </ToggleButton>
      <Tooltip>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={`Remove ${fixture.name}`}
          onPress={onRemove}
        >
          <Trash2 size={12} />
        </Button>
        <Tooltip.Content>Remove fixture</Tooltip.Content>
      </Tooltip>
    </div>
  );
}

/** Local-draft host so typing an IP doesn't fight live WS re-renders, and so
 *  a half-typed address is never dialled -- commit lands on blur/Enter only.
 *  Port is always resolight::kDefaultBoardPort on both ends — no UI for it. */
function HardwareHostField({ fixture }: { fixture: LightFixtureRow }) {
  const [hostDraft, setHostDraft] = useState(fixture.networkHost);
  const [focused, setFocused] = useState(false);

  if (!focused && hostDraft !== fixture.networkHost) {
    setHostDraft(fixture.networkHost);
  }

  const commit = () => {
    setFocused(false);
    const host = hostDraft.trim();
    if (host === fixture.networkHost) return;
    void lighting.fixtureUpdate({ fixtureId: fixture.id, networkHost: host });
  };

  return (
    <TextField
      className="gap-1"
      value={hostDraft}
      onChange={setHostDraft}
      aria-label="Board IP"
    >
      <Label className={CAPTION_CLS}>Board IP</Label>
      <Input
        className="select-text"
        placeholder="e.g. 192.168.1.50"
        onFocus={() => setFocused(true)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <Description className="text-[10px]">
        Leave empty for preview only (no hardware).
      </Description>
    </TextField>
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
      <Card>
        <Card.Content className="p-4">
          <Switch
            isSelected={li.enabled}
            onChange={(enabled) => void lighting.setConfig({ enabled })}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Label className="text-sm font-semibold">Light System</Label>
            </Switch.Content>
            <Description>
              Drive a light rig alongside the show, synced to the timeline.
            </Description>
          </Switch>
        </Card.Content>
      </Card>

      {li.enabled && (
        <>
          {/* Fixture type */}
          <Section>
            <Select
              className="w-full"
              value={li.kind}
              onChange={(v) =>
                void lighting.setConfig({ kind: v as LightingState["kind"] })
              }
            >
              <Label className={CAPTION_CLS}>Fixture type</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="none" textValue="Not set">
                    Not set
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                  <ListBox.Item
                    id="resolight"
                    textValue="ResoLight (vertical LED bars)"
                  >
                    ResoLight (vertical LED bars)
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                  <ListBox.Item
                    id="dmx::generic"
                    textValue="Generic DMX / Art-Net / HTTP"
                  >
                    Generic DMX / Art-Net / HTTP
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          </Section>

          {/* Idle behavior -- what fixtures show while the transport is stopped */}
          <Section>
            <Field label="When playback is stopped">
              <ToggleButtonGroup
                isDetached
                aria-label="Idle behavior"
                className={`grid grid-cols-2 gap-1.5 ${TOGGLE_GROUP_CLS}`}
                disallowEmptySelection
                selectionMode="single"
                selectedKeys={[li.idle.behavior]}
                size="sm"
                onSelectionChange={(keys) => {
                  const next = [...keys][0] as IdleBehavior | undefined;
                  if (next) void lighting.setConfig({ idleBehavior: next });
                }}
              >
                {(
                  [
                    {
                      value: "hold",
                      label: "Hold Last",
                      desc: "Keep showing whatever the frozen playhead position resolves to",
                    },
                    {
                      value: "blackout",
                      label: "Blackout",
                      desc: "Force every fixture off",
                    },
                    {
                      value: "static",
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
                  <Tooltip key={opt.value}>
                    <ToggleButton id={opt.value}>{opt.label}</ToggleButton>
                    <Tooltip.Content>{opt.desc}</Tooltip.Content>
                  </Tooltip>
                ))}
              </ToggleButtonGroup>
            </Field>

            {li.idle.behavior === "static" && (
              <>
                <Separator />
                <LightColorPicker
                  r={li.idle.color.r}
                  g={li.idle.color.g}
                  b={li.idle.color.b}
                  onChange={(r, g, b) =>
                    void lighting.setConfig({
                      idleColorR: r,
                      idleColorG: g,
                      idleColorB: b,
                    })
                  }
                />
                <LabeledSlider
                  label="Intensity"
                  value={li.idle.intensity}
                  onChange={(v) =>
                    void lighting.setConfig({ idleIntensity: v })
                  }
                />
              </>
            )}

            {li.idle.behavior === "effect" &&
              (() => {
                const idleEt = li.idle.effect.type as EffectType;
                const idlePreset = (li.idle.gradient.preset ||
                  "solid") as GradientPreset;
                const idleUsesOwnColor = effectUsesOwnColor(idleEt, idlePreset);
                const idleSupportsGradient = effectSupportsGradient(idleEt);

                return (
                  <>
                    <Separator />
                    <EffectTypeGrid
                      types={IDLE_EFFECT_TYPES}
                      value={idleEt}
                      onChange={(et) =>
                        void lighting.setConfig({ idleEffectType: et })
                      }
                    />

                    {idleEt !== "none" && (
                      <>
                        <LabeledSlider
                          label="Rate"
                          min={0.05}
                          max={10}
                          step={0.05}
                          value={li.idle.effect.rateHz}
                          onChange={(v) =>
                            void lighting.setConfig({ idleEffectRateHz: v })
                          }
                          format={(v) => `${v.toFixed(1)} Hz`}
                        />

                        {idleSupportsGradient && (
                          <GradientPresetGroup
                            label="Gradient Palette"
                            value={idlePreset}
                            colors={li.idle.gradient.colors || ""}
                            onChange={(g) =>
                              void lighting.setConfig({ idleGradientPreset: g })
                            }
                            onColorsChange={(colors) =>
                              void lighting.setConfig({
                                idleGradientColors: colors,
                              })
                            }
                          />
                        )}
                      </>
                    )}

                    {idleUsesOwnColor ? (
                      <Alert status="default">
                        <Alert.Content>
                          <Alert.Description className="text-xs italic">
                            Color is driven by{" "}
                            {EFFECT_META[idleEt]?.label || idleEt} palette
                          </Alert.Description>
                        </Alert.Content>
                      </Alert>
                    ) : (
                      <LightColorPicker
                        r={li.idle.color.r}
                        g={li.idle.color.g}
                        b={li.idle.color.b}
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
                      label="Intensity"
                      value={li.idle.intensity}
                      onChange={(v) =>
                        void lighting.setConfig({ idleIntensity: v })
                      }
                    />
                  </>
                );
              })()}
          </Section>

          {/* Default DMX send rate -- a universe is one shared wire, so a
              fixture can only slow it down (not speed it up) below this;
              see LightFixture::refreshRateHz for the per-fixture override
              and why the slowest one on a universe wins. Also the default
              rate for ResoLight real-hardware WS frames. */}
          <Section>
            <NumberFieldControl
              label="Default Output Rate (Hz)"
              value={li.defaultRefreshRateHz}
              min={1}
              max={60}
              maxFractionDigits={0}
              description="DMX/Art-Net and ResoLight hardware frames. Per-fixture overrides below win when set."
              onCommit={(v) =>
                void lighting.setConfig({
                  defaultRefreshRateHz: Math.min(
                    60,
                    Math.max(1, Math.round(v)),
                  ),
                })
              }
            />
            {li.kind === "dmx::generic" && (
              <TextFieldControl
                label="Art-Net Target Host"
                placeholder="255.255.255.255 (broadcast)"
                value={li.artNetTargetHost ?? ""}
                description="Empty or 255.255.255.255 = LAN broadcast. Unicast IP for a specific Art-Net node."
                onCommit={(v) =>
                  void lighting.setConfig({ artNetTargetHost: v.trim() })
                }
              />
            )}
          </Section>

          {/* ResoLight real-hardware discovery (ESP32/ESP8266 on LAN).
              Preview-only by default -- boards only appear when powered and
              broadcasting; pairing is opt-in per fixture below. */}
          {li.kind === "resolight" && (
            <Section
              title="ResoLight Hardware"
              action={
                <Description className="text-[10px]">
                  Preview-only until a board IP is set per fixture
                </Description>
              }
            >
              {(li.discoveredBoards?.length ?? 0) === 0 ? (
                <Description className="text-[11px] leading-relaxed">
                  No boards discovered on the LAN yet. Power an ESP32/ESP8266
                  running the ResoLight firmware on the same Wi-Fi; it will
                  appear here automatically. Or type an IP on a fixture below.
                </Description>
              ) : (
                <div className="flex flex-col gap-1">
                  {(li.discoveredBoards ?? []).map((b) => (
                    <div
                      key={b.mac}
                      className="flex items-center gap-2 rounded-lg border border-default px-2.5 py-1.5 text-xs"
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                      <span className="truncate font-medium">
                        {b.name || "ResoLight"}
                      </span>
                      <Chip size="sm" variant="soft" className="font-mono">
                        {b.ip}
                      </Chip>
                      <span className="text-[10px] uppercase text-muted">
                        {b.chipType}
                      </span>
                      <span className="ml-auto font-mono text-[10px] text-muted">
                        {b.mac}
                      </span>
                    </div>
                  ))}
                  <Description className="text-[10px]">
                    Click a fixture below, then use &quot;Use discovered&quot;
                    or type the IP to bind it.
                  </Description>
                </div>
              )}
            </Section>
          )}

          {/* DMX generic fixtures are driven through the exact same
              rig editor, track/cue assignment, and effects pipeline as
              ResoLight bars below -- resolveLightOutputs/LightOutputResolver
              never distinguish fixture kind, only addressable/ledCount, so
              the only thing DMX fixtures were actually missing was a way to
              create/remove them and see this editor at all. */}
          {(li.kind === "resolight" || li.kind === "dmx::generic") && (
            <div className="flex flex-col gap-4">
              {/* Rig size + auto-layout */}
              <Section
                title="Rig Layout"
                action={
                  <ButtonGroup size="sm" variant="tertiary">
                    <Button
                      onPress={() => {
                        const positions = autoLayoutPositions(li.fixtures);
                        for (const p of positions) {
                          void lighting.fixtureUpdate({
                            fixtureId: p.id,
                            posX: p.posX,
                            posZ: p.posZ,
                          });
                        }
                      }}
                      aria-label="Evenly spread all fixtures in a horizontal line"
                    >
                      <Wand2 size={14} />
                      Auto-layout
                    </Button>
                    {li.kind === "dmx::generic" && (
                      <Button
                        onPress={() => void lighting.fixtureAdd()}
                        aria-label="Add a new DMX fixture"
                      >
                        <ButtonGroup.Separator />
                        <Plus size={14} />
                        Add Fixture
                      </Button>
                    )}
                  </ButtonGroup>
                }
              >
                {li.kind === "resolight" ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <NumberFieldControl
                      label="Columns"
                      value={li.resolight.columns}
                      min={0}
                      max={32}
                      maxFractionDigits={0}
                      onCommit={(v) =>
                        void lighting.setConfig({
                          resolightColumns: Math.max(0, Math.round(v)),
                        })
                      }
                    />
                    <NumberFieldControl
                      label="Rows"
                      value={li.resolight.rows}
                      min={0}
                      max={32}
                      maxFractionDigits={0}
                      onCommit={(v) =>
                        void lighting.setConfig({
                          resolightRows: Math.max(0, Math.round(v)),
                        })
                      }
                    />
                    <Description className="flex-1 pb-2 text-xs">
                      {li.fixtures.length} bar
                      {li.fixtures.length === 1 ? "" : "s"} total
                    </Description>
                  </div>
                ) : (
                  <Description className="text-xs">
                    {li.fixtures.length} fixture
                    {li.fixtures.length === 1 ? "" : "s"} total -- add or remove
                    individually below; each drives through the same
                    tracks/cues/effects as a ResoLight bar.
                  </Description>
                )}
              </Section>

              {/* 3D Viewport */}
              <Card className="overflow-hidden p-0">
                <div
                  className="relative h-72 w-full"
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
              </Card>

              {/* Fixture list */}
              {li.fixtures.length > 0 && (
                <Section
                  title="Fixtures"
                  action={
                    <Description className="text-[10px]">
                      Click to select · drag in 3D to reposition
                    </Description>
                  }
                >
                  <ToggleButtonGroup
                    isDetached
                    aria-label="Fixtures"
                    className={`flex max-h-48 flex-col gap-1.5 overflow-y-auto ${TOGGLE_GROUP_CLS}`}
                    selectionMode="single"
                    selectedKeys={selectedFixtureId ? [selectedFixtureId] : []}
                    size="sm"
                    onSelectionChange={(keys) =>
                      setSelectedFixtureId(([...keys][0] as string) ?? null)
                    }
                  >
                    {li.fixtures.map((f, i) => (
                      <FixtureItem
                        key={f.id}
                        fixture={f}
                        fixtureIndex={i}
                        live={li.enabled}
                        onRemove={() => {
                          if (selectedFixtureId === f.id)
                            setSelectedFixtureId(null);
                          void lighting.fixtureRemove(f.id);
                        }}
                        hasChannelConflict={dmxConflicts.has(f.id)}
                      />
                    ))}
                  </ToggleButtonGroup>
                </Section>
              )}

              {/* Selected fixture editor */}
              {selected && (
                <Section
                  key={selected.id}
                  title={`Editing: ${selected.name}`}
                  action={
                    <Tooltip>
                      <Button
                        size="sm"
                        variant="tertiary"
                        onPress={() =>
                          void lighting.fixtureDuplicate(selected.id)
                        }
                      >
                        <Copy size={14} />
                        Duplicate
                      </Button>
                      <Tooltip.Content>
                        Duplicate this fixture (same settings, offset position,
                        next free DMX channels)
                      </Tooltip.Content>
                    </Tooltip>
                  }
                >
                  <div
                    className={
                      selected.kind === "dmx::generic"
                        ? "grid grid-cols-1 gap-3"
                        : "grid grid-cols-2 gap-3"
                    }
                  >
                    <TextFieldControl
                      label="Name"
                      value={selected.name}
                      onCommit={(v) =>
                        void lighting.fixtureUpdate({
                          fixtureId: selected.id,
                          name: v,
                        })
                      }
                    />
                    {selected.kind === "resolight::bar" && (
                      <NumberFieldControl
                        label="LEDs"
                        value={selected.ledCount}
                        min={1}
                        maxFractionDigits={0}
                        onCommit={(v) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            ledCount: Math.max(1, Math.round(v)),
                          })
                        }
                      />
                    )}
                  </div>

                  {/* Shape -- purely cosmetic (which 3D layout the stage
                      draws). For DmxGeneric it's the housing silhouette
                      (which real fixture type this is); for ResoLightBar
                      it rearranges the same linear pixel array into a
                      different physical layout (see ResoLightStage3D.tsx). */}
                  <Field label="Fixture Shape">
                    <ToggleButtonGroup
                      isDetached
                      aria-label="Fixture shape"
                      // One row either way: four ResoLight layouts, five DMX
                      // housings.
                      className={`grid gap-1.5 ${TOGGLE_GROUP_CLS} ${
                        selected.kind === "resolight::bar"
                          ? "grid-cols-4"
                          : "grid-cols-5"
                      }`}
                      disallowEmptySelection
                      selectionMode="single"
                      selectedKeys={[selected.shape]}
                      size="sm"
                      onSelectionChange={(keys) => {
                        const shape = [...keys][0] as FixtureShape | undefined;
                        if (!shape) return;
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
                        );
                      }}
                    >
                      {(selected.kind === "resolight::bar"
                        ? RESOLIGHT_SHAPES
                        : DMX_GENERIC_SHAPES
                      ).map((shape) => {
                        const Icon = SHAPE_ICON[shape];
                        return (
                          <ToggleButton key={shape} id={shape}>
                            <Icon size={16} />
                            {SHAPE_META[shape].label}
                          </ToggleButton>
                        );
                      })}
                    </ToggleButtonGroup>
                  </Field>

                  {selected.kind === "resolight::bar" &&
                    selected.shape === "matrix" && (
                      <NumberFieldControl
                        label="Matrix Columns"
                        description="0 = auto"
                        value={selected.matrixColumns}
                        min={0}
                        max={31}
                        maxFractionDigits={0}
                        onCommit={(v) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            matrixCols: Math.max(0, Math.round(v)),
                          })
                        }
                      />
                    )}

                  {/* Color Type -- unlike DmxGeneric's Channel Profile (a UI
                      label only), this genuinely changes how many bytes get
                      written per pixel (see resoLightRealChannelCount /
                      ResoLightChannelMap.h's colorProfileByteCount). */}
                  {selected.kind === "resolight::bar" &&
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
                        <Field
                          label="Color Type"
                          description={
                            <>
                              {RESOLIGHT_COLOR_TYPE_META[colorType].description}{" "}
                              Real channel count:{" "}
                              {resoLightRealChannelCount(
                                colorType,
                                selected.ledCount,
                                selected.addressable,
                              )}
                              .
                            </>
                          }
                        >
                          <ToggleButtonGroup
                            isDetached
                            aria-label="Color type"
                            className={`grid grid-cols-3 gap-1.5 ${TOGGLE_GROUP_CLS}`}
                            disallowEmptySelection
                            selectionMode="single"
                            selectedKeys={[colorType]}
                            size="sm"
                            onSelectionChange={(keys) => {
                              const ct = [...keys][0] as
                                | ResoLightColorType
                                | undefined;
                              if (ct)
                                void lighting.fixtureUpdate({
                                  fixtureId: selected.id,
                                  channelProfile: ct,
                                });
                            }}
                          >
                            {RESOLIGHT_COLOR_TYPES.map((ct) => (
                              <Tooltip key={ct}>
                                <ToggleButton id={ct}>
                                  {RESOLIGHT_COLOR_TYPE_META[ct].label}
                                </ToggleButton>
                                <Tooltip.Content>
                                  {RESOLIGHT_COLOR_TYPE_META[ct].description}
                                </Tooltip.Content>
                              </Tooltip>
                            ))}
                          </ToggleButtonGroup>
                        </Field>
                      );
                    })()}

                  <div className="grid grid-cols-3 gap-3">
                    <NumberFieldControl
                      label="Height (m)"
                      value={selected.position.y}
                      step={0.1}
                      onCommit={(v) =>
                        void lighting.fixtureUpdate({
                          fixtureId: selected.id,
                          posY: v,
                        })
                      }
                    />
                    <NumberFieldControl
                      label="Pos X (m)"
                      value={selected.position.x}
                      step={0.1}
                      onCommit={(v) =>
                        void lighting.fixtureUpdate({
                          fixtureId: selected.id,
                          posX: v,
                        })
                      }
                    />
                    <NumberFieldControl
                      label="Pos Z (m)"
                      value={selected.position.z}
                      step={0.1}
                      onCommit={(v) =>
                        void lighting.fixtureUpdate({
                          fixtureId: selected.id,
                          posZ: v,
                        })
                      }
                    />
                  </div>

                  {/* Mount: standing vs. laid on its side -- a physical
                      mount choice, independent of yaw (which way it faces).
                      Only meaningful for a ResoLight bar's shape. */}
                  {selected.kind === "resolight::bar" && (
                    <Field label="Mount">
                      <ToggleButtonGroup
                        isDetached
                        fullWidth
                        aria-label="Mount"
                        className={`gap-2 ${TOGGLE_GROUP_CLS}`}
                        disallowEmptySelection
                        selectionMode="single"
                        selectedKeys={[
                          selected.mountedHorizontally
                            ? "horizontal"
                            : "vertical",
                        ]}
                        size="sm"
                        onSelectionChange={(keys) => {
                          const mount = [...keys][0] as string | undefined;
                          if (!mount) return;
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            mountedHorizontally: mount === "horizontal",
                          });
                        }}
                      >
                        <ToggleButton id="vertical">
                          <MoveVertical />
                          Vertical
                        </ToggleButton>
                        <ToggleButton id="horizontal">
                          <MoveHorizontal />
                          Horizontal
                        </ToggleButton>
                      </ToggleButtonGroup>
                    </Field>
                  )}

                  <NumberFieldControl
                    label="Yaw (°)"
                    description="Which way the fixture faces"
                    value={selected.rotation.y}
                    step={5}
                    onCommit={(v) =>
                      void lighting.fixtureUpdate({
                        fixtureId: selected.id,
                        rotationYDeg: v,
                      })
                    }
                  />

                  {/* Tilt: cosmetic aim/pitch off vertical -- a real hung
                      fixture is angled at the stage via its yoke, not
                      standing bolt upright like a ResoLightBar. */}
                  {selected.kind === "dmx::generic" && (
                    <NumberFieldControl
                      label="Tilt (°)"
                      description="Aim off vertical"
                      value={selected.tiltDegrees}
                      step={5}
                      min={-90}
                      max={90}
                      onCommit={(v) =>
                        void lighting.fixtureUpdate({
                          fixtureId: selected.id,
                          tiltDeg: v,
                        })
                      }
                    />
                  )}

                  {/* Grid position -- only meaningful for a ResoLight bar
                      seeded from the Columns x Rows layout above. */}
                  {selected.kind === "resolight::bar" && (
                    <div className="grid grid-cols-2 gap-3">
                      <NumberFieldControl
                        label="Grid Column"
                        value={selected.grid.column}
                        min={0}
                        max={31}
                        maxFractionDigits={0}
                        onCommit={(v) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            gridColumn: Math.max(0, Math.round(v)),
                          })
                        }
                      />
                      <NumberFieldControl
                        label="Grid Row"
                        value={selected.grid.row}
                        min={0}
                        max={31}
                        maxFractionDigits={0}
                        onCommit={(v) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            gridRow: Math.max(0, Math.round(v)),
                          })
                        }
                      />
                    </div>
                  )}

                  {/* A Ring is always uniform-color (no per-pixel control) --
                      not offering the option at all instead of showing it
                      forced-unchecked. */}
                  {selected.kind === "resolight::bar" &&
                    selected.shape !== "ring" && (
                      <Checkbox
                        isSelected={selected.addressable}
                        onChange={(addressable) =>
                          void lighting.fixtureUpdate({
                            fixtureId: selected.id,
                            addressable,
                          })
                        }
                      >
                        <Checkbox.Content>
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          <Label className="text-sm">
                            Addressable strip (individual LED control)
                          </Label>
                        </Checkbox.Content>
                      </Checkbox>
                    )}

                  {/* DMX fields -- only meaningful for a DmxGeneric fixture.
                      A ResoLightBar's real channels are auto-packed by
                      assignResoLightChannels from its ledCount/addressable,
                      never from these stored fields, so showing them here
                      for a bar would just be lying about what controls the
                      real output. */}
                  {selected.kind === "dmx::generic" && (
                    <>
                      <Separator />
                      <div className="flex flex-col gap-2">
                        <Label className={CAPTION_CLS}>DMX Output</Label>
                        {dmxConflicts.has(selected.id) && (
                          <Alert status="warning">
                            <Alert.Indicator />
                            <Alert.Content>
                              <Alert.Description className="text-[10px]">
                                Overlaps another fixture&apos;s DMX channels in
                                this universe.
                              </Alert.Description>
                            </Alert.Content>
                          </Alert>
                        )}

                        {/* Channel Profile: a named personality preset --
                            picking one sets Ch Count for you and labels what
                            each channel actually does (real fixtures ship
                            with a fixed channel layout; this documents it
                            instead of making the user remember it). Custom
                            leaves Ch Count exactly as typed below. */}
                        <Select
                          className="w-full"
                          value={selected.channelProfile}
                          onChange={(v) => {
                            const profile = v as ChannelProfile;
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
                          <Label className={CAPTION_CLS}>Channel Profile</Label>
                          <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox>
                              {(
                                Object.keys(
                                  CHANNEL_PROFILES,
                                ) as ChannelProfile[]
                              ).map((p) => {
                                const text = `${CHANNEL_PROFILES[p].label}${
                                  CHANNEL_PROFILES[p].channelCount > 0
                                    ? ` (${CHANNEL_PROFILES[p].channelCount}ch)`
                                    : ""
                                }`;
                                return (
                                  <ListBox.Item key={p} id={p} textValue={text}>
                                    {text}
                                    <ListBox.ItemIndicator />
                                  </ListBox.Item>
                                );
                              })}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                        {selected.channelProfile !== "custom" && (
                          <Description className="font-mono text-[10px]">
                            {channelRoleLabels(
                              selected.channelProfile,
                              selected.dmx.startChannel,
                            ).join(" · ")}
                          </Description>
                        )}

                        <div className="grid grid-cols-3 gap-3">
                          <NumberFieldControl
                            label="Universe"
                            value={selected.dmx.universe}
                            min={0}
                            maxFractionDigits={0}
                            onCommit={(v) =>
                              void lighting.fixtureUpdate({
                                fixtureId: selected.id,
                                dmxUniverse: Math.max(0, Math.round(v)),
                              })
                            }
                          />
                          <NumberFieldControl
                            label="Start Ch"
                            value={selected.dmx.startChannel}
                            min={1}
                            max={512}
                            maxFractionDigits={0}
                            onCommit={(v) =>
                              void lighting.fixtureUpdate({
                                fixtureId: selected.id,
                                dmxStartChannel: Math.max(1, Math.round(v)),
                              })
                            }
                          />
                          <NumberFieldControl
                            label="Ch Count"
                            value={selected.dmx.channelCount}
                            min={1}
                            max={512}
                            maxFractionDigits={0}
                            isDisabled={selected.channelProfile !== "custom"}
                            description={
                              selected.channelProfile !== "custom"
                                ? "Set by the Channel Profile above — switch to Custom to edit directly"
                                : undefined
                            }
                            onCommit={(v) =>
                              void lighting.fixtureUpdate({
                                fixtureId: selected.id,
                                dmxChannelCount: Math.max(1, Math.round(v)),
                              })
                            }
                          />
                        </div>
                      </div>
                    </>
                  )}

                  {/* Refresh Rate override -- applies to either fixture
                      kind, since a universe is one shared wire regardless
                      of what's patched into it (see LightFixture::
                      refreshRateHz's doc comment on why the SLOWEST rate
                      on a universe wins). */}
                  <Separator />
                  <NumberFieldControl
                    label="Refresh Rate Override (Hz)"
                    description={`0 = use the default: ${li.defaultRefreshRateHz} Hz`}
                    value={selected.refreshRateHz}
                    min={0}
                    max={60}
                    maxFractionDigits={0}
                    onCommit={(v) =>
                      void lighting.fixtureUpdate({
                        fixtureId: selected.id,
                        refreshRateHz: Math.min(60, Math.max(0, Math.round(v))),
                      })
                    }
                  />

                  {/* Real-hardware transport -- ResoLightBar only. Empty host
                      = preview-only (default). Setting an IP makes ResoStage
                      dial the board as a WS client and stream binary frames. */}
                  {selected.kind === "resolight::bar" && (
                    <>
                      <Separator />
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                          <Label className={CAPTION_CLS}>Hardware Link</Label>
                          {selected.networkHost ? (
                            <Chip
                              size="sm"
                              variant="soft"
                              color={
                                selected.hwConnected ? "success" : "default"
                              }
                            >
                              {selected.hwConnected
                                ? `Linked${selected.hwRssiDbm ? ` · ${selected.hwRssiDbm} dBm` : ""}${selected.hwChipType && selected.hwChipType !== "unknown" ? ` · ${selected.hwChipType}` : ""}`
                                : "Connecting…"}
                            </Chip>
                          ) : (
                            <Chip size="sm" variant="soft">
                              Preview only
                            </Chip>
                          )}
                        </div>
                        <HardwareHostField fixture={selected} />
                        {(li.discoveredBoards?.length ?? 0) > 0 && (
                          <ToggleButtonGroup
                            isDetached
                            aria-label="Discovered boards"
                            className={`flex flex-wrap gap-1 ${TOGGLE_GROUP_CLS}`}
                            selectionMode="single"
                            selectedKeys={
                              selected.networkHost ? [selected.networkHost] : []
                            }
                            size="sm"
                            onSelectionChange={(keys) => {
                              const ip = [...keys][0] as string | undefined;
                              void lighting.fixtureUpdate({
                                fixtureId: selected.id,
                                networkHost: ip ?? "",
                              });
                            }}
                          >
                            {(li.discoveredBoards ?? []).map((b) => (
                              <Tooltip key={b.mac}>
                                <ToggleButton id={b.ip} className="font-mono">
                                  {b.ip}
                                </ToggleButton>
                                <Tooltip.Content>
                                  Bind {b.name || b.mac} ({b.ip})
                                </Tooltip.Content>
                              </Tooltip>
                            ))}
                          </ToggleButtonGroup>
                        )}
                        {selected.networkHost ? (
                          <Button
                            size="sm"
                            variant="tertiary"
                            className="self-start text-[10px]"
                            onPress={() =>
                              void lighting.fixtureUpdate({
                                fixtureId: selected.id,
                                networkHost: "",
                              })
                            }
                          >
                            Clear — back to preview only
                          </Button>
                        ) : null}
                      </div>
                    </>
                  )}
                </Section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
