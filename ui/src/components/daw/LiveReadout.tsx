import { useEffect, useRef, type CSSProperties } from "react";
import { addRafTask } from "../../lib/rafLoop";

/**
 * A number that moves, without a render behind it.
 *
 * The transport clock, the bar/beat counter and the per-strip dB boxes all
 * change on essentially every frame, and every one of them used to be an
 * ordinary piece of JSX -- so the component holding it, and everything else
 * that component drew, was reconciled sixty times a second to move a few
 * digits. On the Player that was the entire screen; on a mixer strip it was
 * two routing selects and a send knob per bus.
 *
 * This owns one text node and nothing else. React never writes inside it, so
 * there is no second writer to fight with, and the sampler runs on the ONE
 * shared frame driver (lib/rafLoop) rather than starting a loop per readout.
 *
 * Two things keep the cost near zero even at sixty samples a second:
 *
 *   - `intervalMs` throttles the sample. Past about a dozen updates a second
 *     digits are a blur, so the extra samples buy nothing a human can read.
 *   - The formatted string is compared before it is written. A clock that is
 *     showing the same hundredth of a second, or a meter sitting at -inf,
 *     touches the DOM not at all.
 *
 * Note on canvas: for TEXT specifically, the saving here is from bypassing
 * React, not from the raster target -- a canvas glyph run costs more than a
 * textContent assignment the browser can handle as a text-only relayout, and
 * it gives up selection, accessibility and font/theme inheritance. Everything
 * that genuinely benefits from canvas -- the meters, the waveforms, the light
 * preview -- is already on it. If a canvas readout is ever wanted anyway, it
 * is this one file that changes.
 */
export function LiveReadout({
  sample,
  intervalMs = 1000 / 12,
  className,
  style,
  title,
}: {
  /** Called on the shared rAF; return exactly the string to show. */
  sample: () => string;
  /** Lower bound between samples. Default ~12/s, which reads as continuous. */
  intervalMs?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const sampleRef = useRef(sample);
  sampleRef.current = sample;
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;

  useEffect(() => {
    let nextAtMs = 0;
    let painted: string | null = null;
    // Paint once immediately so the readout is never blank for a frame.
    const paint = () => {
      const text = sampleRef.current();
      if (text === painted) return;
      painted = text;
      const el = ref.current;
      if (el) el.textContent = text;
    };
    paint();
    return addRafTask((nowMs) => {
      if (nowMs < nextAtMs) return;
      nextAtMs = nowMs + intervalRef.current;
      paint();
    });
  }, []);

  return <span ref={ref} className={className} style={style} title={title} />;
}
