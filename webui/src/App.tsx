import { useEffect, useRef, useState } from "react";
import { Button, Tabs } from "@heroui/react";
import { AlertTriangle, Gauge, Music4, Radio, Settings2, Sliders } from "lucide-react";
import { useLiveState } from "./lib/useLiveState";
import { project } from "./lib/api";
import { IS_EMBEDDED } from "./lib/embedded";
import type { WebUiState } from "./lib/types";
import { PlayerScreen } from "./screens/PlayerScreen";
import { MixerScreen } from "./screens/MixerScreen";
import { BuilderScreen } from "./screens/BuilderScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

// HeroUI v3 has no provider -- theme is CSS-driven via a class/data-theme
// attribute on <html>. This app is a stage-side remote/mirror of the native
// (always-dark) desktop app, so it defaults to dark rather than following
// system preference.
import { transport } from "./lib/api";

function useForcedDarkTheme() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("dark");
    root.setAttribute("data-theme", "dark");
  }, []);
}

function useGlobalHotkeys(state: WebUiState) {
  const playingRef = useRef(state.playing);
  playingRef.current = state.playing;
  const playheadRef = useRef(state.playheadSeconds);
  playheadRef.current = state.playheadSeconds;

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

      if (e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        if (playingRef.current) {
          void transport.stop();
        } else {
          void transport.play();
        }
      } else if (e.key >= "1" && e.key <= "9") {
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
  }, []);
}

export default function App() {
  useForcedDarkTheme();
  const { state, status, cpuHistory, ramHistory } = useLiveState();
  useGlobalHotkeys(state);
  const [tab, setTab] = useState("player");

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {state.hardwareAlarm && (
        <div className="flex items-center justify-center gap-2 bg-danger px-3 py-2 text-sm font-semibold text-danger-foreground">
          <AlertTriangle size={16} />
          AUDIO DEVICE DISCONNECTED -- fell back to default output
        </div>
      )}

      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-default/60 bg-surface px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-accent">
          <Radio size={16} />
          ResoStage
        </div>
        <div className="min-w-0 flex-1 truncate text-sm text-foreground/70">
          {state.projectName || "No project"}
        </div>
        <ProjectMenu state={state} />
        <ConnectionBadge status={status} />
      </header>

      <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))} className="flex min-h-0 flex-1 flex-col">
        <Tabs.ListContainer className="shrink-0 border-b border-default/30 px-2 bg-transparent">
          <Tabs.List aria-label="Sections" className="bg-transparent">
            <Tabs.Tab id="player">
              <Music4 size={15} className="mr-1.5 inline-block" />
              Player
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="mixer">
              <Sliders size={15} className="mr-1.5 inline-block" />
              Mixer
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="builder">
              <Gauge size={15} className="mr-1.5 inline-block" />
              Builder
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="settings">
              <Settings2 size={15} className="mr-1.5 inline-block" />
              Settings
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel id="player" className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
          <PlayerScreen state={state} cpuHistory={cpuHistory} ramHistory={ramHistory} />
        </Tabs.Panel>
        <Tabs.Panel id="mixer" className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
          <MixerScreen state={state} />
        </Tabs.Panel>
        <Tabs.Panel id="builder" className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
          <BuilderScreen state={state} />
        </Tabs.Panel>
        <Tabs.Panel id="settings" className="flex-1 overflow-auto p-3">
          <SettingsScreen state={state} />
        </Tabs.Panel>
      </Tabs>

      <footer className="shrink-0 border-t border-default/60 px-4 py-1.5 text-center text-xs text-foreground/40">
        {state.statusMessage || "ResoStage remote · mirrors desktop state"}
      </footer>
    </div>
  );
}

function ProjectMenu({ state }: { state: WebUiState }) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleNew = () => {
    if (state.songCount > 0 && !window.confirm(
      "Start a new project? This discards the current project's unsaved in-memory state (any file already on disk is untouched)."
    )) {
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

  const handleSave = () => void (IS_EMBEDDED ? project.save() : project.exportAndDownload());
  const handleSaveAs = () => void (IS_EMBEDDED ? project.saveAs() : project.exportAndDownload());

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
      <Button size="sm" variant="outline" onPress={handleSave}>
        {IS_EMBEDDED ? "Save" : "Download"}
      </Button>
      {IS_EMBEDDED && (
        <Button size="sm" variant="outline" onPress={handleSaveAs}>
          Save As&hellip;
        </Button>
      )}
    </div>
  );
}

function ConnectionBadge({ status }: { status: "connecting" | "live" | "reconnecting" }) {
  const color = status === "live" ? "bg-success" : status === "connecting" ? "bg-warning" : "bg-danger";
  const label = status === "live" ? "live" : status === "connecting" ? "connecting…" : "reconnecting…";
  return (
    <div className="flex items-center gap-1.5 text-xs text-foreground/60">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {label}
    </div>
  );
}
