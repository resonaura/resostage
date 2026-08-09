/**
 * Shared light-editor controls, built from HeroUI's own components.
 *
 * Both light surfaces -- the Light screen's ProjectLightingPanel and the
 * Timeline's LightSidePanel -- edit the same three things (a colour, a
 * gradient, an effect), so those editors live here once instead of being
 * hand-rolled twice from raw <input>s.
 */
import {
  ColorArea,
  ColorField,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  ColorSwatchPicker,
  Description,
  Input,
  Label,
  NumberField,
  TextField,
  Tooltip,
  parseColor,
  type Color,
} from "@heroui/react";
import { Button, Slider, ToggleButton, ToggleButtonGroup } from "../ui";
import { ChevronDown, FlipHorizontal2, Plus, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  builtinPalette,
  parseGradientStops,
  type GradientStop,
} from "../../lib/lightCueInterpolation";
import {
  useCoalescedCommit,
  useFocusDraft,
  useLiveValue,
} from "../../lib/optimistic";
import { useEscRevert } from "../../lib/useEscRevert";
import {
  EFFECT_META,
  GRADIENT_META,
  effectRequiresAddressable,
  type GradientPreset,
} from "./lightEffectMeta";
import type { EffectType } from "./LightSidePanel";
import {
  CAPTION_CLS,
  CELL_TOGGLE_CLS,
  TILE_TOGGLE_CLS,
  TOGGLE_GROUP_CLS,
} from "./lightStyles";

// ─── Field scaffolding ────────────────────────────────────────────────────

/**
 * Caption + control. HeroUI's Label associates itself with whatever field
 * component wraps it (TextField, NumberField, Select, Slider); for the groups
 * that are not a single field -- an effect grid, a swatch row -- the group
 * carries its own aria-label and this is purely the visual caption.
 */
export function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className={CAPTION_CLS}>{label}</Label>
      {children}
      {description ? (
        <Description className="text-[10px]">{description}</Description>
      ) : null}
    </div>
  );
}

// ─── Text / number fields ─────────────────────────────────────────────────

/**
 * Text field that commits on every keystroke but ignores server echoes while
 * focused, so a remote client's WS frame can't reset the cursor mid-word.
 */
export function TextFieldControl({
  label,
  value,
  onCommit,
  placeholder,
  description,
}: {
  label?: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  description?: React.ReactNode;
}) {
  const { fieldProps } = useFocusDraft(value, onCommit);
  return (
    <TextField
      aria-label={label ? undefined : placeholder}
      value={fieldProps.value}
      onChange={fieldProps.onChange}
      className="gap-1"
    >
      {label ? <Label className={CAPTION_CLS}>{label}</Label> : null}
      <Input
        placeholder={placeholder}
        className="select-text"
        {...fieldProps.focusProps}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {description ? (
        <Description className="text-[10px]">{description}</Description>
      ) : null}
    </TextField>
  );
}

/**
 * Numeric field. React Aria's NumberField holds the raw text itself and only
 * reports a parsed value on commit (blur / Enter / stepper), which is exactly
 * the "let me type 1. without it being rounded away" behaviour these fields
 * used to hand-roll.
 */
export function NumberFieldControl({
  label,
  value,
  onCommit,
  min,
  max,
  step,
  maxFractionDigits = 2,
  isDisabled,
  description,
  groupClassName = "w-full max-w-40",
}: {
  label?: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  maxFractionDigits?: number;
  isDisabled?: boolean;
  description?: React.ReactNode;
  /** Width of the stepper itself. The field grows to its column otherwise,
   *  parking the +/- buttons at opposite ends of the card -- but it still
   *  shrinks with a narrow column, since its grid is a fixed `40px 1fr 40px`
   *  and would otherwise push the increment button out of the sidebar. */
  groupClassName?: string;
}) {
  return (
    <NumberField
      aria-label={label ? undefined : "Value"}
      value={value}
      // A cleared input reports NaN -- that is "nothing typed yet", not a
      // value the backend should be told about.
      onChange={(v) => {
        if (Number.isFinite(v)) onCommit(v);
      }}
      minValue={min}
      maxValue={max}
      step={step}
      isDisabled={isDisabled}
      formatOptions={{ maximumFractionDigits: maxFractionDigits }}
      className="gap-1"
    >
      {label ? <Label className={CAPTION_CLS}>{label}</Label> : null}
      <NumberField.Group className={groupClassName}>
        <NumberField.DecrementButton />
        <NumberField.Input className="px-1 text-center" />
        <NumberField.IncrementButton />
      </NumberField.Group>
      {description ? (
        <Description className="text-[10px]">{description}</Description>
      ) : null}
    </NumberField>
  );
}

