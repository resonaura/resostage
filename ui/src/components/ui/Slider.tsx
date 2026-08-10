import { Slider as HeroSlider } from "@heroui/react";
import { useRef, type ComponentProps } from "react";
import { triggerHaptic } from "../../lib/haptics";
import { withTone, type Tone } from "./tones";

/**
 * Slider with a colour tone.
 *
 * Supports every tone (`accent-soft`, `success-soft`, `danger`, etc.).
 * Soft variants paint a translucent fill track with a clearly picked-out grip.
 *
 * A slider with few enough steps to feel like discrete positions also ticks
 * the trackpad as it passes each one -- see DETENT_LIMIT. It lives here rather
 * than at the call sites so every stepped slider in the app behaves the same
 * without anyone having to remember.
 */

const DEFAULT_TONE: Tone = "accent-soft";

/**
 * Most steps a slider can have and still tick per step.
 *
 * The point of a detent tick is that each one is a place you could mean to
 * stop at. Transpose (24 semitones) or a shape picker qualifies; a gain fader
 * with 150 hundredths does not -- there the ticks arrive faster than the hand
 * can aim, and a detent you cannot land on deliberately is just a buzz. The
 * limit is where "positions" stops being the honest description.
 */
const DETENT_LIMIT = 96;

type HeroSliderProps = ComponentProps<typeof HeroSlider>;

export interface SliderProps extends HeroSliderProps {
  /** Defaults to `accent-soft`; see DEFAULT_TONE. */
  tone?: Tone;
  /** Force detent ticks on or off, overriding the DETENT_LIMIT heuristic. */
  hapticDetents?: boolean;
}

function SliderRoot({
  tone = DEFAULT_TONE,
  className,
  hapticDetents,
  onChange,
  ...rest
}: SliderProps) {
  const lastValueRef = useRef<string | null>(null);

  const min = rest.minValue ?? 0;
  const max = rest.maxValue ?? 100;
  const step = rest.step ?? 1;
  const detents = step > 0 ? (max - min) / step : Infinity;
  const ticks =
    hapticDetents ?? (detents > 1 && detents <= DETENT_LIMIT);

  const handleChange = (value: number | number[]) => {
    if (ticks) {
      const key = Array.isArray(value) ? value.join(",") : String(value);
      // Never on the first report: that one is the grab, not a crossing, and
      // the drag start has already ticked.
      if (lastValueRef.current !== null && lastValueRef.current !== key) {
        triggerHaptic("alignment");
      }
      lastValueRef.current = key;
    }
    onChange?.(value);
  };

  return (
    <HeroSlider
      className={withTone(className, tone)}
      onChange={handleChange}
      {...rest}
    />
  );
}

export const Slider = Object.assign(SliderRoot, {
  Root: SliderRoot,
  Output: HeroSlider.Output,
  Track: HeroSlider.Track,
  Fill: HeroSlider.Fill,
  Thumb: HeroSlider.Thumb,
  Marks: HeroSlider.Marks,
});
