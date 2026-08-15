import { useCallback, useState } from "react";
import { applyTheme, readThemeChoice, type ThemeName } from "../lib/theme";
import { settings } from "../lib/api";

/**
 * The live theme choice, for the one place that lets you change it.
 *
 * The theme itself is applied before React mounts (see main.tsx) so there is
 * never a frame of the wrong colours; this hook only mirrors it into state so
 * the picker can show which one is on.
 */
export function useTheme(): {
  name: ThemeName;
  setName: (name: ThemeName) => void;
} {
  const [name, setNameState] = useState<ThemeName>(() => readThemeChoice().name);

  return {
    name,
    setName: useCallback((next: ThemeName) => {
      applyTheme({ name: next });
      setNameState(next);
      void settings.setTheme(next);
    }, []),
  };
}
