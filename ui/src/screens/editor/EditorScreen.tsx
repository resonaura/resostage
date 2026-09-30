import {
  Button,
  ToggleButton,
  ToggleButtonGroup,
} from "../../components/ui";
import {
  Gauge,
  ListMusic,
  Loader2,
  Music,
  Sliders,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  emptyProjectActions,
  EmptyProjectState,
} from "./project/components/EmptyProjectState";
import { ImportStemsModal } from "../../transfer/audio/components/ImportStemsModal";
import { EditorInspector } from "./components/EditorInspector";
import { EmptyDetailPanel, ListPanel, SongEditor } from "./components/SongsTab";
import { Timeline } from "./timeline";
import { useEditorTrackSelection } from "./hooks/useEditorTrackSelection";
import { useMidiRegionEditorState } from "./hooks/useMidiRegionEditorState";
import { useStemFolderImport } from "./hooks/useStemFolderImport";
import { hotkeyManager, HotkeyScope } from "../../lib/interaction/HotkeyManager";
import { PianoRollEditorTab } from "./pianoroll/components/PianoRollEditorTab";
import { builder } from "../../lib/state/api";
import { useIsCompact } from "../../hooks/useMediaQuery";
import type {
  AllPeaksResponse,
  PeaksResponse,
  WebUiState,
} from "../../lib/state/types";

// ─── Re-export tab type ────────────────────────────────────────────────────
type EditorTab = "timeline" | "pianoroll" | "songs";

// ─── Root ───────────────────────────────────────────────────────────────────