// ─── Slider ───────────────────────────────────────────────────────────────

/**
 * Every plain 0..1-ish slider in the light editors (intensity, effect depth,
 * rate) goes through this one wrapper. useLiveValue provides a 500ms lock
 * after the last local edit so server echoes don't jump the thumb mid-drag
 * when a remote client is also editing.
 */
export function LabeledSlider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Readout next to the label. Defaults to a percentage of a 0..1 range. */
  format?: (v: number) => string;
}) {
  const [localValue, handleChange] = useLiveValue(value, onChange);
  // HeroUI's Slider only reports values, so the Esc revert is armed on a
  // wrapper the pointerdown bubbles through.
  const escRevert = useEscRevert(() => localValue, handleChange);
  const readout = format
    ? format(localValue)
    : `${Math.round(((localValue - min) / (max - min)) * 100)}%`;
  return (
    <Slider
      value={localValue}
      onChange={(v) => handleChange(Array.isArray(v) ? v[0] : v)}
      minValue={min}
      maxValue={max}
      step={step}
      className="gap-1"
      {...escRevert}
    >
      {/* Label and Output are placed by the component's own grid template
          ("label output" / "track track") -- wrapping them in a flex row
          drops both into an unplaced implicit row instead. */}
      <Label className={CAPTION_CLS}>{label}</Label>
      <Slider.Output className="text-[10px] text-muted">
        {readout}
      </Slider.Output>
      <Slider.Track>
        <Slider.Fill />
        <Slider.Thumb />
      </Slider.Track>
    </Slider>
  );
}

// ─── Colour ───────────────────────────────────────────────────────────────

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function toRgbTriple(color: Color): [number, number, number] {
  const rgb = color.toFormat("rgb");
  return [
    Math.round(rgb.getChannelValue("red")),
    Math.round(rgb.getChannelValue("green")),
    Math.round(rgb.getChannelValue("blue")),
  ];
}

/**
 * Fully-saturated, stage-console-style primaries/secondaries -- not iOS
 * system-colour pastels. On real LED hardware, "aesthetic" mid-saturation
 * swatches (dusty rose, lavender, ...) read as muddy/washed out; a working
 * light rig needs true red/green/blue/etc. as one-tap defaults, with the
 * area + hue slider below for anything more subtle.
 */
const PRESET_COLORS = [
  "#ff0000", // true red
  "#ff3c00", // orange-red
  "#ff8c00", // amber
  "#ffff00", // true yellow
  "#00ff00", // true green
  "#00ff8c", // spring green
  "#00ffff", // true cyan
  "#005aff", // true blue
  "#6e00ff", // violet
  "#ff00ff", // magenta
  "#ff0082", // pink
  "#ffffff", // white
];

/**
 * Keeps an HSB working copy of an r/g/b triple owned by the backend.
 *
 * HSB is what the area + hue slider actually edit, and it carries state RGB
 * cannot (the hue of a fully black or fully desaturated colour), so rebuilding
 * it from the echoed RGB on every frame would snap the hue back to 0 the
 * moment brightness hits zero. The server value is therefore only adopted when
 * it genuinely differs from what this working copy already renders to.
 */
function useRgbColor(
  r: number,
  g: number,
  b: number,
  onChange: (r: number, g: number, b: number) => void,
): [Color, (c: Color) => void] {
  const [color, setColor] = useState<Color>(() =>
    parseColor(rgbToHex(r, g, b)).toFormat("hsb"),
  );
  const lastRgb = useRef<[number, number, number]>([r, g, b]);

  if (lastRgb.current[0] !== r || lastRgb.current[1] !== g || lastRgb.current[2] !== b) {
    lastRgb.current = [r, g, b];
    const [cr, cg, cb] = toRgbTriple(color);
    if (cr !== r || cg !== g || cb !== b) {
      setColor(parseColor(rgbToHex(r, g, b)).toFormat("hsb"));
    }
  }

  // The area and the hue slider report a colour on every pointermove. The
  // swatch follows the pointer from local state; only the write to the engine
  // is held to one a frame -- see useCoalescedCommit.
  const [send] = useCoalescedCommit((triple: [number, number, number]) =>
    onChange(...triple),
  );

  const apply = (next: Color) => {
    const hsb = next.toFormat("hsb");
    setColor(hsb);
    const triple = toRgbTriple(hsb);
    lastRgb.current = triple;
    send(triple);
  };

  return [color, apply];
}

