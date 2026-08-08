import { useEffect, useRef } from "react";

import { beginCancellableDrag, type CancellableDrag } from "./dragCancel";

type PointerHandlers = {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onLostPointerCapture: () => void;
};

/**
 * Esc-revert for controls that do NOT own their drag state -- native
 * `<input type="range">` and HeroUI's `Slider`, which report every intermediate
 * value through onChange and keep no "where did this drag start" of their own.
 *
 * Spread the returned handlers onto whatever element the drag begins on
 * (a wrapper is fine; pointer events bubble up from the thumb):
 *
 *   <div {...useEscRevert(() => value, onChange)}>
 *
 * `getValue` is read at pointerdown, so it must return the value the control
 * shows at that instant. It is generic because some controls are driven as a
 * unit rather than a single number -- the HSL picker's three sliders all edit
 * one colour, and reverting any of them means restoring the whole triple.
 *
 * `revert` receives that value back and must publish it the same way a
 * user-driven change would -- these controls have already pushed the dragged
 * value to the engine by the time Esc arrives.
 *
 * Controls that own a full drag lifecycle (Knob, SendArcKnob, region and marker
 * drags) call beginCancellableDrag directly instead; they need to unwind rAF
 * commits and pointer capture too, which this hook deliberately knows nothing
 * about.
 */
export function useEscRevert<T>(
  getValue: () => T,
  revert: (original: T) => void,
): PointerHandlers {
  const handleRef = useRef<CancellableDrag | null>(null);
  const getValueRef = useRef(getValue);
  getValueRef.current = getValue;
  const revertRef = useRef(revert);
  revertRef.current = revert;

  const disarm = () => {
    handleRef.current?.end();
    handleRef.current = null;
  };

  // A control unmounted mid-drag must not leave a listener behind that reverts
  // it on some later, unrelated Esc.
  useEffect(() => disarm, []);

  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return; // right/middle click is not a drag
      const original = getValueRef.current();
      disarm();
      handleRef.current = beginCancellableDrag(() => {
        handleRef.current = null;
        revertRef.current(original);
      });
    },
    onPointerUp: disarm,
    onPointerCancel: disarm,
    onLostPointerCapture: disarm,
  };
}
