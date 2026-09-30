import { Tooltip } from "@heroui/react";
import {
  AlertTriangle,
  Gauge,
  Keyboard,
  Lightbulb,
  Music4,
  Settings2,
  Sliders,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExportMidiDialog, type MidiExportIntent } from "./components/midi/ExportMidiDialog";
import { ImportMidiDialog } from "./components/midi/ImportMidiDialog";
import { ImportAudioBatchDialog } from "./components/dialogs/ImportAudioBatchDialog";
import { GlobalTransportBar } from "./components/transport/GlobalTransportBar";
import { OpenConfirmDialog, QuitConfirmDialog, QuitOverlay } from "./components/app/AppOverlays";
import { ProjectMenu } from "./components/project/ProjectMenu";
import {
  RenderAudioDialog,
  type RenderDialogIntent,
} from "./components/dialogs/RenderAudioDialog";
import { VirtualMidiKeyboard } from "./components/midi/VirtualMidiKeyboard";
import { Button, Tabs } from "./components/ui";
import { fetchAllPeaks, fetchPeaks } from "./lib/state/api";
import {
  getRemoteBackend,
  setRemoteBackend,
} from "./lib/state/backend";
import { SHOW_TRANSPORT_LABEL } from "./lib/state/devFlags";
import { IS_ELECTRON } from "./lib/platform/electron";
import { forwardMenuState } from "./lib/platform/electronBridge";
import { IS_EMBEDDED } from "./lib/platform/embedded";
import { hotkeyManager, HotkeyScope } from "./lib/interaction/HotkeyManager";
import { useGlobalHotkeys } from "./lib/interaction/useGlobalHotkeys";
import type { AllPeaksResponse, PeaksResponse } from "./lib/state/types";
import { useLiveState, type TransportKind } from "./lib/state/useLiveState";
import { EditorScreen } from "./screens/editor/EditorScreen";
import { LightScreen } from "./screens/light/LightScreen";
import { MixerScreen } from "./screens/mixer";
import { PlayerScreen } from "./screens/player/PlayerScreen";
import { usePerformanceMode } from "./hooks/usePerformanceMode";
import { useTheme } from "./hooks/useTheme";
import { applyTheme, getTheme, THEME_NAMES, type ThemeName } from "./lib/theme";
import { TIER_FPS } from "./lib/state/performance";
import { SettingsScreen } from "./screens/settings/SettingsScreen";
interface ToastNotification {
  id: string;
  title: string;
  message: string;
}


/** What "uncapped" asks the server for -- its own maximum, which it clamps. */
const FULL_RATE_HZ = 120;