/**
 * The rig colour editor: a row of stage presets over a hex field, with the
 * full picker (area, hue, hex) one click away in a popover.
 *
 * Inline that picker is 250px of vertical space in every panel that shows a
 * colour -- and both panels are long enough already. The one-tap presets are
 * what a light rig reaches for anyway; anything subtler opens the popover.
 */
export function LightColorPicker({
  r,
  g,
  b,
  onChange,
}: {
  r: number;
  g: number;
  b: number;
  onChange: (r: number, g: number, b: number) => void;
}) {
  const [color, apply] = useRgbColor(r, g, b, onChange);
  // Area and slider report every intermediate value and keep no drag origin
  // of their own, so Esc restores the whole colour, not one channel. Armed
  // inside the popover: it is portaled, so pointer events never reach a
  // wrapper out here.
  const escRevert = useEscRevert(() => color, apply);

  return (
    <div className="flex w-full flex-col gap-2">
      {/* rs-swatch-round: HeroUI's "circle" variant is a radius multiple, not
          a circle -- at 24px it lands on a squircle. The class also sizes the
          preset's inner swatch to the field preview below it, so the two read
          as the same control rather than as two different ones. */}
      <ColorSwatchPicker
        aria-label="Preset colors"
        size="sm"
        variant="circle"
        className="rs-swatch-round"
        value={color}
        onChange={apply}
      >
        {PRESET_COLORS.map((preset) => (
          <ColorSwatchPicker.Item key={preset} color={preset}>
            <ColorSwatchPicker.Swatch />
            <ColorSwatchPicker.Indicator />
          </ColorSwatchPicker.Item>
        ))}
      </ColorSwatchPicker>

      <ColorPicker value={color} onChange={apply}>
        <ColorPicker.Trigger
          aria-label="Open color picker"
          className="w-full justify-between"
        >
          <span className="flex items-center gap-2">
            <ColorSwatch
              size="sm"
              color={color}
              className="rs-swatch-round"
            />
            <span className="font-mono text-sm uppercase">
              {color.toString("hex")}
            </span>
          </span>
          <ChevronDown className="size-4 text-muted" />
        </ColorPicker.Trigger>
        <ColorPicker.Popover>
          <div className="flex flex-col gap-2" {...escRevert}>
            <ColorArea
              aria-label="Saturation and brightness"
              className="max-w-full"
              colorSpace="hsb"
              xChannel="saturation"
              yChannel="brightness"
            >
              <ColorArea.Thumb />
            </ColorArea>
            <ColorSlider aria-label="Hue" channel="hue" colorSpace="hsb">
              <ColorSlider.Track>
                <ColorSlider.Thumb />
              </ColorSlider.Track>
            </ColorSlider>
          </div>
          <ColorField aria-label="Hex color">
            <ColorField.Group>
              <ColorField.Prefix>
                <ColorSwatch size="xs" />
              </ColorField.Prefix>
              <ColorField.Input className="font-mono uppercase" />
            </ColorField.Group>
          </ColorField>
        </ColorPicker.Popover>
      </ColorPicker>
    </div>
  );
}

// ─── Visual gradient-stop editor ───────────────────────────────────────────
//
// Stops are evenly spaced along the bar (the C++/TS samplers interpolate at
// `t * (n - 1)`, so a stop's position is just its index -- drag reorders the
// sequence rather than storing absolute positions). Editing writes back the
// same "#RRGGBB,#RRGGBB,..." string the backend persists, so nothing
// downstream knows the editor exists.

const MAX_GRADIENT_STOPS = 8;

