import {
  BUTTON_GROUP_CHILD,
  Button as HeroButton,
  ButtonGroup as HeroButtonGroup,
} from "@heroui/react";
import { createContext, use, useMemo, type ComponentProps } from "react";
import { isTone, withTone, type Tone } from "./tones";

/**
 * Button / ButtonGroup with the full colour palette.
 *
 * HeroUI's Button ships `primary | secondary | tertiary | ghost | outline |
 * danger | danger-soft` -- so a destructive action can be soft but a
 * confirmation cannot. This adds every tone (see ./tones) as a variant, and
 * leaves all seven original variants going through HeroUI untouched, so
 * nothing that renders today changes by a pixel.
 *
 * Everything else about the component is passed straight through: render-prop
 * children and className, `isIconOnly`, `fullWidth`, `size`, sub-slots, refs,
 * and ButtonGroup membership (see the note on BUTTON_GROUP_CHILD below).
 */

type HeroButtonProps = ComponentProps<typeof HeroButton>;
type HeroVariant = NonNullable<HeroButtonProps["variant"]>;

/**
 * Mirror of buttonVariants' `variant` keys in
 * @heroui/styles/dist/components/button/button.styles.js. The assertion under
 * it turns a HeroUI upgrade that adds or renames a variant into a compile
 * error here rather than a variant that silently stops being passed through.
 */
const HERO_VARIANTS = [
  "primary",
  "secondary",
  "tertiary",
  "ghost",
  "outline",
  "danger",
  "danger-soft",
] as const;

type MissingHeroVariants = Exclude<HeroVariant, (typeof HERO_VARIANTS)[number]>;
const _heroVariantsAreCovered: MissingHeroVariants extends never
  ? true
  : [
      "HeroUI gained button variants; add them to HERO_VARIANTS",
      MissingHeroVariants,
    ] = true;
void _heroVariantsAreCovered;

const HERO_VARIANT_SET: ReadonlySet<string> = new Set(HERO_VARIANTS);

export type ButtonVariant = HeroVariant | Tone;

export interface ButtonProps extends Omit<HeroButtonProps, "variant"> {
  /** Any HeroUI variant, or any tone (`success-soft`, `accent-soft`, …). */
  variant?: ButtonVariant;
  /**
   * Colour only, leaving `variant` to decide the shape. `tone="danger-soft"`
   * with `variant="outline"` is a bordered button in soft danger -- something
   * neither prop can express alone. Wins over a tone named in `variant`.
   */
  tone?: Tone;
}

/**
 * What a plain `<Button>` looks like with nothing specified.
 *
 * HeroUI defaults to `primary` -- a fully saturated accent fill. On a stage
 * surface that is a lot of colour for what is usually a secondary action, and
 * it competes with the authored track and fixture colours the operator is
 * actually reading. Soft accent is the house default instead; `variant` still
 * gets you any of the originals, `variant="primary"` included.
 */
const DEFAULT_TONE: Tone = "accent-soft";

/**
 * What a ButtonGroup passes to its children.
 *
 * `hasHeroVariant` matters as much as the tone: a group that named a HeroUI
 * variant (`<ButtonGroup variant="tertiary">`) is stating what its buttons
 * look like, and DEFAULT_TONE must not quietly outrank it -- HeroUI resolves
 * that variant from its own context, which this wrapper would shadow by
 * passing a variant of its own.
 *
 * HeroUI honours its group defaults for DIRECT children only -- ButtonGroup
 * clones each child with BUTTON_GROUP_CHILD to mark it -- and that distinction
 * is worth preserving: a button nested inside some wrapper element in a group
 * is deliberately not styled by the group, so neither is it toned by it.
 */
interface ButtonGroupToneValue {
  tone: Tone | undefined;
  hasHeroVariant: boolean;
}

const ButtonGroupToneContext = createContext<ButtonGroupToneValue>({
  tone: undefined,
  hasHeroVariant: false,
});

/** Split a `variant` into what HeroUI understands and what we add. */
function splitVariant(variant: ButtonVariant | undefined): {
  heroVariant: HeroVariant | undefined;
  tone: Tone | undefined;
} {
  if (variant === undefined) return { heroVariant: undefined, tone: undefined };
  // Native variants keep taking HeroUI's own path. `danger` and `danger-soft`
  // are in both lists and resolve to identical tokens either way; going
  // through HeroUI means today's buttons are untouched by this wrapper.
  if (HERO_VARIANT_SET.has(variant))
    return { heroVariant: variant as HeroVariant, tone: undefined };
  if (isTone(variant)) return { heroVariant: undefined, tone: variant };
  return { heroVariant: undefined, tone: undefined };
}

export function Button({ variant, tone, className, ...rest }: ButtonProps) {
  const group = use(ButtonGroupToneContext);
  const isGroupChild =
    (rest as Record<string, unknown>)[BUTTON_GROUP_CHILD] === true;

  const split = splitVariant(variant);
  // Precedence, widest to narrowest -- the same order HeroUI uses for its own
  // group props, with the house default last so anything stated anywhere wins
  // over it.
  const fromGroup = isGroupChild ? group : undefined;
  const inheritsGroupVariant = fromGroup?.hasHeroVariant === true;
  const activeTone =
    tone ??
    split.tone ??
    (variant === undefined ? fromGroup?.tone : undefined) ??
    (variant === undefined && !inheritsGroupVariant ? DEFAULT_TONE : undefined);

  return (
    <HeroButton
      // A toned button still needs a base variant for its structural styles.
      // `tertiary` is the neutral one -- it sets background tokens and nothing
      // else, all four of which the tone class then overrides. Anything the
      // caller named explicitly (notably `outline`, which adds a border) is
      // kept, so tone and shape compose.
      variant={split.heroVariant ?? (activeTone ? "tertiary" : undefined)}
      className={withTone(className, activeTone)}
      {...rest}
    />
  );
}

type HeroButtonGroupProps = ComponentProps<typeof HeroButtonGroup>;

export interface ButtonGroupProps extends Omit<
  HeroButtonGroupProps,
  "variant"
> {
  variant?: ButtonVariant;
  tone?: Tone;
}

function ButtonGroupRoot({
  variant,
  tone,
  children,
  ...rest
}: ButtonGroupProps) {
  const split = splitVariant(variant);
  const activeTone = tone ?? split.tone;
  const value = useMemo(
    () => ({ tone: activeTone, hasHeroVariant: split.heroVariant !== undefined }),
    [activeTone, split.heroVariant],
  );
  return (
    <ButtonGroupToneContext value={value}>
      <HeroButtonGroup
        variant={split.heroVariant ?? (activeTone ? "tertiary" : undefined)}
        {...rest}
      >
        {children}
      </HeroButtonGroup>
    </ButtonGroupToneContext>
  );
}

// Compound component, same shape HeroUI itself exports (Slider.Track,
// Switch.Thumb, …). The lint rule can't see through Object.assign.
// eslint-disable-next-line react/only-export-components
export const ButtonGroup = Object.assign(ButtonGroupRoot, {
  Separator: HeroButtonGroup.Separator,
});
