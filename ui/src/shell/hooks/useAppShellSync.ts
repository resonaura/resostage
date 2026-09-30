import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { TIER_FPS } from "@/performance/logic/performance";
import type { usePerformanceMode } from "@/performance/hooks/usePerformanceMode";
import { IS_ELECTRON } from "@/lib/platform/electron";
import { forwardMenuState } from "@/lib/platform/electronBridge";
import { applyTheme, getTheme, THEME_NAMES, type ThemeName } from "@/lib/theme";
import type { WebUiState } from "@/lib/state/types";

/** What the UI asks for when uncapped; Core clamps this to its supported maximum. */
const FULL_RATE_HZ = 120;

/** Keeps Core, Electron's native menus, and renderer shell preferences aligned. */
export function useAppShellSync({
  state,
  tab,
  setTab,
  status,
  effectiveTier,
  sendView,
  sendTelemetryHz,
  hasLiveSnapshot,
}: {
  state: WebUiState;
  tab: string;
  setTab: Dispatch<SetStateAction<string>>;
  status: "connecting" | "live" | "reconnecting";
  effectiveTier: ReturnType<typeof usePerformanceMode>["effectiveTier"];
  sendView: (tab: string) => void;
  sendTelemetryHz: (hz: number) => void;
  hasLiveSnapshot: boolean;
}) {
  // Sync theme changes from backend/other clients to local UI.
  useEffect(() => {
    const serverTheme = state.settings?.theme;
    if (
      serverTheme &&
      (THEME_NAMES as readonly string[]).includes(serverTheme) &&
      getTheme().name !== serverTheme
    ) {
      applyTheme({ name: serverTheme as ThemeName });
    }
  }, [state.settings?.theme]);

  // Keep the socket in step with the frame budget: no point receiving frames
  // faster than they can be painted. Re-sent on reconnect too -- a fresh
  // socket starts at the server's default until it is told otherwise.
  useEffect(() => {
    sendTelemetryHz(TIER_FPS[effectiveTier] || FULL_RATE_HZ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTier, status]);

  // Electron shell: keep its native menu bar / Touch Bar live (undo/redo
  // state, Open Recent, active tab, window title) off the 30 Hz state feed.
  // Two things to get right here:
  //  - Don't forward before hasLiveSnapshot: on mount `state` is still
  //    emptyState (recentProjects: []), and forwarding it would overwrite
  //    the main process's own correctly pre-seeded Open Recent list (it
  //    fetches GET /api/v1/ui/menu before creating the window) with an
  //    empty one, before any real data has arrived to correct it.
  //  - Send local `tab`, not `state.uiTab`: `state.uiTab` is only bumped by
  //    performAction("mode_*") (keyboard/MIDI/native menu), never by
  //    clicking a tab directly in this page's own tab bar -- so the Touch
  //    Bar highlight would go stale on every mouse-driven tab switch. Local
  //    `tab` is updated by every navigation path and is what's actually on
  //    screen.
  useEffect(() => {
    if (!IS_ELECTRON || !hasLiveSnapshot) return;
    forwardMenuState({ ...state, uiTab: tab });
  }, [state, tab, hasLiveSnapshot]);

  // MIDI / native mode_* actions publish uiTab + uiTabSeq; apply them here
  // so a footswitch can flip screens the same way a keybinding does.
  const lastUiTabSeq = useRef(0);
  useEffect(() => {
    const seq = state.uiTabSeq ?? 0;
    if (seq === 0 || seq === lastUiTabSeq.current) return;
    lastUiTabSeq.current = seq;
    const nextTab = state.uiTab;
    if (
      nextTab === "player" ||
      nextTab === "mixer" ||
      nextTab === "editor" ||
      nextTab === "light" ||
      nextTab === "settings"
    ) {
      setTab(nextTab);
      sendView(nextTab);
    }
  }, [state.uiTab, state.uiTabSeq, sendView, setTab]);
}