export function GradientStopEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (colors: string) => void;
}) {
  const stops = useMemo(
    () => parseGradientStops(value, builtinPalette("vulcanFire")),
    [value],
  );
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const commit = (next: GradientStop[]) =>
    onChange(next.map((s) => rgbToHex(s.r, s.g, s.b)).join(","));

  const recolor = (i: number, color: Color) => {
    const [r, g, b] = toRgbTriple(color);
    commit(stops.map((s, idx) => (idx === i ? { r, g, b } : s)));
  };

  const removeStop = (i: number) => {
    // The parsers require at least 2 stops (a single colour isn't a
    // gradient), so the last removable stop is #2.
    if (stops.length <= 2) return;
    commit(stops.filter((_, idx) => idx !== i));
  };

  const blend = (a: GradientStop, b: GradientStop): GradientStop => ({
    r: Math.round((a.r + b.r) / 2),
    g: Math.round((a.g + b.g) / 2),
    b: Math.round((a.b + b.b) / 2),
  });

  // Appends a midpoint colour between the last two stops so adding doesn't
  // shift the perceived shape of the ramp -- the new stop is blended from
  // its neighbours instead of being an arbitrary new colour.
  const addStop = () => {
    if (stops.length < 2) return;
    commit([...stops, blend(stops[stops.length - 2], stops[stops.length - 1])]);
  };

  // Inserts a stop blended from the pair at (i, i+1) right between them --
  // addStop only ever appends at the end, which makes refining the middle of
  // a ramp (the part that usually matters most) a drag-to-reorder chore.
  const insertStopBetween = (i: number) => {
    if (stops.length >= MAX_GRADIENT_STOPS) return;
    const next = [...stops];
    next.splice(i + 1, 0, blend(stops[i], stops[i + 1]));
    commit(next);
  };

  const handleDrop = (target: number) => {
    if (dragIndex !== null && dragIndex !== target) {
      const next = [...stops];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(target, 0, moved);
      commit(next);
    }
    setDragIndex(null);
    setOverIndex(null);
  };

  const gradientCss = stops
    .map(
      (s, i) =>
        `${rgbToHex(s.r, s.g, s.b)} ${(i / (stops.length - 1)) * 100}%`,
    )
    .join(", ");

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {/* Preview bar */}
      <div className="relative">
        <div
          className="h-5 w-full rounded-lg border border-default"
          style={{ background: `linear-gradient(to right, ${gradientCss})` }}
          aria-hidden
        />
        <Tooltip>
          <Button
            isIconOnly
            size="sm"
            variant="tertiary"
            aria-label="Reverse gradient direction"
            className="absolute -right-1 -top-1 size-4 min-w-4 rounded-full"
            onPress={() => commit([...stops].reverse())}
          >
            <FlipHorizontal2 size={9} />
          </Button>
          <Tooltip.Content>Reverse gradient direction</Tooltip.Content>
        </Tooltip>
      </div>

      {/* Stops */}
      <div className="flex flex-wrap items-center gap-1">
        {stops.flatMap((s, i) => {
          const hex = rgbToHex(s.r, s.g, s.b);
          const nodes: React.ReactNode[] = [];
          if (i > 0) {
            nodes.push(
              <Button
                key={`ins-${i}`}
                isIconOnly
                size="sm"
                variant="ghost"
                isDisabled={stops.length >= MAX_GRADIENT_STOPS}
                aria-label={`Insert a stop between ${i} and ${i + 1}`}
                className="h-7 w-3 min-w-3 px-0 text-muted"
                onPress={() => insertStopBetween(i - 1)}
              >
                <Plus size={9} />
              </Button>,
            );
          }
          nodes.push(
            <div
              key={i}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => {
                e.preventDefault();
                setOverIndex(i);
              }}
              onDrop={() => handleDrop(i)}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              title="Drag to reorder"
              className={`relative flex cursor-grab items-center rounded-md active:cursor-grabbing ${
                overIndex === i ? "ring-1 ring-accent" : ""
              }`}
            >
              <ColorPicker
                value={hex}
                onChange={(next) => recolor(i, next)}
              >
                <ColorPicker.Trigger
                  aria-label={`Stop ${i + 1} color`}
                  className="h-7 w-12 rounded-md border border-default"
                  style={{ background: hex }}
                >
                  <span
                    className="text-[8px] font-medium"
                    style={{ textShadow: "0 1px 2px rgba(0,0,0,0.8)" }}
                  >
                    {i + 1}
                  </span>
                </ColorPicker.Trigger>
                <ColorPicker.Popover>
                  <ColorArea
                    aria-label={`Stop ${i + 1} saturation and brightness`}
                    className="max-w-full"
                    colorSpace="hsb"
                    xChannel="saturation"
                    yChannel="brightness"
                  >
                    <ColorArea.Thumb />
                  </ColorArea>
                  <ColorSlider
                    aria-label={`Stop ${i + 1} hue`}
                    channel="hue"
                    className="px-1"
                    colorSpace="hsb"
                  >
                    <ColorSlider.Track>
                      <ColorSlider.Thumb />
                    </ColorSlider.Track>
                  </ColorSlider>
                  <ColorField aria-label={`Stop ${i + 1} hex`}>
                    <ColorField.Group>
                      <ColorField.Input className="font-mono uppercase" />
                    </ColorField.Group>
                  </ColorField>
                </ColorPicker.Popover>
              </ColorPicker>
              <Tooltip>
                <Button
                  isIconOnly
                  size="sm"
                  variant="tertiary"
                  isDisabled={stops.length <= 2}
                  aria-label={`Remove stop ${i + 1}`}
                  className="absolute -right-1 -top-1 size-3.5 min-w-3.5 rounded-full"
                  onPress={() => removeStop(i)}
                >
                  <X size={8} />
                </Button>
                <Tooltip.Content>
                  {stops.length <= 2
                    ? "A gradient needs at least 2 stops"
                    : "Remove stop"}
                </Tooltip.Content>
              </Tooltip>
            </div>,
          );
          return nodes;
        })}

        <Tooltip>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={stops.length >= MAX_GRADIENT_STOPS}
            className="h-7 border border-dashed border-default text-[9px]"
            onPress={addStop}
          >
            <Plus size={10} />
            Add
          </Button>
          <Tooltip.Content>
            {stops.length >= MAX_GRADIENT_STOPS
              ? `Max ${MAX_GRADIENT_STOPS} stops`
              : "Add a stop (blended from the last two)"}
          </Tooltip.Content>
        </Tooltip>
      </div>

      <Description className="text-[9px]">
        Stops are spread evenly. Drag to reorder, click a swatch to recolor, the
        + between stops to insert, × to remove.
      </Description>
    </div>
  );
}

