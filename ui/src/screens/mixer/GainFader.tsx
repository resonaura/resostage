import { Slider } from "@heroui/react";
import { useLiveValue } from "../../lib/optimistic";
import { useEscRevert } from "../../lib/useEscRevert";
import { GAIN_MAX, GAIN_MIN } from "./constants";

/** Double-click resets to unity; Esc mid-drag puts the fader back. */
export function GainFader({
  gainDb,
  onChange,
  defaultValue = 0,
}: {
  gainDb: number;
  accent?: string;
  onChange: (v: number) => void;
  defaultValue?: number;
}) {
  const [value, handleChange] = useLiveValue(gainDb, onChange);
  // HeroUI's Slider has no drag lifecycle of its own -- it only reports values
  // -- so the revert is armed on the wrapper, where the pointerdown bubbles to.
  const escRevert = useEscRevert(() => value, handleChange);
  return (
    <div
      className="h-full"
      title="Double-click to reset"
      {...escRevert}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        handleChange(defaultValue);
      }}
    >
      <Slider
        value={value}
        onChange={(v) => handleChange(Array.isArray(v) ? v[0] : v)}
        minValue={GAIN_MIN}
        maxValue={GAIN_MAX}
        step={0.1}
        orientation="vertical"
        aria-label="Gain"
        className="h-full"
      >
        <Slider.Track
          className="relative h-full w-2.5 rounded-full bg-background/50"
          style={{ borderBottomColor: "var(--surface)" }}
        >
          <Slider.Fill style={{ backgroundColor: "var(--surface)" }} />
          <Slider.Thumb
            style={
              {
                backgroundColor: "var(--surface)",
              } as React.CSSProperties
            }
          />
        </Slider.Track>
      </Slider>
    </div>
  );
}
