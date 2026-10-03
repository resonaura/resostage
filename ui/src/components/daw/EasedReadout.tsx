/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useRef, type CSSProperties } from "react";
import { addRafTask } from "@/lib/state/rafLoop";
import {
  CONTROL_DISPLAY_DURATION_MS,
  easeControlValue,
  prefersReducedMotion,
} from "@/components/daw/logic/controlMotion";

/**
 * Smooths telemetry-driven numeric text without rerendering its owner. Direct
 * gestures and reduced-motion preferences always display the exact target.
 */
export function EasedReadout({
  value,
  format,
  interacting = false,
  className,
  style,
  title,
  durationMs = CONTROL_DISPLAY_DURATION_MS,
  motionKey,
}: {
  value: number;
  format: (value: number) => string;
  interacting?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
  durationMs?: number;
  /** Identity fence; a new song/project/Core session paints immediately. */
  motionKey?: string | number;
}) {
  const initialText = useRef(format(value));
  const elementRef = useRef<HTMLSpanElement>(null);
  const valueRef = useRef(value);
  const currentValueRef = useRef(value);
  const lastTargetRef = useRef(value);
  const formatRef = useRef(format);
  const interactingRef = useRef(interacting);
  const durationRef = useRef(durationMs);
  const motionKeyRef = useRef(motionKey);
  const lastMotionKeyRef = useRef(motionKey);
  valueRef.current = value;
  formatRef.current = format;
  interactingRef.current = interacting;
  durationRef.current = durationMs;
  motionKeyRef.current = motionKey;

  const paintRef = useRef<(next: number) => void>(() => {});
  const paintedRef = useRef(initialText.current);
  paintRef.current = (next) => {
    const text = formatRef.current(next);
    if (text === paintedRef.current) return;
    paintedRef.current = text;
    if (elementRef.current) elementRef.current.textContent = text;
  };

  useEffect(() => {
    const target = valueRef.current;
    const keyChanged = lastMotionKeyRef.current !== motionKeyRef.current;
    lastMotionKeyRef.current = motionKeyRef.current;

    if (keyChanged || interactingRef.current || prefersReducedMotion()) {
      currentValueRef.current = target;
      lastTargetRef.current = target;
      paintRef.current(target);
      return;
    }
    if (target === lastTargetRef.current) return;

    const start = currentValueRef.current;
    const from = Number.isFinite(start) ? start : target;
    const to = Number.isFinite(target) ? target : from;
    lastTargetRef.current = target;
    let startedAt: number | null = null;
    let stop: (() => void) | null = null;

    stop = addRafTask((nowMs) => {
      startedAt ??= nowMs;
      const duration = Number.isFinite(durationRef.current)
        ? Math.max(1, durationRef.current)
        : CONTROL_DISPLAY_DURATION_MS;
      const progress = (nowMs - startedAt) / duration;
      const current = easeControlValue(from, to, progress);
      currentValueRef.current = current;
      paintRef.current(current);
      if (progress >= 1) {
        currentValueRef.current = to;
        paintRef.current(to);
        stop?.();
      }
    });

    return () => stop?.();
  }, [value, motionKey, interacting, durationMs]);

  // Keep the virtual child stable: the single shared-rAF task owns textContent
  // after mount, while React continues to own the span and its accessibility.
  return (
    <span ref={elementRef} className={className} style={style} title={title}>
      {initialText.current}
    </span>
  );
}