// ─── Effect / gradient pickers ─────────────────────────────────────────────

export function EffectTypeGrid({
  label = "Effect",
  value,
  onChange,
  types,
  hasAddressableFixture = true,
  isDense = false,
}: {
  label?: string;
  value: EffectType;
  onChange: (t: EffectType) => void;
  types: EffectType[];
  /** Stack the icon over the label and shrink the type. Only for the 288px
   *  sidebar -- at full width the buttons are left at their stock size. */
  isDense?: boolean;
  /**
   * Whether the assigned fixtures include an addressable one -- gates which
   * effect *options* are even offered (see effectRequiresAddressable): no
   * point showing an effect that renders as a flat, unmodulated colour on
   * the fixtures actually assigned.
   */
  hasAddressableFixture?: boolean;
}) {
  const visible = types.filter(
    // Keep the active one even when it no longer qualifies, so switching
    // fixture assignment never strands the cue on a selection that silently
    // vanishes from the grid.
    (t) => hasAddressableFixture || t === value || !effectRequiresAddressable(t),
  );
  return (
    <Field label={label} description={EFFECT_META[value]?.desc}>
      <ToggleButtonGroup
        isDetached
        aria-label={label}
        className={`grid gap-1 ${TOGGLE_GROUP_CLS} ${
          isDense ? "grid-cols-4" : "grid-cols-5"
        }`}
        disallowEmptySelection
        selectionMode="single"
        selectedKeys={[value]}
        size="sm"
        onSelectionChange={(keys) => {
          const next = [...keys][0] as EffectType | undefined;
          if (next) onChange(next);
        }}
      >
        {visible.map((t) => (
          <Tooltip key={t}>
            <ToggleButton id={t} className={isDense ? TILE_TOGGLE_CLS : ""}>
              {EFFECT_META[t].icon}
              <span>{EFFECT_META[t].label}</span>
            </ToggleButton>
            <Tooltip.Content>{EFFECT_META[t].desc}</Tooltip.Content>
          </Tooltip>
        ))}
      </ToggleButtonGroup>
    </Field>
  );
}

export function GradientPresetGroup({
  label = "Gradient",
  value,
  onChange,
  onColorsChange,
  colors,
  isDense = false,
}: {
  label?: string;
  value: GradientPreset;
  onChange: (g: GradientPreset) => void;
  onColorsChange: (colors: string) => void;
  colors: string;
  /** See EffectTypeGrid: wraps and shrinks the labels for the sidebar. */
  isDense?: boolean;
}) {
  return (
    <Field label={label}>
      <ToggleButtonGroup
        isDetached
        aria-label={label}
        className={`grid grid-cols-2 gap-1.5 ${TOGGLE_GROUP_CLS}`}
        disallowEmptySelection
        selectionMode="single"
        selectedKeys={[value]}
        size="sm"
        onSelectionChange={(keys) => {
          const next = [...keys][0] as GradientPreset | undefined;
          if (next) onChange(next);
        }}
      >
        {(Object.keys(GRADIENT_META) as GradientPreset[]).map((g) => (
          <ToggleButton key={g} id={g} className={isDense ? CELL_TOGGLE_CLS : ""}>
            {GRADIENT_META[g]}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {value === "custom" && (
        <GradientStopEditor value={colors} onChange={onColorsChange} />
      )}
    </Field>
  );
}
