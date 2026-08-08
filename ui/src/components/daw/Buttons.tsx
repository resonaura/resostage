import { Button, type ButtonProps } from "@heroui/react";

import { tintClass, tintVars, type TintEmphasis } from "./tint";

/**
 * The button set.
 *
 * Two surfaces, one vocabulary:
 *
 *   HeroUI <Button>  — real buttons: dialogs, toolbars, forms. Keep using it
 *                      directly; reach for <SoftButton> when you want its
 *                      sizing with a tinted fill.
 *   <DawButton>      — dense chrome: the 24-28px controls in the timeline and
 *                      mixer, below where HeroUI's scale goes.
 *
 * Both consume the same --button-* custom properties, so the emphasis scale
 * (`.tint--*`, see styles/theme.css) is literally the same code for both. That
 * is the whole point of the split: two sizes of button, not two design
 * systems.
 *
 * Colour comes from `tint`. Omit it and you get the accent; pass a track, bus
 * or fixture colour and the same five levels re-derive in that colour, which
 * is how a control belongs to a coloured lane without a second set of
 * hand-written classes.
 */

const SIZE_CLS = {
  xs: "h-6 text-[10px] gap-1 px-1.5",
  sm: "h-7 text-xs gap-1 px-2",
  md: "h-8 text-xs gap-1.5 px-2.5",
} as const;

const ICON_ONLY_CLS = {
  xs: "h-6 w-6 px-0",
  sm: "h-7 w-7 px-0",
  md: "h-8 w-8 px-0",
} as const;

export type DawButtonSize = keyof typeof SIZE_CLS;

/**
 * Dense button for control-surface chrome.
 *
 * A plain <button> rather than HeroUI's: these run at sizes HeroUI's scale
 * does not reach, and every attempt to get there by overriding its height
 * fought the variant's own padding and icon sizing. The emphasis, focus ring
 * and disabled handling still come from the shared CSS, so nothing about the
 * look is re-invented here.
 */
export function DawButton({
  emphasis = "quiet",
  tint,
  size = "sm",
  iconOnly = false,
  disabled = false,
  title,
  ariaLabel,
  ariaPressed,
  onClick,
  className = "",
  children,
}: {
  /** Where this sits in the fixed hierarchy. See TintEmphasis. */
  emphasis?: TintEmphasis;
  /** Any authored colour. Omitted → the neutral accent. */
  tint?: string | null;
  size?: DawButtonSize;
  iconOnly?: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  onClick?: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      style={tintVars(tint)}
      className={`daw-button ${tintClass(emphasis)} flex shrink-0 items-center justify-center rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${
        iconOnly ? ICON_ONLY_CLS[size] : SIZE_CLS[size]
      } ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Binary on/off: toolbar tools, snap, follow, mute/solo-style switches.
 *
 * Off is `quiet` (no fill until you touch it) and on is `solid` — the two ends
 * of the scale, because a toggle whose states sit next to each other is a
 * toggle you misread on stage. Anything in between is a job for DawButton with
 * an explicit emphasis.
 */
export function ToggleButton({
  active,
  tint,
  size = "sm",
  iconOnly = false,
  onClick,
  title,
  ariaLabel,
  disabled = false,
  className = "",
  children,
}: {
  active: boolean;
  tint?: string | null;
  size?: DawButtonSize;
  iconOnly?: boolean;
  onClick: () => void;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <DawButton
      emphasis={active ? "solid" : "quiet"}
      tint={tint}
      size={size}
      iconOnly={iconOnly}
      onClick={onClick}
      title={title}
      ariaLabel={ariaLabel}
      ariaPressed={active}
      disabled={disabled}
      className={className}
    >
      {children}
    </DawButton>
  );
}

/**
 * Square icon button for transport and lane chrome.
 *
 * `danger` is the one escape from the tint scale, and it is semantic: Stop is
 * the transport action that discards where you were, so it is the only button
 * in this set allowed a hue of its own.
 */
export function IconButton({
  onClick,
  title,
  ariaLabel,
  tone = "neutral",
  tint,
  size = "sm",
  disabled = false,
  className = "",
  children,
}: {
  onClick: () => void;
  title?: string;
  ariaLabel?: string;
  tone?: "neutral" | "danger";
  tint?: string | null;
  size?: DawButtonSize;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  if (tone === "danger") {
    return (
      <DawButton
        emphasis="quiet"
        tint="var(--danger)"
        size={size}
        iconOnly
        onClick={onClick}
        title={title}
        ariaLabel={ariaLabel}
        disabled={disabled}
        className={className}
      >
        {children}
      </DawButton>
    );
  }
  return (
    <DawButton
      emphasis="quiet"
      tint={tint}
      size={size}
      iconOnly
      onClick={onClick}
      title={title}
      ariaLabel={ariaLabel}
      disabled={disabled}
      className={className}
    >
      {children}
    </DawButton>
  );
}

/**
 * HeroUI Button with a tinted fill — its sizing and states, our emphasis.
 *
 * A wrapper rather than `<Button variant="...">` because HeroUI types
 * `variant` as a closed union that has no tinted-accent member (it ships
 * `danger-soft` and nothing else soft). `variant="ghost"` is the base because
 * ghost contributes no background of its own for the tint to fight with.
 */
export function SoftButton({
  emphasis = "soft",
  tint,
  className = "",
  style,
  ...rest
}: ButtonProps & { emphasis?: TintEmphasis; tint?: string | null }) {
  return (
    <Button
      variant="ghost"
      {...rest}
      style={{ ...tintVars(tint), ...style }}
      className={`${tintClass(emphasis)} ${className}`}
    />
  );
}
