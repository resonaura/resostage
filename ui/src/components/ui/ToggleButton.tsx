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

export interface ToggleButtonProps extends Omit<
  HeroToggleButtonProps,
  "variant"
> {
  /** `default` / `ghost` for the unselected look, or a tone for the selected one. */
  variant?: ToggleButtonVariant;
  /** The selected colour, independent of `variant`. Wins over a tone in `variant`. */
  tone?: Tone;
  /** Injected by HeroUI's ButtonGroup on every child; not for callers. */
  [BUTTON_GROUP_CHILD]?: boolean;
}

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
  const activeTone = tone ?? split.tone ?? groupTone;

  return (
    <HeroToggleButton
      // Only forwarded when the caller actually named an unselected look; a
      // bare tone leaves HeroUI on its own `default` so the off state is
      // unchanged.
      variant={split.heroVariant}
      className={withTone(className, activeTone)}
      {...rest}
    />
  );
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
