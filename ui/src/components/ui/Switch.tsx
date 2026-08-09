import { Switch as HeroSwitch } from "@heroui/react";
import type { ComponentProps } from "react";
import { withTone, type Tone } from "./tones";

/**
 * Switch with a colour.
 *
 * Like Slider, HeroUI's Switch offers only a size -- the checked track is
 * always the accent. A soft-success "enabled" toggle or a danger-toned
 * destructive one had to be hand-styled.
 *
 * Only the CHECKED side is toned. An unchecked switch stays neutral on
 * purpose: colour is how a switch says "on", and colouring the off state
 * makes it read as on at a glance. As with the slider, a soft tone gives a
 * translucent track with a full-strength thumb, so the control's state stays
 * legible from a distance.
 *
 * Compound parts (`Switch.Content`, `.Control`, `.Thumb`, `.Icon`) are
 * HeroUI's own, re-exported unchanged.
 */

type HeroSwitchProps = ComponentProps<typeof HeroSwitch>;

export interface SwitchProps extends HeroSwitchProps {
  tone?: Tone;
}

// Exported below as a compound component, the same shape HeroUI itself
// exports. The lint rule can't see a component through Object.assign.
// eslint-disable-next-line react/only-export-components
function SwitchRoot({ tone, className, ...rest }: SwitchProps) {
  return <HeroSwitch className={withTone(className, tone)} {...rest} />;
}

export const Switch = Object.assign(SwitchRoot, {
  Root: SwitchRoot,
  Content: HeroSwitch.Content,
  Control: HeroSwitch.Control,
  Thumb: HeroSwitch.Thumb,
  Icon: HeroSwitch.Icon,
});
