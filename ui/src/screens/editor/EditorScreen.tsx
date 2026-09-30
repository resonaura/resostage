import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ImportStemsModal } from "@/transfer/audio/components/ImportStemsModal";
import { EditorInspector } from "@/screens/editor/components/EditorInspector";
import { EditorTabBar, type EditorTab } from "@/screens/editor/components/EditorTabBar";
import { SongsEditorTab } from "@/screens/editor/components/SongsEditorTab";
import { Timeline } from "@/screens/editor/timeline";
import { useEditorTrackSelection } from "@/screens/editor/hooks/useEditorTrackSelection";
import { useMidiRegionEditorState } from "@/screens/editor/hooks/useMidiRegionEditorState";
import { useStemFolderImport } from "@/screens/editor/hooks/useStemFolderImport";
import { hotkeyManager, HotkeyScope } from "@/lib/interaction/HotkeyManager";
import { PianoRollEditorTab } from "@/screens/editor/pianoroll/components/PianoRollEditorTab";
import { useIsCompact } from "@/hooks/useMediaQuery";
import type {
  AllPeaksResponse,
  PeaksResponse,
  WebUiState,
} from "@/lib/state/types";

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

  if (!state.projectName) {
    return (
      <div className="p-6 text-sm text-foreground/50">No project loaded.</div>
    );
  }

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

      <EditorTabBar
        compact={compact}
        activeTab={activeTab}
        onSelectTab={setTab}
        showInspector={showInspector}
        onToggleInspector={toggleInspector}
      />

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
        <SongsEditorTab
          state={state}
          folderInputRef={folderInputRef}
          onFolderChosen={handleFolderChosen}
          onImportFolder={handleImportFolderClick}
        />
      )}
    </div>
  );
}
