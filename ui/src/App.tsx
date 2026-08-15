import {
  AlertTriangle,
  Gauge,
  Lightbulb,
  Music4,
  Settings2,
  Sliders,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "./components/ConfirmDialog";
import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "./components/ContextMenu";
import { GlobalTransportBar } from "./components/GlobalTransportBar";
import { Button, Tabs } from "./components/ui";
import { performAction, type ActionId } from "./lib/actions";
import { fetchAllPeaks, fetchPeaks, project, transport } from "./lib/api";
import { apiUrl } from "./lib/backend";
import { SHOW_TRANSPORT_LABEL } from "./lib/devFlags";
import { IS_ELECTRON } from "./lib/electron";
import { sendTypingFocus } from "./lib/electronBridge";
import { forwardMenuState } from "./lib/electronBridge";
import { IS_EMBEDDED } from "./lib/embedded";
import { keyEventToDescription } from "./lib/keyEvents";
import type { AllPeaksResponse, PeaksResponse, WebUiState } from "./lib/types";
import { useLiveState, type TransportKind } from "./lib/useLiveState";
import { EditorScreen } from "./screens/EditorScreen";
import { LightScreen } from "./screens/LightScreen";
import { MixerScreen } from "./screens/MixerScreen";
import { PlayerScreen } from "./screens/PlayerScreen";
import { usePerformanceMode } from "./hooks/usePerformanceMode";
import { useTheme } from "./hooks/useTheme";
import { applyTheme, getTheme, THEME_NAMES, type ThemeName } from "./lib/theme";
import { TIER_FPS } from "./lib/performance";
import { SettingsScreen } from "./screens/SettingsScreen";

interface ToastNotification {
  id: string;
  title: string;
  message: string;
}

/** Match a key event against a juce-style description ("space", "cmd + p", "f1"). */
function eventMatchesBinding(e: KeyboardEvent, description: string): boolean {
  if (!description) return false;
  // During capture, Escape is reported as __cancel__ -- for live matching
  // treat plain Escape as the "escape" binding instead.
  let desc = keyEventToDescription(e);
  if (desc === "__cancel__") desc = "escape";
  if (!desc) return false;
  return desc === description.toLowerCase();
}

function useGlobalHotkeys(state: WebUiState, setTab: (tab: string) => void) {
  const playingRef = useRef(state.playing);
  playingRef.current = state.playing;
  const playheadRef = useRef(state.playheadSeconds);
  playheadRef.current = state.playheadSeconds;
  const bindingsRef = useRef(state.settings.keybindings);
  bindingsRef.current = state.settings.keybindings;
  const songsRef = useRef(state.songs);
  songsRef.current = state.songs;
  const songIndexRef = useRef(state.songIndex);
  songIndexRef.current = state.songIndex;

  // When embedded in the native app, the MacKeyMonitor NSEvent handler
  // processes all key bindings natively (play/stop/next/prev/mode/section/
  // undo/redo). The frontend only handles hard-coded conveniences (digit
  // song pick, arrow seek, Home) and sends the text-field focus signal so
  // the native monitor can suppress hotkeys while the user types.
  //
  // In the Electron shell the native monitor belongs to a different (and
  // inactive) process, so the SPA takes over ALL bindings -- exactly like a
  // plain browser tab, except the shell also owns the native menu bar.
  // Under the Electron shell, keep the shell told whether a text field has
  // focus -- it dispatches the bindings itself and cannot see into the
  // document, so without this a binding on a bare letter would eat that
  // letter while someone is naming a track.
  useEffect(() => {
    if (!IS_ELECTRON) return;
    const update = () => {
      const el = document.activeElement as HTMLElement | null;
      sendTypingFocus(
        !!el &&
          (el.tagName === "INPUT" ||
            el.tagName === "TEXTAREA" ||
            el.isContentEditable),
      );
    };
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      sendTypingFocus(false);
    };
  }, []);

  useEffect(() => {
    // Who owns the configurable bindings:
    //
    //   Electron shell  -> the shell's main process (before-input-event), so
    //                      a shortcut and a menu click take the identical
    //                      path and the menu-bar flash cannot go missing.
    //   plain browser   -> here, because there is no shell to ask.
    //
    // The built-in conveniences (song digits, arrows, Home) are NOT in the
    // binding table and run in BOTH modes -- the listener is always
    // installed, and only the binding loop inside it is gated.
    {
      const handleKeyDown = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" ||
            target.isContentEditable)
        ) {
          return;
        }

        // Space belongs to the transport, not to the browser.
        //
        // Left alone it does two things nobody wants here: it scrolls
        // whatever is under the pointer, and it "clicks" whichever control
        // happens to have focus -- so hitting play right after touching a
        // mute button toggles that button instead. Suppressing the default
        // outside text fields fixes both, and does not touch the binding: it
        // is still a normal rebindable key, dispatched below (or by the shell
        // under Electron), and the user can point it anywhere they like.
        //
        // The cost is that Space no longer toggles a focused checkbox or
        // switch. Enter still does, and on a stage surface a stray Space
        // toggling a control you cannot see is the worse failure.
        if (e.code === "Space" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
        }

        // Configurable project keybindings (transport / mode / sections /
        // bar_prev/bar_next / undo/redo). Route through the backend action
        // endpoint so lastAction/nonce updates (native menu flash + settings
        // dots). Mode switches also update the SPA tab optimistically.
        // Anything in the binding table is the shell's under Electron.
        // Bailing here rather than just skipping the loop is what stops the
        // conveniences below from acting on a key the shell has already
        // handled -- left/right are bound to bar_prev/bar_next, so without
        // this every arrow press would seek twice.
        const isBound = bindingsRef.current.some(
          (kb) => kb.key && eventMatchesBinding(e, kb.key),
        );
        if (IS_ELECTRON && isBound) return;

        for (const kb of bindingsRef.current) {
          if (IS_ELECTRON) break;
          if (!eventMatchesBinding(e, kb.key)) continue;
          e.preventDefault();
          e.stopPropagation();
          const action = kb.action as ActionId;
          void fetch(apiUrl("/api/v1/action"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          }).catch(() => {
            // Backend unreachable -- fall back to local handling.
            performAction(
              action,
              songsRef.current,
              songIndexRef.current,
              playheadRef.current,
              setTab,
              playingRef.current,
            );
          });
          if (action.startsWith("mode_")) {
            const tabId = action.replace("mode_", "");
            if (
              tabId === "player" ||
              tabId === "mixer" ||
              tabId === "editor" ||
              tabId === "light" ||
              tabId === "settings"
            )
              setTab(tabId);
          }
          return;
        }

        // Built-in conveniences that aren't rebindable yet.
        const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
        if (e.key >= "1" && e.key <= "9" && plain) {
          const songIdx = parseInt(e.key, 10) - 1;
          e.preventDefault();
          e.stopPropagation();
          void transport.select(songIdx);
        } else if (e.key === "0" && plain) {
          // 0 sits at the end of the song-picker row and means "back to the
          // top", which is the same thing the Stop button does -- the one
          // key you want under your hand when a cue goes wrong.
          e.preventDefault();
          e.stopPropagation();
          void fetch(apiUrl("/api/v1/action"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "stop_to_start" }),
          }).catch(() => {
            void transport.stop();
            void transport.seek(0);
          });
        } else if (e.code === "ArrowLeft") {
          e.preventDefault();
          performAction(
            "bar_prev",
            songsRef.current,
            songIndexRef.current,
            playheadRef.current,
            setTab,
            playingRef.current,
          );
        } else if (e.code === "ArrowRight") {
          e.preventDefault();
          performAction(
            "bar_next",
            songsRef.current,
            songIndexRef.current,
            playheadRef.current,
            setTab,
            playingRef.current,
          );
        } else if (e.code === "Home") {
          e.preventDefault();
          void transport.seek(0);
        }
      };

      window.addEventListener("keydown", handleKeyDown, { capture: true });
      return () => {
        window.removeEventListener("keydown", handleKeyDown, { capture: true });
      };
    }
  }, [setTab]);

  // Text-field focus signal: tell the native side when an editable element
  // is focused so MacKeyMonitor suppresses hotkeys (embedded only).
  useEffect(() => {
    if (!IS_EMBEDDED) return;
    const sendFocus = (focused: boolean) => {
      void fetch("/api/v1/ui/focus-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ focused }),
      }).catch(() => {});
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        sendFocus(true);
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        sendFocus(false);
      }
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
}