export function EditorScreen({
  state,
  peaks,
  allPeaks,
  pxPerSec,
  setPxPerSec,
}: {
  state: WebUiState;
  peaks: PeaksResponse | null;
  allPeaks: AllPeaksResponse | null;
  pxPerSec: number;
  setPxPerSec: React.Dispatch<React.SetStateAction<number>>;
}) {
  const compact = useIsCompact();
  const [tab, setTab] = useState<EditorTab>("timeline");
  const [selected, setSelected] = useState(-1);
  const { selectedTrackId, selectedTrackIds, handleSelectTrack } =
    useEditorTrackSelection(state);
  const {
    selectedMidiTrackId,
    setSelectedMidiTrackId,
    selectedMidiRegionId,
    setSelectedMidiRegionId,
    visibleMidiRegionIds,
    setVisibleMidiRegionIds,
    pendingMidiRegionCreatesRef,
  } = useMidiRegionEditorState(state);
  const {
    folderInputRef,
    importFiles,
    importFolder,
    isImportModalOpen,
    setIsImportModalOpen,
    handleImportFolderClick,
    handleFolderChosen,
  } = useStemFolderImport(state);
  const [showInspector, setShowInspector] = useState(() => {
    try {
      return localStorage.getItem("resostage:editor-inspector") !== "false";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    hotkeyManager.setScopeActive(HotkeyScope.Timeline, !compact && tab === "timeline");
    hotkeyManager.setScopeActive(HotkeyScope.PianoRoll, !compact && tab === "pianoroll");
    return () => {
      hotkeyManager.setScopeActive(HotkeyScope.Timeline, false);
      hotkeyManager.setScopeActive(HotkeyScope.PianoRoll, false);
    };
  }, [compact, tab]);

  const toggleInspector = useCallback(() => {
    setShowInspector((v) => {
      const next = !v;
      try {
        localStorage.setItem("resostage:editor-inspector", String(next));
      } catch {}
      return next;
    });
  }, []);

  useEffect(
    () => hotkeyManager.registerCommand(
      "editor.toggle-inspector",
      "i",
      { scope: HotkeyScope.Timeline, priority: 100 },
      toggleInspector,
    ),
    [toggleInspector],
  );

  useEffect(() => setSelected(-1), [tab]);

  if (!state.projectName) {
    return (
      <div className="p-6 text-sm text-foreground/50">No project loaded.</div>
    );
  }

  // On a phone the arrangement view is not offered at all -- see the Timeline
  // block below for why -- so Songs is the only tab, and it is what the editor
  // opens on regardless of what was last selected on a bigger screen.
  const TABS: { id: EditorTab; label: string }[] = compact
    ? [{ id: "songs", label: "Songs" }]
    : [
        { id: "timeline", label: "Timeline" },
        { id: "pianoroll", label: "Piano Roll" },
        { id: "songs", label: "Songs" },
      ];
  const activeTab: EditorTab = compact ? "songs" : tab;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      {isImportModalOpen && (
        <ImportStemsModal
          isOpen={isImportModalOpen}
          files={importFiles}
          folderName={importFolder}
          state={state}
          onClose={() => setIsImportModalOpen(false)}
        />
      )}

      {state.busy && (
        <div className="flex shrink-0 items-center gap-2 rounded-lg bg-warning/15 px-3 py-2 text-sm text-warning">
          <Loader2 size={14} className="animate-spin" />
          {/* busy covers save + import + other async work; backend sets statusMessage. */}
          {state.statusMessage?.trim() || "Working… please wait."}
        </div>
      )}

      {/* Tab Bar — one exclusive choice, so a single-selection toggle group
          rather than N buttons each re-deriving "am I the active one?" from a
          comparison. Same control the timeline toolbar uses for its own
          Audio/Light view mode. */}
      <div className="flex shrink-0 items-center justify-between gap-1.5">
        <ToggleButtonGroup
          aria-label="Editor view"
          size="sm"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[activeTab]}
          onSelectionChange={(keys) => {
            const next = Array.from(keys)[0] as EditorTab | undefined;
            if (next) setTab(next);
          }}
        >
          {TABS.flatMap((t, i) => [
            ...(i > 0
              ? [<ToggleButtonGroup.Separator key={`${t.id}-sep`} />]
              : []),
            <ToggleButton key={t.id} id={t.id}>
              {t.id === "timeline" ? (
                <Gauge size={13} />
              ) : t.id === "pianoroll" ? (
                <Music size={13} />
              ) : (
                <ListMusic size={13} />
              )}
              {t.label}
            </ToggleButton>,
          ])}
        </ToggleButtonGroup>

        {activeTab === "timeline" && (
          <Button
            size="sm"
            variant={showInspector ? "secondary" : "outline"}
            onPress={toggleInspector}
            className={`gap-1.5 px-2.5 text-xs font-medium transition-all ${
              showInspector
                ? "border-accent/40 bg-accent/15 text-accent shadow-sm"
                : ""
            }`}
            aria-label="Toggle Inspector (I)"
          >
            <Sliders size={13} />
            <span>Inspector</span>
            <kbd className="ml-0.5 rounded bg-default/20 px-1 py-0.2 font-mono text-[9px] text-foreground/50">
              I
            </kbd>
          </Button>
        )}
      </div>

      {/* ── Timeline Tab ──────────────────────────────────────────────── */}
      {/* Editing a multi-song arrangement -- region trims, fades, light cues,
          marquee selection -- is a pointer-and-pixels job. It is not mounted
          on phones at all, both because it cannot be driven by touch at that
          width and because building every lane's waveform canvas is the most
          expensive thing this app does. */}
      {activeTab === "timeline" && (
        <div className="flex min-h-0 flex-1 flex-row gap-1.5 overflow-hidden">
          {showInspector && !compact && (
            <EditorInspector
              state={state}
              selectedTrackId={selectedTrackId ?? state.tracks[0]?.id ?? null}
              selectedRegion={null}
              onClose={toggleInspector}
            />
          )}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Timeline
              state={state}
              peaks={peaks}
              allPeaks={allPeaks}
              pxPerSec={pxPerSec}
              setPxPerSec={setPxPerSec}
              selectedTrackId={selectedTrackId}
              selectedTrackIds={selectedTrackIds}
              onSelectTrackId={handleSelectTrack}
              onOpenMidiRegion={(trackId, regionId) => {
                handleSelectTrack(trackId);
                setSelectedMidiTrackId(trackId);
                setSelectedMidiRegionId(regionId);
                setVisibleMidiRegionIds([regionId]);
                setTab("pianoroll");
              }}
            />
          </div>
        </div>
      )}

      {/* ── Piano Roll Tab ─────────────────────────────────────────────── */}
      {activeTab === "pianoroll" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <PianoRollEditorTab
            state={state}
            peaks={peaks}
            selectedTrackId={selectedTrackId}
            selectedMidiTrackId={selectedMidiTrackId}
            setSelectedMidiTrackId={setSelectedMidiTrackId}
            selectedMidiRegionId={selectedMidiRegionId}
            setSelectedMidiRegionId={setSelectedMidiRegionId}
            visibleMidiRegionIds={visibleMidiRegionIds}
            setVisibleMidiRegionIds={setVisibleMidiRegionIds}
            pendingMidiRegionCreates={pendingMidiRegionCreatesRef.current}
            onSelectTrack={handleSelectTrack}
          />
        </div>
      )}

      {/* ── Songs Tab ────────────────────────────────────────────────── */}
      {activeTab === "songs" && (
        <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is standard in HTML5 directory pickers
            webkitdirectory=""
            directory=""
            multiple
            className="hidden"
            onChange={handleFolderChosen}
          />
          <ListPanel
            title="Songs"
            rows={state.songs.map((s, i) => ({
              key: String(i),
              label: `${i + 1}. ${s.name}`,
              sub: `${s.bpm.toFixed(1)} bpm`,
              active: i === state.songIndex,
            }))}
            selected={selected}
            onSelect={setSelected}
            onAdd={() => builder.songAdd()}
            onRemove={() => selected >= 0 && builder.songRemove(selected)}
            onMove={(d) => selected >= 0 && builder.songMove(selected, d)}
            onImport={handleImportFolderClick}
            empty={
              <EmptyProjectState
                compact
                title="No songs yet"
                description="Start one from scratch, or point at a folder of stems and let the importer build it."
                actions={emptyProjectActions({
                  onCreateSong: () => void builder.songAdd(),
                  onImportFolder: handleImportFolderClick,
                })}
              />
            }
          />
          {selected >= 0 && state.songs[selected] ? (
            <SongEditor
              key={selected}
              song={state.songs[selected]}
              index={selected}
            />
          ) : (
            <EmptyDetailPanel hasRows={state.songs.length > 0} />
          )}
        </div>
      )}
    </div>
  );
}
