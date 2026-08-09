import { ScrollShadow } from "@heroui/react";
import {
  Button,
  Card,
  ToggleButton,
  ToggleButtonGroup,
} from "../components/ui";
import {
  ChevronDown,
  ChevronUp,
  Gauge,
  ListMusic,
  Loader2,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  emptyProjectActions,
  EmptyProjectState,
} from "../components/EmptyProjectState";
import { ImportStemsModal } from "../components/ImportStemsModal";
import {
  autoDetectBpm,
  autoDetectSongName,
  autoDetectStemMappings,
  executeStemImport,
} from "../lib/stemImport";
import { Timeline } from "../components/Timeline";
import { builder } from "../lib/api";
import { useIsCompact } from "../lib/useMediaQuery";
import type {
  AllPeaksResponse,
  PeaksResponse,
  SongRow,
  WebUiState,
} from "../lib/types";

// ─── Re-export tab type ────────────────────────────────────────────────────
// Tracks/Events/Busses tabs were cut -- Tracks/regions are fully covered by
// the Timeline, Busses by the Mixer; Events (MIDI/HTTP/DMX triggers) had no
// replacement, cut anyway per product decision. Songs keeps its own tab:
// song-level setup (BPM, time signature, end mode, stem import) has no home
// elsewhere.
type EditorTab = "timeline" | "songs";

const inputCls =
  "w-full rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-sm outline-none focus:border-accent";
const labelCls =
  "text-[11px] font-semibold uppercase tracking-wide text-foreground/50";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  );
}

