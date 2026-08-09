import { Slider as HeroSlider } from "@heroui/react";
import type { ComponentProps } from "react";
import { withTone, type Tone } from "./tones";

/**
 * Slider with a colour tone.
 *
 * Supports every tone (`accent-soft`, `success-soft`, `danger`, etc.).
 * Soft variants paint a translucent fill track with a clearly picked-out grip.
 */

const DEFAULT_TONE: Tone = "accent-soft";

type HeroSliderProps = ComponentProps<typeof HeroSlider>;

export interface SliderProps extends HeroSliderProps {
  /** Defaults to `accent-soft`; see DEFAULT_TONE. */
  tone?: Tone;
}

function SliderRoot({ tone = DEFAULT_TONE, className, ...rest }: SliderProps) {
  return <HeroSlider className={withTone(className, tone)} {...rest} />;
}

export const Slider = Object.assign(SliderRoot, {
  Root: SliderRoot,
  Output: HeroSlider.Output,
  Track: HeroSlider.Track,
  Fill: HeroSlider.Fill,
  Thumb: HeroSlider.Thumb,
  Marks: HeroSlider.Marks,
});
