import {
  BUTTON_GROUP_CHILD,
  ToggleButton as HeroToggleButton,
  ToggleButtonGroup as HeroToggleButtonGroup,
} from "@heroui/react";
import { toggleButtonGroupVariants } from "@heroui/styles";
import { createContext, use, type ComponentProps } from "react";
import { isTone, withTone, type Tone } from "./tones";

/**
 * ToggleButton / ToggleButtonGroup with a choosable selected colour.
 *
 * HeroUI's toggle is hard-wired to `accent-soft` when selected -- its
 * `variant` prop (`default | ghost`) only describes the UNSELECTED look. So
 * "on = success" or "on = danger" had no expression at all, which is the
 * mirror image of Button's problem: there the soft accent is missing, here it
 * is the only thing on offer.
 *
 * A tone here therefore recolours the SELECTED state and leaves `variant`
 * doing its original job. Both stay available and compose:
 *
 *   <ToggleButton variant="danger-soft">        on = soft danger
 *   <ToggleButton variant="ghost" tone="success-soft">
 *                                               off = transparent,
 *                                               on  = soft success
 *
 * With no tone given the component is byte-identical to HeroUI's.
 */

type HeroToggleButtonProps = ComponentProps<typeof HeroToggleButton>;
type HeroVariant = NonNullable<HeroToggleButtonProps["variant"]>;

/**
 * Mirror of toggleButtonVariants' `variant` keys in @heroui/styles. The
 * assertion below fails to compile if a HeroUI upgrade adds one.
 */
const HERO_VARIANTS = ["default", "ghost"] as const;

type MissingHeroVariants = Exclude<HeroVariant, (typeof HERO_VARIANTS)[number]>;
const _heroVariantsAreCovered: MissingHeroVariants extends never
  ? true
  : [
      "HeroUI gained toggle variants; add them to HERO_VARIANTS",
      MissingHeroVariants,
    ] = true;
void _heroVariantsAreCovered;

const HERO_VARIANT_SET: ReadonlySet<string> = new Set(HERO_VARIANTS);

export type ToggleButtonVariant = HeroVariant | Tone;

/**
 * HeroUI's smallest toggle is 32px tall. DAW chrome is smaller than any of its
 * three sizes -- a mixer strip's M/S pair is 20px and the timeline's shrinks to
 * 16px with the lane -- which is why those were hand-rolled `<button>`s with
 * their own colours instead of going through here at all.
 *
 * `xs` is that missing step: HeroUI's `sm` underneath for structure, with the
 * density overridden in styles/tones.css. Height and width stay overridable
 * per call site (the timeline scales them with vertical zoom), since an inline
 * style outranks the class.
 */
export type ToggleButtonSize = NonNullable<HeroToggleButtonProps["size"]> | "xs";

const XS_CLASS = "rs-toggle--xs";

export interface ToggleButtonProps extends Omit<
  HeroToggleButtonProps,
  "size" | "variant"
> {
  /** HeroUI's three sizes plus `xs` for DAW chrome; see ToggleButtonSize. */
  size?: ToggleButtonSize;
  /** `default` / `ghost` for the unselected look, or a tone for the selected one. */
  variant?: ToggleButtonVariant;
  /** The selected colour, independent of `variant`. Wins over a tone in `variant`. */
  tone?: Tone;
  /** Injected by HeroUI's ButtonGroup on every child; not for callers. */
  [BUTTON_GROUP_CHILD]?: boolean;
}

/**
 * What a toggle looks like when it is ON and nobody said otherwise.
 *
 * Soft accent, matching HeroUI's own hard-wired selected state -- "on" reads
 * as on across the whole app without every call site restating it. Name a tone
 * whenever the state carries meaning of its own: the console's mute is
 * `danger-soft` and its solo `warning-soft`, and both say so explicitly.
 *
 * Stated here as OUR default rather than left to HeroUI so it is one edit to
 * change, and so a toned toggle and an untoned one take the same code path.
 */
