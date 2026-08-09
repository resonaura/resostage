import { useSyncExternalStore } from "react";
import { subscribeTheme, themeVersion } from "../lib/theme";

/**
 * A number that changes when the theme does.
 *
 * Put it in the dependency list of any `useMemo` that captures a RESOLVED
 * colour. By the time a colour reaches a memo it is a concrete `#rrggbb`, so
 * clearing the resolver's cache cannot reach it -- the memo has to be told to
 * recompute. Missing this is why the first version of the theme picker
 * repainted the whole interface except the track colours.
 */
export function useThemeVersion(): number {
  return useSyncExternalStore(subscribeTheme, themeVersion, themeVersion);
}
