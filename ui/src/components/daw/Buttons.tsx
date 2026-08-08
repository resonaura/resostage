import { Button, type ButtonProps } from "@heroui/react";

/**
 * Convenience wrappers around HeroUI Button for common DAW use cases.
 *
 * These exist to standardize patterns that appear repeatedly in timeline/mixer
 * chrome, not to replace HeroUI. For one-off buttons or when you need props
 * these don't expose, use <Button> directly.
 */

/**
 * HeroUI Button with a soft (tinted) fill — the default for most DAW chrome.
 *
 * This is just `<Button variant="secondary">` with a shorter name and defaults
 * (size="sm", no icon-only inference) that fit dense control surfaces.
 */
export function SoftButton({
  size = "sm",
  variant = "secondary",
  ...rest
}: ButtonProps) {
  return <Button size={size} variant={variant} {...rest} />;
}

/**
 * Binary on/off toggle: toolbar tools, snap, follow, solo/mute switches.
 *
 * Off is ghost (no fill), on is primary (solid accent). The two ends of the
 * scale, because a toggle whose states sit next to each other is a toggle you
 * misread on stage.
 */
export function ToggleButton({
  active,
  size = "sm",
  onClick,
  ariaLabel,
  disabled = false,
  className = "",
  children,
}: {
  active: boolean;
  size?: ButtonProps["size"];
  onClick: () => void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      size={size}
      variant={active ? "primary" : "ghost"}
      onPress={onClick}
      isDisabled={disabled}
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </Button>
  );
}

/**
 * Square icon button for transport and lane chrome.
 *
 * `danger` is semantic, not cosmetic: it's for Stop, the one transport action
 * that discards where you were.
 */
export function IconButton({
  onClick,
  ariaLabel,
  danger = false,
  size = "sm",
  disabled = false,
  className = "",
  children,
}: {
  onClick: () => void;
  ariaLabel?: string;
  danger?: boolean;
  size?: ButtonProps["size"];
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      size={size}
      variant={danger ? "danger" : "ghost"}
      isIconOnly
      onPress={onClick}
      isDisabled={disabled}
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </Button>
  );
}