const DEFAULT_TONE: Tone = "accent-soft";

/**
 * Group-level tone. HeroUI's own ToggleButtonGroup already shares `size` with
 * its descendants through plain context (it does not tag direct children the
 * way ButtonGroup does), so this follows the same reach deliberately.
 */
const ToggleGroupToneContext = createContext<Tone | undefined>(undefined);

function splitVariant(variant: ToggleButtonVariant | undefined): {
  heroVariant: HeroVariant | undefined;
  tone: Tone | undefined;
} {
  if (variant === undefined) return { heroVariant: undefined, tone: undefined };
  if (HERO_VARIANT_SET.has(variant))
    return { heroVariant: variant as HeroVariant, tone: undefined };
  if (isTone(variant)) return { heroVariant: undefined, tone: variant };
  return { heroVariant: undefined, tone: undefined };
}

export function ToggleButton({
  size,
  variant,
  tone,
  className,
  // ButtonGroup marks EVERY direct child, without checking the type -- so a
  // toggle placed in a plain ButtonGroup would forward an unknown attribute to
  // the DOM. Swallowed here so the two kinds of group mix freely.
  [BUTTON_GROUP_CHILD]: _isButtonGroupChild,
  ...rest
}: ToggleButtonProps) {
  const groupTone = use(ToggleGroupToneContext);
  const split = splitVariant(variant);
  // Widest to narrowest, with the house default last so anything stated
  // anywhere -- on the button, in its variant, or on its group -- wins.
  const activeTone = tone ?? split.tone ?? groupTone ?? DEFAULT_TONE;
  const isXs = size === "xs";

  return (
    <HeroToggleButton
      // `xs` is ours; HeroUI's `sm` is the closest structural base, and the
      // class below takes it the rest of the way down.
      size={isXs ? "sm" : size}
      // Only forwarded when the caller actually named an unselected look; a
      // bare tone leaves HeroUI on its own `default` so the off state is
      // unchanged.
      variant={split.heroVariant}
      className={withTone(
        isXs ? joinClass(XS_CLASS, className) : className,
        activeTone,
      )}
      {...rest}
    />
  );
}

/** `className` may be a render function (React Aria's convention); keep both. */
function joinClass(
  base: string,
  className: ToggleButtonProps["className"],
): ToggleButtonProps["className"] {
  if (typeof className === "function")
    return (renderProps) => `${base} ${className(renderProps)}`;
  return className ? `${base} ${className}` : base;
}

type HeroToggleGroupProps = ComponentProps<typeof HeroToggleButtonGroup>;

export interface ToggleButtonGroupProps extends HeroToggleGroupProps {
  /** Selected colour for every toggle in the group. Overridden per button. */
  tone?: Tone;
}

function ToggleButtonGroupRoot({
  tone,
  children,
  orientation,
  isDetached,
  fullWidth,
  className,
  ...rest
}: ToggleButtonGroupProps) {
  // Work around tailwind-variants global cache bug: call the variant function
  // fresh on EVERY render and immediately extract classes. This prevents the
  // cached instance from being polluted by other components' variant calls.
  const slots = toggleButtonGroupVariants({
    orientation,
    isDetached,
    fullWidth,
  });
  const baseClasses = slots.base();
  const computedClassName = className
    ? `${baseClasses} ${className}`
    : baseClasses;

  return (
    <ToggleGroupToneContext value={tone}>
      <HeroToggleButtonGroup
        orientation={orientation}
        isDetached={isDetached}
        fullWidth={fullWidth}
        className={computedClassName}
        {...rest}
      >
        {children}
      </HeroToggleButtonGroup>
    </ToggleGroupToneContext>
  );
}

// Compound component, same shape HeroUI itself exports (Slider.Track,
// Switch.Thumb, …). The lint rule can't see through Object.assign.
// eslint-disable-next-line react/only-export-components
export const ToggleButtonGroup = Object.assign(ToggleButtonGroupRoot, {
  Separator: HeroToggleButtonGroup.Separator,
});
