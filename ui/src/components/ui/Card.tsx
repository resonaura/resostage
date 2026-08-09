import { Card as HeroCard } from "@heroui/react";
import type { ComponentProps } from "react";

/**
 * Card on the app's own panel colour.
 *
 * HeroUI's default card is `--surface`, which belongs to overlays and floating
 * chrome. Every panel this app draws by hand -- the setlist, the meter bays,
 * the mixer console, the timeline -- is `--background-secondary`, so a HeroUI
 * card dropped next to one read as a lighter patch that did not belong.
 *
 * Only the DEFAULT changes. Naming a variant still gets HeroUI's own surfaces
 * (`default` for the original, plus `secondary` / `tertiary` / `transparent`),
 * and everything else about the card -- radius, padding, shadow, the whole
 * compound API -- is untouched.
 */

type HeroCardProps = ComponentProps<typeof HeroCard>;

export interface CardProps extends HeroCardProps {}

// Exported below as a compound component, the same shape HeroUI itself
// exports. The lint rule can't see a component through Object.assign.
// eslint-disable-next-line react/only-export-components
function CardRoot({ variant, className, ...rest }: CardProps) {
  return (
    <HeroCard
      variant={variant}
      // Only when the caller stated nothing: an explicit variant is a decision
      // and must not be silently repainted. The class carries both class names
      // so it outranks HeroUI's single-class `.card--default` on specificity,
      // not on stylesheet order -- see styles/tones.css for the same reasoning.
      className={[
        variant === undefined ? "rs-card-surface" : undefined,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export const Card = Object.assign(CardRoot, {
  Root: CardRoot,
  Header: HeroCard.Header,
  Title: HeroCard.Title,
  Description: HeroCard.Description,
  Content: HeroCard.Content,
  Footer: HeroCard.Footer,
});
