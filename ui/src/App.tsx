import { Button, Tabs } from "@heroui/react";
import {
  AlertTriangle,
  Gauge,
  Music4,
  Radio,
  Settings2,
  Sliders,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { fetchAllPeaks, fetchPeaks, project } from "./lib/api";
import { IS_EMBEDDED } from "./lib/embedded";
import type { AllPeaksResponse, PeaksResponse, WebUiState } from "./lib/types";
import { SHOW_TRANSPORT_LABEL } from "./lib/devFlags";
import { useLiveState, type TransportKind } from "./lib/useLiveState";
import { EditorScreen } from "./screens/EditorScreen";
import { MixerScreen } from "./screens/MixerScreen";
import { PlayerScreen } from "./screens/PlayerScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { type ActionId, performAction } from "./lib/actions";

// HeroUI v3 has no provider -- theme is CSS-driven via a class/data-theme
// attribute on <html>. This app is a stage-side remote/mirror of the native
// (always-dark) desktop app, so it defaults to dark rather than following
// system preference.
import { transport } from "./lib/api";
import { keyEventToDescription } from "./screens/SettingsScreen";

interface ToastNotification {
  id: string;
  title: string;
  message: string;
}

function useForcedDarkTheme() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("dark");
    root.setAttribute("data-theme", "dark");
  }, []);
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
  useEffect(() => {
    if (!IS_EMBEDDED) {
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

        // Configurable project keybindings (transport / mode / sections / undo/redo).
        for (const kb of bindingsRef.current) {
          if (!eventMatchesBinding(e, kb.key)) continue;
          e.preventDefault();
          e.stopPropagation();
          performAction(
            kb.action as ActionId,
            songsRef.current,
            songIndexRef.current,
            playheadRef.current,
            setTab,
            playingRef.current,
          );
          return;
        }

        // Built-in conveniences that aren't rebindable yet.
        if (
          e.key >= "1" &&
          e.key <= "9" &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey
        ) {
          const songIdx = parseInt(e.key, 10) - 1;
          e.preventDefault();
          e.stopPropagation();
          void transport.select(songIdx);
        } else if (e.code === "ArrowLeft") {
          e.preventDefault();
          const songs = songsRef.current;
          const sIdx = songIndexRef.current;
          const song = songs[sIdx];
          const bpm = song?.bpm && song.bpm > 0 ? song.bpm : 120;
          const tsNum = song?.tsNum && song.tsNum > 0 ? song.tsNum : 4;
          const barSec = (60 / bpm) * tsNum;
          const curBar = playheadRef.current / barSec;
          const prevBarSec = Math.max(0, Math.floor(curBar - 0.01) * barSec);
          void transport.seek(prevBarSec);
        } else if (e.code === "ArrowRight") {
          e.preventDefault();
          const songs = songsRef.current;
          const sIdx = songIndexRef.current;
          const song = songs[sIdx];
          const bpm = song?.bpm && song.bpm > 0 ? song.bpm : 120;
          const tsNum = song?.tsNum && song.tsNum > 0 ? song.tsNum : 4;
          const barSec = (60 / bpm) * tsNum;
          const curBar = playheadRef.current / barSec;
          const nextBarSec = Math.floor(curBar + 1.01) * barSec;
          void transport.seek(nextBarSec);
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

export default function App() {
  useForcedDarkTheme();
  const [tab, setTab] = useState("player");
  // Tell the backend which SPA tab is active so WS frames only carry that
  // page's heavy arrays (transport/time always included).
  const { state, status, transport, cpuHistory, ramHistory, sendView } =
    useLiveState(tab);
  useGlobalHotkeys(state, setTab);

  // MIDI / native mode_* actions publish uiTab + uiTabSeq; apply them here
  // so a footswitch can flip screens the same way a keybinding does.
  const lastUiTabSeq = useRef(0);
  useEffect(() => {
    const seq = state.uiTabSeq ?? 0;
    if (seq === 0 || seq === lastUiTabSeq.current) return;
    lastUiTabSeq.current = seq;
    const t = state.uiTab;
    if (t === "player" || t === "mixer" || t === "editor" || t === "settings") {
      setTab(t);
      sendView(t);
    }
  }, [state.uiTab, state.uiTabSeq]);

  // ── Shared timeline state (DRY: both Player and Editor use the same peaks + zoom) ──
  const [peaks, setPeaks] = useState<PeaksResponse | null>(null);
  const [allPeaks, setAllPeaks] = useState<AllPeaksResponse | null>(null);
  const [pxPerSec, setPxPerSec] = useState(40);

  // Per-song peaks (current staged song)
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      for (let attempt = 0; attempt < 20 && !cancelled; attempt++) {
        const data = await fetchPeaks().catch(() => null);
        if (cancelled) return;
        if (data && data.tracks && data.tracks.length > 0) {
          setPeaks(data);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [state.projectName, state.songIndex]);

  // All-song peaks (for the multi-song timeline)
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      for (let attempt = 0; attempt < 30 && !cancelled; attempt++) {
        const data = await fetchAllPeaks().catch(() => null);
        if (cancelled) return;
        if (data) setAllPeaks(data);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [state.projectName, state.songs.length]);

  // Hardware alarm toast notifications (post-startup only)
  const [toastNotifications, setToastNotifications] = useState<ToastNotification[]>([]);
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

      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-default/60 bg-background px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-accent">
          <Radio size={16} />
          ResoStage
        </div>
        <ProjectNameField state={state} />
        <ProjectMenu state={state} />
        <ConnectionBadge status={status} transport={transport} wsHz={state.wsHz} />
      </header>

      <Tabs
        selectedKey={tab}
        onSelectionChange={(k) => {
          const v = String(k);
          setTab(v);
          sendView(v);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.ListContainer className="shrink-0 border-b border-default/30 px-2 bg-transparent">
          <Tabs.List aria-label="Sections" className="bg-transparent">
            <Tabs.Tab id="player">
              <Music4 size={15} className="mr-1.5 inline-block" />
              Player
              <Tabs.Indicator className="bg-background-tertiary" />
            </Tabs.Tab>
            <Tabs.Tab id="mixer">
              <Sliders size={15} className="mr-1.5 inline-block" />
              Mixer
              <Tabs.Indicator className="bg-background-tertiary" />
            </Tabs.Tab>
            <Tabs.Tab id="editor">
              <Gauge size={15} className="mr-1.5 inline-block" />
              Editor
              <Tabs.Indicator className="bg-background-tertiary" />
            </Tabs.Tab>
            <Tabs.Tab id="settings">
              <Settings2 size={15} className="mr-1.5 inline-block" />
              Settings
              <Tabs.Indicator className="bg-background-tertiary" />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel
          id="player"
          className="flex min-h-0 flex-1 flex-col overflow-hidden p-3"
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
          className="flex min-h-0 flex-1 flex-col overflow-hidden p-3"
        >
          <MixerScreen state={state} />
        </Tabs.Panel>
        <Tabs.Panel
          id="editor"
          className="flex min-h-0 flex-1 flex-col overflow-hidden p-3"
        >
          <EditorScreen
            state={state}
            peaks={peaks}
            allPeaks={allPeaks}
            pxPerSec={pxPerSec}
            setPxPerSec={setPxPerSec}
          />
        </Tabs.Panel>
        <Tabs.Panel id="settings" className="flex-1 overflow-auto p-3">
          <SettingsScreen state={state} />
        </Tabs.Panel>
      </Tabs>

      <footer className="shrink-0 border-t border-default/60 px-4 py-1.5 text-center text-xs text-foreground/40">
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

      {toastNotifications.length > 0 && (
        <div className="fixed bottom-5 right-5 z-[300] flex flex-col gap-2.5 max-w-sm pointer-events-none">
          {toastNotifications.map((toast) => (
            <div
              key={toast.id}
              onClick={() => setToastNotifications((prev) => prev.filter((t) => t.id !== toast.id))}
              className="pointer-events-auto flex items-start gap-3 rounded-xl border border-danger/40 bg-surface/95 p-3.5 text-foreground shadow-2xl backdrop-blur-md transition-all cursor-pointer hover:border-danger"
              style={{ animation: "fadeInUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)" }}
            >
              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-danger/20 text-danger">
                <AlertTriangle size={15} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-danger uppercase tracking-wider">{toast.title}</p>
                <p className="text-xs text-foreground/90 font-medium leading-relaxed mt-0.5">{toast.message}</p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setToastNotifications((prev) => prev.filter((t) => t.id !== toast.id));
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

// Read-only -- naming a project is Save / Save As's job (the file path IS
// the name), not a separately editable field that could drift from it.
function ProjectNameField({ state }: { state: WebUiState }) {
  return (
    <div className="min-w-0 flex-1 truncate px-1.5 py-0.5 text-left text-sm text-foreground/70">
      {state.projectName || "No project"}
    </div>
  );
}

function ProjectMenu({ state }: { state: WebUiState }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [saveLabel, setSaveLabel] = useState("Save");
  const saveFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      ? `WS: ${wsHz > 0 ? wsHz : "--"} Hz`
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