export default function App() {
  const isStandaloneKeyboardWindow =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("window") ===
      "virtual-keyboard";

  const [tab, setTab] = useState("player");
  const [isVirtualKeyboardOpen, setIsVirtualKeyboardOpen] = useState(false);

  const toggleVirtualKeyboard = useCallback(() => {
    if (
      window.resostageElectron?.isElectron &&
      window.resostageElectron.toggleKeyboardWindow
    ) {
      void window.resostageElectron.toggleKeyboardWindow();
    } else {
      setIsVirtualKeyboardOpen((prev) => !prev);
    }
  }, []);

  useEffect(() =>
    hotkeyManager.registerActionHandler("toggle_musical_typing", () => {
      toggleVirtualKeyboard();
      return true;
    }), [toggleVirtualKeyboard]);

  useEffect(() => {
    const mod = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "cmd" : "ctrl";
    return hotkeyManager.registerCommand(
      "keyboard.toggle-musical-typing",
      `${mod} + k`,
      { scope: HotkeyScope.Global, priority: 100 },
      () => {
        toggleVirtualKeyboard();
        return true;
      },
    );
  }, [toggleVirtualKeyboard]);

  useEffect(() => {
    const handleKeyboardState = (e: Event) => {
      const isOpen = Boolean((e as CustomEvent<boolean>).detail);
      setIsVirtualKeyboardOpen(isOpen);
    };
    window.addEventListener(
      "resostage-keyboard-state-changed",
      handleKeyboardState,
    );
    return () => {
      window.removeEventListener(
        "resostage-keyboard-state-changed",
        handleKeyboardState,
      );
    };
  }, []);

  const [renderRequest, setRenderRequest] = useState<{
    open: boolean;
    intent: RenderDialogIntent;
    id: number;
  }>({ open: false, intent: { kind: "generic" }, id: 0 });
  const [midiExport, setMidiExport] = useState<{ open: boolean; intent: MidiExportIntent }>({
    open: false, intent: { kind: "all-midi" },
  });
  const midiImportInput = useRef<HTMLInputElement>(null);
  const audioImportInput = useRef<HTMLInputElement>(null);
  const [midiImportRequest, setMidiImportRequest] = useState<{
    files: File[];
    target?: { songIndex: number; trackId?: string; startBeats?: number };
  } | null>(null);
  const [audioImportRequest, setAudioImportRequest] = useState<{
    files: File[];
    songIndex: number;
    startSeconds?: number;
    trackIndex?: number;
  } | null>(null);
  useEffect(() => {
    const midi = () => midiImportInput.current?.click();
    const audio = () => audioImportInput.current?.click();
    window.addEventListener("resostage-open-midi-import", midi);
    window.addEventListener("resostage-open-audio-import", audio);
    return () => {
      window.removeEventListener("resostage-open-midi-import", midi);
      window.removeEventListener("resostage-open-audio-import", audio);
    };
  }, []);
  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<{
        files: File[];
        songIndex: number;
        startSeconds?: number;
        trackIndex?: number;
      }>).detail;
      if (detail?.files?.length) setAudioImportRequest(detail);
    };
    window.addEventListener("resostage-import-audio-batch", handle);
    return () => window.removeEventListener("resostage-import-audio-batch", handle);
  }, []);
  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<{
        files: File[];
        target?: { songIndex: number; trackId?: string; startBeats?: number };
      }>).detail;
      if (detail?.files?.length) setMidiImportRequest(detail);
    };
    window.addEventListener("resostage-import-midi", handle);
    return () => window.removeEventListener("resostage-import-midi", handle);
  }, []);
  useEffect(() => {
    const handle = (event: Event) => {
      const intent = (event as CustomEvent<MidiExportIntent>).detail;
      setMidiExport({ open: true, intent: intent?.kind ? intent : { kind: "all-midi" } });
    };
    window.addEventListener("resostage-open-midi-export", handle);
    return () => window.removeEventListener("resostage-open-midi-export", handle);
  }, []);
  const openRender = useCallback((intent: RenderDialogIntent) => {
    setRenderRequest((current) => ({
      open: true,
      intent,
      id: current.id + 1,
    }));
  }, []);

  useEffect(() => {
    const handleNativeRender = (event: Event) => {
      const detail = (event as CustomEvent<RenderDialogIntent>).detail;
      openRender(detail?.kind === "all-tracks" ? detail : { kind: "generic" });
    };
    window.addEventListener("resostage-open-audio-render", handleNativeRender);
    return () =>
      window.removeEventListener(
        "resostage-open-audio-render",
        handleNativeRender,
      );
  }, [openRender]);
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
  const [coreExit, setCoreExit] = useState<{
    code: number | null;
    signal: string | null;
    logPath: string;
    occurredAt: string;
  } | null>(null);
  useEffect(() => {
    const onCoreExit = (event: Event) => {
      const detail = (event as CustomEvent<typeof coreExit>).detail;
      if (detail) setCoreExit(detail);
    };
    window.addEventListener("resostage-core-process-exit", onCoreExit);
    return () => window.removeEventListener("resostage-core-process-exit", onCoreExit);
  }, []);

  useGlobalHotkeys(state, setTab, isVirtualKeyboardOpen);
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
  const totalRegionCount = Array.isArray(state.songs)
    ? state.songs.reduce((sum, s) => sum + (s?.regions?.length ?? 0), 0)
    : 0;

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
        if (data?.tracks && Array.isArray(data.tracks)) {
          setPeaks(data);
          const filled = data.tracks.filter(
            (t) => t?.levels && t.levels.length > 0,
          ).length;
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
  const songCount = state.songs?.length ?? 0;
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
        if (data && Array.isArray(data.songs)) {
          setAllPeaks(data);
          // levelsIndex >= 0 means this region's file made it into the shared
          // file table, i.e. its waveform is drawable.
          const filled = data.songs.reduce(
            (n, s) =>
              n +
              (Array.isArray(s?.tracks)
                ? s.tracks.filter((t) => t && t.levelsIndex >= 0).length
                : 0),
            0,
          );
          const total = data.songs.reduce(
            (n, s) => n + (Array.isArray(s?.tracks) ? s.tracks.length : 0),
            0,
          );
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
  }, [state.projectName, songCount, totalRegionCount]);

  const [isQuittingOverlay, setIsQuittingOverlay] = useState(false);
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

  const [remoteHost, setRemoteHost] = useState<string | null>(() => {
    return getRemoteBackend();
  });

  useEffect(() => {
    const checkRemote = async () => {
      if (IS_ELECTRON && window.resostageElectron?.getRemoteStatus) {
        try {
          const st = await window.resostageElectron.getRemoteStatus();
          if (st?.isRemoteMode && st.activeRemoteHost) {
            setRemoteBackend(st.activeRemoteHost);
            setRemoteHost(st.activeRemoteHost);
            return;
          } else if (!st?.isRemoteMode) {
            setRemoteBackend(null);
            setRemoteHost(null);
            return;
          }
        } catch {}
      }
      setRemoteHost(getRemoteBackend());
    };
    void checkRemote();
    const interval = setInterval(checkRemote, 1000);
    return () => clearInterval(interval);
  }, []);

  if (isStandaloneKeyboardWindow) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-background select-none text-foreground">
        <VirtualMidiKeyboard
          isOpen={true}
          standalone={true}
          onClose={() => {
            if (window.resostageElectron?.closeKeyboardWindow) {
              void window.resostageElectron.closeKeyboardWindow();
            } else {
              window.close();
            }
          }}
          state={state}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="relative flex h-14 shrink-0 items-center bg-background px-2 sm:px-4">
        <div className="z-10 flex shrink-0 items-center gap-2">
          <img
            src="/logo.svg"
            alt="ResoStage"
            title="ResoStage"
            className="h-7 w-7 shrink-0 object-contain"
            draggable={false}
          />
          {remoteHost ? (
            <div className="flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-0.5 text-warning font-medium text-[11px] border border-warning/30">
              <span className="font-semibold">REMOTE: {remoteHost}</span>
              <button
                type="button"
                onClick={async () => {
                  setRemoteBackend(null);
                  setRemoteHost(null);
                  if (
                    IS_ELECTRON &&
                    window.resostageElectron?.disconnectRemote
                  ) {
                    await window.resostageElectron.disconnectRemote();
                  } else {
                    window.location.href = "/";
                  }
                }}
                className="ml-1 text-[10px] text-foreground/70 underline hover:text-foreground cursor-pointer"
              >
                Disconnect
              </button>
            </div>
          ) : null}
        </div>

        {/* Center transport: always mounted, fades out on Player tab. Hidden
            outright on phones -- it cannot fit beside the logo and the status
            badge, and every screen that needs transport has its own.
            Positioned absolutely in the dead center of the header so
            it remains mathematically centered regardless of asymmetric left/right items. */}
        <div
          className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 hidden md:flex items-center justify-center transition-opacity duration-200 ease-out z-20 ${
            tab !== "player" ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="pointer-events-auto">
            <GlobalTransportBar state={state} />
          </div>
        </div>

        <div className="z-10 ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
          {(!IS_EMBEDDED && !IS_ELECTRON) || remoteHost ? (
            <ProjectMenu state={state} onRender={openRender} />
          ) : null}
          {/* Musical Typing / Virtual MIDI Keyboard Toggle */}
          <Tooltip>
            <Button
              isIconOnly
              size="sm"
              variant={isVirtualKeyboardOpen ? "accent-soft" : "default-soft"}
              onPress={toggleVirtualKeyboard}
              aria-label="Musical Typing Keyboard"
              className={`h-8 w-8 ${isVirtualKeyboardOpen ? "text-accent" : "text-foreground/70 hover:text-foreground"}`}
            >
              <Keyboard size={15} />
            </Button>
            <Tooltip.Content>Musical Typing / Virtual MIDI Keyboard (Cmd+K)</Tooltip.Content>
          </Tooltip>

          <ConnectionBadge
            status={status}
            transport={transport}
            telemetryHz={effectiveHz || state.telemetryHz}
          />
        </div>
      </header>

      {coreExit || (hasLiveSnapshot && status !== "live") ? (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-3 border-b border-danger/35 bg-danger/10 px-4 py-2.5 text-xs text-foreground"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0">
            <p className="font-semibold text-danger">
              {coreExit ? "ResoStage Core stopped unexpectedly" : "Backend connection lost — reconnecting…"}
            </p>
            <p className="mt-0.5 text-foreground/70">
              {coreExit
                ? `Exit code ${coreExit.code ?? "unknown"}${coreExit.signal ? ` · ${coreExit.signal}` : ""}. The interface is still open; project/audio state may be unavailable.`
                : "The interface is still running, but live control and playback state are unavailable until the backend returns."}
            </p>
            {coreExit?.logPath && (
              <p className="mt-0.5 break-all font-mono text-[10px] text-foreground/50">
                Core log: {coreExit.logPath}
              </p>
            )}
          </div>
        </div>
      ) : null}

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
          <MixerScreen
            state={state}
            active={tab === "mixer"}
            onRender={openRender}
          />
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

      <QuitConfirmDialog
        state={state}
        onStartQuitting={() => setIsQuittingOverlay(true)}
      />
      <OpenConfirmDialog state={state} />
      <QuitOverlay open={isQuittingOverlay} />
      <RenderAudioDialog
        open={renderRequest.open}
        state={state}
        intent={renderRequest.intent}
        requestId={renderRequest.id}
        onClose={() =>
          setRenderRequest((current) => ({ ...current, open: false }))
        }
      />
      <ExportMidiDialog
        open={midiExport.open}
        state={state}
        intent={midiExport.intent}
        onClose={() => setMidiExport((current) => ({ ...current, open: false }))}
      />
      <ImportMidiDialog
        open={midiImportRequest !== null}
        files={midiImportRequest?.files ?? []}
        target={midiImportRequest?.target}
        state={state}
        onClose={() => setMidiImportRequest(null)}
      />
      <ImportAudioBatchDialog
        open={audioImportRequest !== null}
        files={audioImportRequest?.files ?? []}
        state={state}
        songIndex={audioImportRequest?.songIndex ?? state.songIndex}
        startSeconds={audioImportRequest?.startSeconds}
        trackIndex={audioImportRequest?.trackIndex}
        onClose={() => setAudioImportRequest(null)}
      />
      <input
        ref={midiImportInput}
        type="file"
        accept=".mid,.midi,.midi2,audio/midi"
        multiple
        className="hidden"
        aria-label="Import MIDI file"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length) setMidiImportRequest({ files, target: { songIndex: state.songIndex } });
        }}
      />
      <input
        ref={audioImportInput}
        type="file"
        accept="audio/wav,.wav,.wave"
        multiple
        className="hidden"
        aria-label="Import audio file"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (!files.length) return;
          if (files.length > 1) {
            setAudioImportRequest({ files, songIndex: state.songIndex });
            return;
          }
          const index = state.tracks.findIndex((track) => track.id === state.activeTrackId && track.kind === "audio");
          if (index < 0) {
            setAudioImportRequest({ files, songIndex: state.songIndex });
            return;
          }
          setAudioImportRequest({ files, songIndex: state.songIndex, trackIndex: index });
        }}
      />

      {!window.resostageElectron?.isElectron && (
        <VirtualMidiKeyboard
          isOpen={isVirtualKeyboardOpen}
          onClose={() => setIsVirtualKeyboardOpen(false)}
          state={state}
        />
      )}

      {toastNotifications.length > 0 && (
        <div className="fixed bottom-5 right-5 z-300 flex flex-col gap-2.5 max-w-sm pointer-events-none">
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

function ConnectionBadge({
  status,
  transport,
  telemetryHz,
}: {
  status: "connecting" | "live" | "reconnecting";
  transport: TransportKind;
  telemetryHz: number;
}) {
  const color =
    status === "live"
      ? "bg-success"
      : status === "connecting"
        ? "bg-warning"
        : "bg-danger";
  const label =
    SHOW_TRANSPORT_LABEL && transport !== "none"
      ? transport === "udp"
        ? `UDP: ${telemetryHz > 0 ? telemetryHz : "--"} Hz`
        : `WS: ${telemetryHz > 0 ? telemetryHz : "--"} Hz`
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
