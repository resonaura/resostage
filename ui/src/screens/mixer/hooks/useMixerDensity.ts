import { useCallback, useState } from "react";
import type { MixerDensity } from "@/screens/mixer/logic/constants";

const STORAGE_KEY = "resostage:mixer-density";

function readDensityPreference(): MixerDensity {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "narrow" || saved === "standard" || saved === "wide")
      return saved;
  } catch {
    // The default remains usable when storage is unavailable (e.g. private mode).
  }
  return "standard";
}

/** Owns the mixer strip-density preference and its backward-compatible storage key. */
export function useMixerDensity() {
  const [density, setDensity] = useState<MixerDensity>(readDensityPreference);

  const updateDensity = useCallback((next: MixerDensity) => {
    setDensity(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Keep the in-memory choice even when persistence is unavailable.
    }
  }, []);

  return { density, updateDensity };
}