/** What "uncapped" asks the server for -- its own maximum, which it clamps. */
const FULL_RATE_HZ = 120;

export default function App() {
  const [tab, setTab] = useState("player");
  // Tell the backend which SPA tab is active so WS frames only carry that
  // page's heavy arrays (transport/time always included).
  const {
    state,
    status,
    transport,
    effectiveHz,
    cpuHistory,
    ramHistory,
    sendView,
    sendTelemetryHz,
    hasLiveSnapshot,
  } = useLiveState(tab);
  useGlobalHotkeys(state, setTab);
  // One frame budget for the whole UI -- see usePerformanceMode. Mounted here
  // and only here, so there is exactly one auto ladder deciding it.
  const performance = usePerformanceMode(state.health);
  const theme = useTheme();
  // Sync theme changes from backend/other clients to local UI
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
    sendTelemetryHz(TIER_FPS[performance.effectiveTier] || FULL_RATE_HZ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [performance.effectiveTier, status]);

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
    const t = state.uiTab;
    if (
      t === "player" ||
      t === "mixer" ||
      t === "editor" ||
      t === "light" ||
      t === "settings"
    ) {
      setTab(t);
      sendView(t);
    }
  }, [state.uiTab, state.uiTabSeq, sendView]);

  // ── Shared timeline state (DRY: both Player and Editor use the same peaks + zoom) ──
  const [peaks, setPeaks] = useState<PeaksResponse | null>(null);
  const [allPeaks, setAllPeaks] = useState<AllPeaksResponse | null>(null);
  const [pxPerSec, setPxPerSec] = useState(40);

  // Total region count across every song -- changes exactly when a region is
  // added/removed/split (peaks are keyed by file on the backend and a split
  // is served from cache almost instantly, but the poll loops below only run
  // for a bounded window after mount; without this, splitting a region more
  // than ~15s after load left the new region's waveform stuck on stale data
  // forever, since project name / song count / song index don't change on a
  // split -- looking like the peaks needed a slow recompute when they didn't).
  const totalRegionCount = state.songs.reduce(
    (sum, s) => sum + (s.regions?.length ?? 0),
    0,
  );

  // Per-song peaks (current staged song). Backend publishes each track as it
  // finishes -- poll frequently while filled count climbs, then settle.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      let lastFilled = -1;
      let stable = 0;
      for (let attempt = 0; attempt < 120 && !cancelled; attempt++) {
        const data = await fetchPeaks().catch(() => null);
        if (cancelled) return;
        if (data?.tracks) {
          setPeaks(data);
          const filled = data.tracks.filter((t) => t.levels.length > 0).length;
          if (filled === lastFilled) {
            stable += 1;
            // Empty-lane tracks never get levels, so stop on plateau not on
            // filled === tracks.length.
            if (stable >= 4 && (filled > 0 || attempt > 10)) return;
          } else {
            stable = 0;
            lastFilled = filled;
          }
        }
        const climbing = lastFilled >= 0 && stable === 0;
        await new Promise((resolve) =>
          setTimeout(resolve, climbing ? 150 : attempt < 40 ? 250 : 600),
        );
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [state.projectName, state.songIndex, totalRegionCount]);

  // All-song peaks -- apply every partial so regions light up as the
  // background sweep fills the session cache.
  useEffect(() => {
    let cancelled = false;
    // Region count at the moment this effect (re)ran -- the backend emits one
    // payload entry per region, so a payload describing fewer than this is one
    // it built before our change landed.
    const expectedEntries = totalRegionCount;
    const poll = async () => {
      let lastFilled = -1;
      let stable = 0;
      for (let attempt = 0; attempt < 240 && !cancelled; attempt++) {
        const data = await fetchAllPeaks().catch(() => null);
        if (cancelled) return;
        if (data) {
          setAllPeaks(data);
          // levelsIndex >= 0 means this region's file made it into the shared
          // file table, i.e. its waveform is drawable.
          const filled = data.songs.reduce(
            (n, s) => n + s.tracks.filter((t) => t.levelsIndex >= 0).length,
            0,
          );
          const total = data.songs.reduce((n, s) => n + s.tracks.length, 0);
          // `total` counts entries in the PAYLOAD, not regions we know about.
          // The backend rebuilds that payload on its own ~30 Hz tick, so the
          // fetch this effect fires the instant a region appears (a split)
          // normally beats it and gets the PREVIOUS blob -- which is
          // internally complete, so this used to return immediately and never
          // look again, leaving the new half spinning forever. Requiring the
          // payload to cover every region we currently have is what closes
          // that race; the plateau check below still ends polls that can
          // never reach it (regions with no audio file never get levels).
          if (total > 0 && total >= expectedEntries && filled >= total) return;
          if (filled === lastFilled) {
            stable += 1;
            if (stable >= 8 && (filled > 0 || attempt > 15)) return;
          } else {
            stable = 0;
            lastFilled = filled;
          }
        }
        await new Promise((resolve) =>
          setTimeout(resolve, attempt < 40 ? 250 : 700),
        );
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [state.projectName, state.songs.length, totalRegionCount]);

  // Hardware alarm toast notifications (post-startup only)
  const [toastNotifications, setToastNotifications] = useState<
    ToastNotification[]
  >([]);
  const isInitialLoadRef = useRef(true);
  const prevAlarmRef = useRef(state.hardwareAlarm);

  useEffect(() => {
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      prevAlarmRef.current = state.hardwareAlarm;
      return;
    }

    if (!prevAlarmRef.current && state.hardwareAlarm) {
      const id = Date.now().toString();
      setToastNotifications((prev) => [
        ...prev,
        {
          id,
          title: "Audio Device Error",
          message: "AUDIO DEVICE DISCONNECTED -- fell back to default output",
        },
      ]);

      const timer = setTimeout(() => {
        setToastNotifications((prev) => prev.filter((t) => t.id !== id));
      }, 5000);

      return () => clearTimeout(timer);
    }

    prevAlarmRef.current = state.hardwareAlarm;
  }, [state.hardwareAlarm]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="relative flex h-14 shrink-0 items-center bg-background px-2 sm:px-4">
        <div className="z-10 flex shrink-0 items-center">
          <img
            src="/logo.svg"
            alt="ResoStage"
            title="ResoStage"
            className="h-7 w-7 shrink-0 object-contain"
            draggable={false}
          />
        </div>

        {/* Center transport: always mounted, fades out on Player tab. Hidden
            outright on phones -- it cannot fit beside the logo and the status
            badge, and every screen that needs transport has its own. */}
        <div className="pointer-events-none absolute inset-0 hidden items-center justify-center md:flex">
          <div
            className={`pointer-events-auto transition-opacity duration-200 ease-out ${
              tab !== "player" ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            <GlobalTransportBar state={state} />
          </div>
        </div>

        <div className="z-10 ml-auto flex shrink-0 items-center gap-3">
          {!IS_EMBEDDED && !IS_ELECTRON ? <ProjectMenu state={state} /> : null}
          <ConnectionBadge
            status={status}
            transport={transport}
            wsHz={effectiveHz || state.wsHz}
          />
        </div>
      </header>

      <Tabs
        variant="nav"
        selectedKey={tab}
        onSelectionChange={(k) => {
          const v = String(k);
          setTab(v);
          sendView(v);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.ListContainer className="shrink-0 overflow-x-auto border-b border-default/30 px-1 sm:px-2 bg-transparent">
          <Tabs.List aria-label="Sections" className="bg-transparent">
            <Tabs.Tab id="player">
              <Music4 size={15} className="inline-block sm:mr-1.5" />
              <span className="hidden sm:inline">Player</span>
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="mixer">
              <Sliders size={15} className="inline-block sm:mr-1.5" />
              <span className="hidden sm:inline">Mixer</span>
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="editor">
              <Gauge size={15} className="inline-block sm:mr-1.5" />
              <span className="hidden sm:inline">Editor</span>
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="light">
              <Lightbulb size={15} className="inline-block sm:mr-1.5" />
              <span className="hidden sm:inline">Light</span>
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="settings">
              <Settings2 size={15} className="inline-block sm:mr-1.5" />
              <span className="hidden sm:inline">Settings</span>
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel
          id="player"
          className="flex min-h-0 flex-1 flex-col overflow-hidden p-1.5 sm:p-3"
        >
          <PlayerScreen
            state={state}
            cpuHistory={cpuHistory}
            ramHistory={ramHistory}
            peaks={peaks}
            allPeaks={allPeaks}
            pxPerSec={pxPerSec}
            setPxPerSec={setPxPerSec}
          />
        </Tabs.Panel>
        <Tabs.Panel
          id="mixer"
          className="flex min-h-0 flex-1 flex-col overflow-hidden p-1.5 sm:p-3"
        >
          <MixerScreen state={state} />
        </Tabs.Panel>
        <Tabs.Panel
          id="editor"
          className="flex min-h-0 flex-1 flex-col overflow-hidden p-1.5 sm:p-3"
        >
          <EditorScreen
            state={state}
            peaks={peaks}
            allPeaks={allPeaks}
            pxPerSec={pxPerSec}
            setPxPerSec={setPxPerSec}
          />
        </Tabs.Panel>
        <Tabs.Panel id="light" className="flex-1 overflow-auto p-1.5 sm:p-3">
          <LightScreen state={state} />
        </Tabs.Panel>
        <Tabs.Panel id="settings" className="flex-1 overflow-auto p-1.5 sm:p-3">
          <SettingsScreen
            state={state}
            performance={performance}
            theme={theme}
          />
        </Tabs.Panel>
      </Tabs>

      <footer className="hidden shrink-0 border-t border-default/60 px-4 py-1.5 text-center text-xs text-foreground/40 sm:block">
        <span className="inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5">
          <span>
            {state.statusMessage || "ResoStage remote · mirrors desktop state"}
          </span>
          {(state.streamResidentTracks ?? 0) +
            (state.streamStreamingTracks ?? 0) >
            0 && (
            <span
              className={
                state.streamBufferUrgent ? "text-danger" : "text-foreground/50"
              }
              title="Stream buffer: min ring headroom · RAM-resident stems"
            >
              buf{" "}
              {state.streamBufferUrgent
                ? "LOW "
                : state.streamResidentTracks ===
                      (state.streamResidentTracks ?? 0) +
                        (state.streamStreamingTracks ?? 0) &&
                    (state.streamStreamingTracks ?? 0) === 0
                  ? "RAM "
                  : ""}
              {(state.streamBufferMinSec ?? 0) >= 100
                ? "∞"
                : `${(state.streamBufferMinSec ?? 0).toFixed(1)}s`}
              {" · "}
              {state.streamResidentTracks ?? 0}r/
              {state.streamStreamingTracks ?? 0}s
              {(state.streamResidentMiB ?? 0) > 0.05
                ? ` · ${(state.streamResidentMiB ?? 0).toFixed(0)} MiB`
                : ""}
            </span>
          )}
        </span>
      </footer>

      <QuitConfirmDialog state={state} />
      <OpenConfirmDialog state={state} />

      {toastNotifications.length > 0 && (
        <div className="fixed bottom-5 right-5 z-[300] flex flex-col gap-2.5 max-w-sm pointer-events-none">
          {toastNotifications.map((toast) => (
            <div
              key={toast.id}
              onClick={() =>
                setToastNotifications((prev) =>
                  prev.filter((t) => t.id !== toast.id),
                )
              }
              className="pointer-events-auto flex items-start gap-3 rounded-xl border border-danger/40 bg-surface/95 p-3.5 text-foreground shadow-2xl backdrop-blur-md transition-all cursor-pointer hover:border-danger"
              style={{
                animation: "fadeInUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
              }}
            >
              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-danger/20 text-danger">
                <AlertTriangle size={15} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-danger uppercase tracking-wider">
                  {toast.title}
                </p>
                <p className="text-xs text-foreground/90 font-medium leading-relaxed mt-0.5">
                  {toast.message}
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setToastNotifications((prev) =>
                    prev.filter((t) => t.id !== toast.id),
                  );
                }}
                className="text-foreground/40 hover:text-foreground text-xs font-bold"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Native quit was requested while the project has unsaved changes --
// MainComponent::confirmQuitIfUnsaved() is blocked waiting on our answer
// (see WebUiState.quitConfirmPending / WebCommandKind::QuitDecision). Only
// meaningful when embedded in the app's own webview; a plain LAN browser tab
// can still see this state but has no window to actually quit.
function QuitConfirmDialog({ state }: { state: WebUiState }) {
  return (
    <ConfirmDialog
      open={state.quitConfirmPending}
      title="Unsaved Changes"
      message={`Do you want to save changes to '${state.projectName || "Untitled Project"}' before quitting?`}
      confirmLabel="Save"
      cancelLabel="Cancel"
      thirdLabel="Don't Save"
      danger
      onConfirm={() => void project.resolveQuit("save")}
      onThird={() => void project.resolveQuit("discard")}
      onCancel={() => void project.resolveQuit("cancel")}
    />
  );
}

// A project was opened from Finder/Explorer while the current project has
// unsaved changes -- MainComponent::openProjectFromIpc() is blocked waiting on
// our answer (see WebUiState.openConfirmPending / WebCommandKind::OpenDecision).
// Mirror of QuitConfirmDialog with open-specific wording.
function OpenConfirmDialog({ state }: { state: WebUiState }) {
  return (
    <ConfirmDialog
      open={state.openConfirmPending}
      title="Unsaved Changes"
      message={`Do you want to save changes to '${state.projectName || "Untitled Project"}' before opening another project?`}
      confirmLabel="Save"
      cancelLabel="Cancel"
      thirdLabel="Don't Save"
      danger
      onConfirm={() => void project.resolveOpen("save")}
      onThird={() => void project.resolveOpen("discard")}
      onCancel={() => void project.resolveOpen("cancel")}
    />
  );
}

function ProjectMenu({ state }: { state: WebUiState }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [saveLabel, setSaveLabel] = useState("Save");
  const saveFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentBtnRef = useRef<HTMLButtonElement>(null);
  const [recentAnchor, setRecentAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // Mirror native status: "Saving…" while busy, then flash "Saved".
  useEffect(() => {
    const msg = state.statusMessage ?? "";
    if (/^Saving\b/i.test(msg) || state.busy) {
      setSaveLabel("Saving…");
      return;
    }
    if (!/^Saved\b/i.test(msg)) return;
    setSaveLabel("Saved");
    if (saveFlashTimer.current) clearTimeout(saveFlashTimer.current);
    saveFlashTimer.current = setTimeout(() => setSaveLabel("Save"), 1800);
    return () => {
      if (saveFlashTimer.current) clearTimeout(saveFlashTimer.current);
    };
  }, [state.statusMessage, state.busy]);

  const handleNew = () => {
    if (
      state.songCount > 0 ||
      (state.projectName && state.projectName !== "New Project")
    ) {
      setConfirmNew(true);
      return;
    }
    void project.new();
  };

  const handleLoad = () => {
    if (IS_EMBEDDED) {
      void project.loadDialog();
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void project.upload(file);
  };

  const handleSave = () => {
    if (IS_EMBEDDED) void project.save();
    else void project.exportAndDownload();
  };
  const handleSaveAs = () => {
    if (IS_EMBEDDED) void project.saveAs();
    else void project.exportAndDownload();
  };

  // ⌘S / Ctrl+S → Save, ⇧⌘S → Save As (skip when typing in inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) handleSaveAs();
        else handleSave();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  return (
    <div className="flex items-center gap-1.5">
      <input
        ref={fileInputRef}
        type="file"
        accept=".rsnraset"
        className="hidden"
        onChange={handleFileChosen}
      />
      <Button size="sm" variant="outline" onPress={handleNew}>
        New
      </Button>
      <Button size="sm" variant="outline" onPress={handleLoad}>
        {IS_EMBEDDED ? "Load…" : "Upload…"}
      </Button>
      {IS_EMBEDDED && (
        <Button
          ref={recentBtnRef}
          size="sm"
          variant="outline"
          onPress={() => {
            const r = recentBtnRef.current?.getBoundingClientRect();
            setRecentAnchor(
              r ? { x: r.left, y: r.bottom + 4 } : { x: 0, y: 0 },
            );
          }}
        >
          Recent
        </Button>
      )}
      {recentAnchor && (
        <ContextMenu
          x={recentAnchor.x}
          y={recentAnchor.y}
          width={260}
          onClose={() => setRecentAnchor(null)}
        >
          {state.settings.recentProjects.length === 0 ? (
            <ContextMenuItem disabled onClick={() => {}}>
              No Recent Projects
            </ContextMenuItem>
          ) : (
            <>
              {state.settings.recentProjects.map((rp) => (
                <ContextMenuItem
                  key={rp.path}
                  onClick={() => {
                    setRecentAnchor(null);
                    void project.openRecent(rp.path);
                  }}
                >
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium text-xs text-foreground truncate">
                      {rp.displayName}
                    </span>
                    <span
                      className="text-[10px] text-foreground/40 truncate"
                      title={rp.path}
                    >
                      {rp.path}
                    </span>
                  </div>
                </ContextMenuItem>
              ))}
              <ContextMenuDivider />
              <ContextMenuItem
                danger
                onClick={() => {
                  setRecentAnchor(null);
                  void project.clearRecent();
                }}
              >
                Clear Recent
              </ContextMenuItem>
            </>
          )}
        </ContextMenu>
      )}
      <span title={IS_EMBEDDED ? "Save (⌘S)" : "Download project"}>
        <Button
          size="sm"
          variant={saveLabel === "Saved" ? "primary" : "outline"}
          onPress={handleSave}
        >
          {IS_EMBEDDED ? saveLabel : "Download"}
        </Button>
      </span>
      {IS_EMBEDDED && (
        <span title="Save As (⇧⌘S)">
          <Button size="sm" variant="outline" onPress={handleSaveAs}>
            Save As&hellip;
          </Button>
        </span>
      )}
      <ConfirmDialog
        open={confirmNew}
        title="Unsaved changes"
        message="Start a new project? This discards the current project's unsaved in-memory state (any file already on disk is untouched)."
        confirmLabel="New Project"
        cancelLabel="Cancel"
        danger
        onCancel={() => setConfirmNew(false)}
        onConfirm={() => {
          setConfirmNew(false);
          void project.new();
        }}
      />
    </div>
  );
}

function ConnectionBadge({
  status,
  transport,
  wsHz,
}: {
  status: "connecting" | "live" | "reconnecting";
  transport: TransportKind;
  wsHz: number;
}) {
  const color =
    status === "live"
      ? "bg-success"
      : status === "connecting"
        ? "bg-warning"
        : "bg-danger";
  // Protocol label is a dev aid. Flip SHOW_TRANSPORT_LABEL in
  // lib/devFlags.ts to hide for production. (Live state is always WS —
  // full-frame JUCE emit was too expensive at 30 Hz.) wsHz is the backend's
  // actual current send rate for this connection -- it adapts down under
  // sustained write backpressure (see WebServer.cpp's LWS_CALLBACK_TIMER)
  // and recovers slowly, so this reflects reality, not just the 30 Hz target.
  const label =
    SHOW_TRANSPORT_LABEL && transport !== "none"
      ? transport === "udp"
        ? "UDP: 60 Hz"
        : `WS: ${wsHz > 0 ? wsHz : "--"} Hz`
      : null;
  return (
    <div className="flex items-center gap-1.5 text-xs text-foreground/60">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {label != null && (
        <span className="font-mono text-[10px] uppercase tracking-wide text-foreground/40">
          {label}
        </span>
      )}
    </div>
  );
}
