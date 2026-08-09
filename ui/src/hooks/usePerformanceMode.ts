import { useEffect, useRef, useState } from "react";
import {
  applyTier,
  healthPressure,
  observeFrameTimes,
  readPerformanceSettings,
  stepAuto,
  writePerformanceSettings,
  type AutoState,
  type HealthSample,
  type PerformanceSettings,
  type PerformanceTier,
} from "../lib/performance";
import type { WebUiState } from "../lib/types";

/**
 * Owns the UI's frame budget: what the user asked for, and what the machine
 * can actually sustain.
 *
 * Lives at the top of the app and nowhere else -- one frame cap, one auto
 * ladder. Components never think about this; they register with the shared
 * rAF driver and it runs them as often as the budget allows.
 */
export function usePerformanceMode(health: WebUiState["health"]): {
  settings: PerformanceSettings;
  setSettings: (s: PerformanceSettings) => void;
  /** What is actually in force -- equals `settings.tier` unless auto dropped it. */
  effectiveTier: PerformanceTier;
  /** True when auto is running below what the user picked. */
  degraded: boolean;
} {
  const [settings, setSettingsState] = useState<PerformanceSettings>(
    readPerformanceSettings,
  );
  const [effectiveTier, setEffectiveTier] = useState<PerformanceTier>(
    () => readPerformanceSettings().tier,
  );

  // Read by the once-per-second ladder without re-subscribing it.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const autoRef = useRef<AutoState>({
    effective: settings.tier,
    slowSeconds: 0,
    goodSeconds: 0,
  });
  const prevHealthRef = useRef<HealthSample | null>(null);
  const pressureRef = useRef(false);

  // Health arrives on its own cadence (1 Hz from the backend); latch whether
  // it showed pressure so the ladder can read it on its next second.
  useEffect(() => {
    const sample: HealthSample = {
      cpuPercent: health.cpuPercent ?? 0,
      underrunCount: health.underrunCount ?? 0,
      silentBlockCount: health.silentBlockCount ?? 0,
      streamStarveCount: health.streamStarveCount ?? 0,
      diskReadBytesPerSec: health.diskReadBytesPerSec ?? 0,
      diskWriteBytesPerSec: health.diskWriteBytesPerSec ?? 0,
    };
    if (healthPressure(prevHealthRef.current, sample)) pressureRef.current = true;
    prevHealthRef.current = sample;
  }, [health]);

  const setSettings = (next: PerformanceSettings) => {
    setSettingsState(next);
    writePerformanceSettings(next);
    // A change of mind takes effect now. Auto only ever moves DOWN from the
    // chosen tier, so re-seating the ladder here is what lets a user climb
    // back out of a tier auto put them in.
    autoRef.current = {
      effective: next.tier,
      slowSeconds: 0,
      goodSeconds: 0,
    };
    setEffectiveTier(next.tier);
    applyTier(next.tier);
  };

  useEffect(() => {
    applyTier(effectiveTier);
  }, [effectiveTier]);

  useEffect(() => {
    return observeFrameTimes((p95FrameMs) => {
      const { tier, auto } = settingsRef.current;
      if (!auto) {
        pressureRef.current = false;
        if (autoRef.current.effective !== tier) {
          autoRef.current = { effective: tier, slowSeconds: 0, goodSeconds: 0 };
          setEffectiveTier(tier);
        }
        return;
      }
      const next = stepAuto(autoRef.current, {
        ceiling: tier,
        p95FrameMs,
        pressure: pressureRef.current,
      });
      pressureRef.current = false;
      autoRef.current = next;
      // Only a real move is worth a render; the ladder ticks every second
      // and almost always returns the tier it was already on.
      setEffectiveTier((cur) => (cur === next.effective ? cur : next.effective));
    });
  }, []);

  return {
    settings,
    setSettings,
    effectiveTier,
    degraded: effectiveTier !== settings.tier,
  };
}
