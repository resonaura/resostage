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

// HeroUI v3 has no provider -- theme is CSS-driven via a class/data-theme
// attribute on <html>. This app is a stage-side remote/mirror of the native
// (always-dark) desktop app, so it defaults to dark rather than following
// system preference.
import { transport } from "./lib/api";
import { keyEventToDescription } from "./screens/SettingsScreen";

function useForcedDarkTheme() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("dark");
    root.setAttribute("data-theme", "dark");
  }, []);
}

function useDismissLoadingOverlay() {
  useEffect(() => {
    const overlay = document.getElementById("loading-overlay");
    if (!overlay) return;
    overlay.classList.add("loading-overlay-hidden");
    const timer = setTimeout(() => {
      overlay.remove();
    }, 220);
    return () => clearTimeout(timer);
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

  useEffect(() => {
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

      // Configurable project keybindings first (transport / mode / sections).
      for (const kb of bindingsRef.current) {
        if (!eventMatchesBinding(e, kb.key)) continue;
        e.preventDefault();
        e.stopPropagation();
        switch (kb.action) {
          case "play":
            if (playingRef.current) void transport.stop();
            else void transport.play();
            break;
          case "stop":
            void transport.stop();
            break;
          case "next":
            void transport.next();
            break;
          case "prev":
            void transport.prev();
            break;
          case "mode_player":
            setTab("player");
            break;
          case "mode_mixer":
            setTab("mixer");
            break;
          case "mode_editor":
            setTab("editor");
            break;
          case "mode_settings":
            setTab("settings");
            break;
          case "section_prev":
          case "section_next":
          case "section_last":
            jumpSection(
              kb.action,
              songsRef.current,
              songIndexRef.current,
              playheadRef.current,
            );
            break;
          default:
            break;
        }
        return;
      }

      // Built-in conveniences that aren't rebindable yet: digit song pick,
      // nudge seek. Mode keys used to collide with 1..4; modes now default
      // to F1..F4 so song select can keep 1..9.
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
        void transport.seek(Math.max(0, playheadRef.current - 5));
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        void transport.seek(playheadRef.current + 5);
      } else if (e.code === "Home") {
        e.preventDefault();
        void transport.seek(0);
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [setTab]);
}

function jumpSection(
  action: string,
  songs: WebUiState["songs"],
  songIndex: number,
  playhead: number,
) {
  if (songIndex < 0 || songIndex >= songs.length) return;
  const sections = [...(songs[songIndex].sections ?? [])].sort(
    (a, b) => a.startSeconds - b.startSeconds,
  );
  if (sections.length === 0) return;

  const eps = 0.05;
  if (action === "section_last") {
    void transport.seek(sections[sections.length - 1].startSeconds);
    return;
  }

  let at = -1;
  for (let i = 0; i < sections.length; i++) {
    if (playhead + eps >= sections[i].startSeconds) at = i;
  }

  if (action === "section_prev") {
    const target = at < 0 ? 0 : at - 1;
    if (target >= 0) void transport.seek(sections[target].startSeconds);
    return;
  }
  if (action === "section_next") {
    const target = at + 1;
    if (target < sections.length)
      void transport.seek(sections[target].startSeconds);
  }
}

export default function App() {
  useForcedDarkTheme();
  useDismissLoadingOverlay();
  const [tab, setTab] = useState("player");
  // Tell the backend which SPA tab is active so WS frames only carry that
  // page's heavy arrays (transport/time always included).
  const { state, status, transport, cpuHistory, ramHistory } =
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
    if (t === "player" || t === "mixer" || t === "editor" || t === "settings")
      setTab(t);
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

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {state.hardwareAlarm && (
        <div className="flex items-center justify-center gap-2 bg-danger px-3 py-2 text-sm font-semibold text-danger-foreground">
          <AlertTriangle size={16} />
          AUDIO DEVICE DISCONNECTED -- fell back to default output
        </div>
      )}

      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-default/60 bg-background px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-accent">
          <Radio size={16} />
          ResoStage
        </div>
        <ProjectNameField state={state} />
        <ProjectMenu state={state} />
        <ConnectionBadge status={status} transport={transport} />
      </header>

      <Tabs
        selectedKey={tab}
        onSelectionChange={(k) => setTab(String(k))}
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

// The project's name is otherwise only an implicit side effect of whichever
// file path a save dialog produced -- and a plain-browser "download" Save As
// can't drive that at all, since JS never learns the filename the user
// picked in the OS's own save sheet (see lib/api.ts's project.setName doc).
// Editing it directly here keeps the header an honest, always-current
// reflection of "what project is this", independent of save/load plumbing.
function ProjectNameField({ state }: { state: WebUiState }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(state.projectName);

  const commit = () => {
    const name = draft.trim();
    setEditing(false);
    if (name.length > 0 && name !== state.projectName)
      void project.setName(name);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
        className="min-w-0 flex-1 rounded border border-default/40 bg-default/20 px-1.5 py-0.5 text-sm text-foreground focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      title="Click to rename project"
      onClick={() => {
        setDraft(state.projectName);
        setEditing(true);
      }}
      className="min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-sm text-foreground/70 hover:bg-default/15 hover:text-foreground"
    >
      {state.projectName || "No project"}
    </button>
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
}: {
  status: "connecting" | "live" | "reconnecting";
  transport: TransportKind;
}) {
  const color =
    status === "live"
      ? "bg-success"
      : status === "connecting"
        ? "bg-warning"
        : "bg-danger";
  // Protocol label is a dev aid. Flip SHOW_TRANSPORT_LABEL in
  // lib/devFlags.ts to hide for production. (Live state is always WS —
  // full-frame JUCE emit was too expensive at 30 Hz.)
  const label = SHOW_TRANSPORT_LABEL && transport !== "none" ? "WS" : null;
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