function ToggleRow({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <Button
          key={o.value}
          size="sm"
          variant={value === o.value ? "secondary" : "outline"}
          onPress={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

function ListPanel({
  title,
  rows,
  selected,
  onSelect,
  onAdd,
  onRemove,
  onMove,
  onImport,
  empty,
}: {
  title: string;
  rows: { key: string; label: string; sub?: string; active?: boolean }[];
  selected: number;
  onSelect: (i: number) => void;
  onAdd: () => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
  onImport?: () => void;
  /** Shown in place of the list when there is nothing in it. */
  empty: React.ReactNode;
}) {
  return (
    <Card className="flex h-full min-h-0 w-full shrink-0 flex-col md:w-[40%]">
      <Card.Header className="flex flex-row items-center justify-between shrink-0">
        <Card.Title className="text-sm">{title}</Card.Title>
        <div className="flex gap-1">
          {onImport && (
            <Button
              size="sm"
              variant="outline"
              aria-label="Import Song Folder…"
              onPress={onImport}
            >
              <Upload size={14} className="mr-1" />
              Import…
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            aria-label="Add"
            onPress={onAdd}
          >
            <Plus size={14} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            aria-label="Remove"
            isDisabled={selected < 0}
            onPress={onRemove}
          >
            <Trash2 size={14} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            aria-label="Move up"
            isDisabled={selected <= 0}
            onPress={() => onMove(-1)}
          >
            <ChevronUp size={14} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            aria-label="Move down"
            isDisabled={selected < 0 || selected >= rows.length - 1}
            onPress={() => onMove(1)}
          >
            <ChevronDown size={14} />
          </Button>
        </div>
      </Card.Header>
      <Card.Content className="flex min-h-0 flex-1 flex-col p-0">
        <ScrollShadow
          orientation="vertical"
          className="flex min-h-0 flex-1 flex-col gap-0.5 p-2"
        >
          {rows.length === 0 ? (
            empty
          ) : (
            rows.map((r, i) => (
              <button
                key={r.key}
                onClick={() => onSelect(i)}
                className={`flex flex-col items-start rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  i === selected
                    ? "tint--soft text-foreground"
                    : "text-foreground/70 hover:bg-default/20"
                }`}
              >
                <span>
                  {r.active ? "▶ " : ""}
                  {r.label}
                </span>
                {r.sub && (
                  <span className="text-xs text-foreground/40">{r.sub}</span>
                )}
              </button>
            ))
          )}
        </ScrollShadow>
      </Card.Content>
    </Card>
  );
}

function EmptyDetailPanel({ hasRows }: { hasRows: boolean }) {
  return (
    <Card className="flex h-full min-h-0 flex-1 items-center justify-center border border-default/30 bg-surface/60 p-6 text-center text-sm text-foreground/40">
      {hasRows
        ? "Select an item from the sidebar to view and edit details."
        : "Add a song on the left and its details show up here."}
    </Card>
  );
}

// ─── Songs ─────────────────────────────────────────────────────────────────

function SongEditor({ song, index }: { song: SongRow; index: number }) {
  const [name, setName] = useState(song.name);
  const [bpm, setBpm] = useState(song.bpm);
  const [mode, setMode] = useState<"auto" | "wait">(song.mode);
  const [tsNum, setTsNum] = useState(song.tsNum);
  const [tsDen, setTsDen] = useState(song.tsDen);

  return (
    <Card className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <Card.Header className="shrink-0">
        <Card.Title className="text-sm">Song {index + 1}</Card.Title>
      </Card.Header>
      <Card.Content className="flex min-h-0 flex-1 flex-col p-0">
        <ScrollShadow
          orientation="vertical"
          className="flex min-h-0 flex-1 flex-col gap-3 p-4"
        >
          <Field label="Name">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="BPM">
            <input
              type="number"
              step={0.1}
              className={inputCls}
              value={bpm}
              onChange={(e) => setBpm(Number(e.target.value))}
            />
          </Field>
          <Field label="End mode">
            <ToggleRow
              options={[
                { value: "wait", label: "Wait for trigger" },
                { value: "auto", label: "Autoplay next" },
              ]}
              value={mode}
              onChange={(v) => setMode(v as "auto" | "wait")}
            />
          </Field>
          <Field label="Time signature">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={32}
                className={inputCls}
                value={tsNum}
                onChange={(e) => setTsNum(Number(e.target.value))}
              />
              <span className="text-foreground/40">/</span>
              <input
                type="number"
                min={1}
                max={32}
                className={inputCls}
                value={tsDen}
                onChange={(e) => setTsDen(Number(e.target.value))}
              />
            </div>
          </Field>

          <Button
            className="mt-2"
            onPress={() =>
              void builder.songUpdate({
                index,
                name,
                bpm,
                mode,
                tsNum,
                tsDen,
                click: song.click,
                clickBusId: song.clickBusId,
                clickSends: song.clickSends ?? [],
              })
            }
          >
            Apply song settings
          </Button>
        </ScrollShadow>
      </Card.Content>
    </Card>
  );
}

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
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setSelected(-1), [tab]);

  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importFolder, setImportFolder] = useState<string>("");
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  const handleImportFolderClick = () => {
    if (folderInputRef.current) {
      folderInputRef.current.click();
    }
  };

  const handleFolderChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const allFiles = Array.from(e.target.files ?? []).filter(
      (f) =>
        f.name.toLowerCase().endsWith(".wav") ||
        f.name.toLowerCase().endsWith(".mp3") ||
        f.name.toLowerCase().endsWith(".aif") ||
        f.name.toLowerCase().endsWith(".flac"),
    );
    e.target.value = "";
    if (allFiles.length === 0) return;

    const filesBySongFolder: Record<string, File[]> = {};

    for (const file of allFiles) {
      const relPath = file.webkitRelativePath || file.name;
      const parts = relPath.split("/").filter(Boolean);
      let songFolderName = "IMPORTED SONG";

      if (parts.length >= 3) {
        songFolderName = parts[parts.length - 2];
      } else if (parts.length === 2) {
        songFolderName = parts[0];
      } else {
        songFolderName = autoDetectSongName(file.name);
      }

      if (!filesBySongFolder[songFolderName]) {
        filesBySongFolder[songFolderName] = [];
      }
      filesBySongFolder[songFolderName].push(file);
    }

    const songFolders = Object.keys(filesBySongFolder);

    if (songFolders.length === 1) {
      const folderName = songFolders[0];
      setImportFiles(filesBySongFolder[folderName]);
      setImportFolder(folderName);
      setIsImportModalOpen(true);
      return;
    }

    for (const folderName of songFolders) {
      const songFiles = filesBySongFolder[folderName];
      const songName = autoDetectSongName(folderName);
      let bpm = 120;
      for (const f of songFiles) {
        const detected = autoDetectBpm(f.name);
        if (detected !== 120) {
          bpm = detected;
          break;
        }
      }
      const mappings = autoDetectStemMappings(songFiles);
      await executeStemImport(songName, bpm, 4, 4, mappings, state);
    }
  };

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
            ...(i > 0 ? [<ToggleButtonGroup.Separator key={`${t.id}-sep`} />] : []),
            <ToggleButton key={t.id} id={t.id}>
              {t.id === "timeline" ? <Gauge size={13} /> : <ListMusic size={13} />}
              {t.label}
            </ToggleButton>,
          ])}
        </ToggleButtonGroup>
      </div>

      {/* ── Timeline Tab ──────────────────────────────────────────────── */}
      {/* Editing a multi-song arrangement -- region trims, fades, light cues,
          marquee selection -- is a pointer-and-pixels job. It is not mounted
          on phones at all, both because it cannot be driven by touch at that
          width and because building every lane's waveform canvas is the most
          expensive thing this app does. */}
      {activeTab === "timeline" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Timeline
            state={state}
            peaks={peaks}
            allPeaks={allPeaks}
            pxPerSec={pxPerSec}
            setPxPerSec={setPxPerSec}
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
