import { useEffect, useRef, useState } from "react";
import { Button, Card, Slider, ScrollShadow } from "@heroui/react";
import { ChevronDown, ChevronUp, Gauge, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { builder } from "../lib/api";
import type { AllPeaksResponse, EventTypeWire, PeaksResponse, RegionRow, SongEventRow, SongRow, TrackRow, WebUiState } from "../lib/types";
import { ImportStemsModal, executeStemImport, autoDetectStemMappings, autoDetectSongName, autoDetectBpm } from "../components/ImportStemsModal";
import { Timeline } from "../components/Timeline";

// ─── Re-export tab type ────────────────────────────────────────────────────
type EditorTab = "timeline" | "songs" | "tracks" | "events" | "busses";

const inputCls =
  "w-full rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-sm outline-none focus:border-accent";
const labelCls = "text-[11px] font-semibold uppercase tracking-wide text-foreground/50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
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
  emptyHint,
}: {
  title: string;
  rows: { key: string; label: string; sub?: string; active?: boolean }[];
  selected: number;
  onSelect: (i: number) => void;
  onAdd: () => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
  onImport?: () => void;
  emptyHint: string;
}) {
  return (
    <Card className="flex h-full min-h-0 w-full shrink-0 flex-col md:w-[40%]">
      <Card.Header className="flex flex-row items-center justify-between shrink-0">
        <Card.Title className="text-sm">{title}</Card.Title>
        <div className="flex gap-1">
          {onImport && (
            <Button size="sm" variant="outline" aria-label="Import Song Folder…" onPress={onImport}>
              <Upload size={14} className="mr-1" />
              Import…
            </Button>
          )}
          <Button size="sm" variant="outline" isIconOnly aria-label="Add" onPress={onAdd}>
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
        <ScrollShadow orientation="vertical" className="flex min-h-0 flex-1 flex-col gap-0.5 p-2">
          {rows.length === 0 ? (
            <div className="p-3 text-sm text-foreground/40">{emptyHint}</div>
          ) : (
            rows.map((r, i) => (
              <button
                key={r.key}
                onClick={() => onSelect(i)}
                className={`flex flex-col items-start rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  i === selected ? "bg-accent/15 text-foreground" : "text-foreground/70 hover:bg-default/20"
                }`}
              >
                <span>
                  {r.active ? "▶ " : ""}
                  {r.label}
                </span>
                {r.sub && <span className="text-xs text-foreground/40">{r.sub}</span>}
              </button>
            ))
          )}
        </ScrollShadow>
      </Card.Content>
    </Card>
  );
}

function EmptyDetailPanel() {
  return (
    <Card className="flex h-full min-h-0 flex-1 items-center justify-center border border-default/30 bg-surface/60 p-6 text-center text-sm text-foreground/40">
      Select an item from the sidebar to view and edit details.
    </Card>
  );
}

function GainSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Field label={`${label} (${value.toFixed(1)} dB)`}>
      <Slider value={value} onChange={(v) => onChange(Array.isArray(v) ? v[0] : v)} minValue={-60} maxValue={12} step={0.1}>
        <Slider.Track className="h-1.5 w-full rounded-full bg-default/40">
          <Slider.Fill className="h-full rounded-full bg-accent" />
          <Slider.Thumb className="size-3.5 rounded-full border-2 border-background bg-accent" />
        </Slider.Track>
      </Slider>
    </Field>
  );
}

function PanSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Field label={`Pan (${value.toFixed(2)})`}>
      <Slider value={value} onChange={(v) => onChange(Array.isArray(v) ? v[0] : v)} minValue={-1} maxValue={1} step={0.01}>
        <Slider.Track className="h-1.5 w-full rounded-full bg-default/40">
          <Slider.Fill className="h-full rounded-full bg-foreground/40" />
          <Slider.Thumb className="size-3.5 rounded-full border-2 border-background bg-foreground/70" />
        </Slider.Track>
      </Slider>
    </Field>
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
        <ScrollShadow orientation="vertical" className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <Field label="Name">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
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

// ─── Tracks ────────────────────────────────────────────────────────────────

function TrackEditor({
  track,
  songIndex,
  index,
  busses,
  busy,
  region,
}: {
  track: TrackRow;
  songIndex: number;
  index: number;
  busses: WebUiState["busses"];
  busy: boolean;
  region?: RegionRow;
}) {
  const [name, setName] = useState(track.name);
  const [busId, setBusId] = useState(track.busId);
  const [gainDb, setGainDb] = useState(track.gainDb);
  const [pan, setPan] = useState(track.pan);
  const [mute, setMute] = useState(track.mute);
  const [solo, setSolo] = useState(track.solo);
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <Card className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <Card.Header className="shrink-0">
        <Card.Title className="text-sm">Track {index + 1}: {track.name || track.id}</Card.Title>
        <Card.Description className="truncate text-xs">
          {region?.file ? `Audio clip: ${region.file}` : "(no audio region for current song)"}
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <Field label="Name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Route to bus">
          <select className={inputCls} value={busId} onChange={(e) => setBusId(e.target.value)}>
            <option value="">(none -- sends only)</option>
            {busses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name || b.id}
              </option>
            ))}
          </select>
        </Field>
        <GainSlider label="Gain" value={gainDb} onChange={setGainDb} />
        <PanSlider value={pan} onChange={setPan} />
        <div className="flex gap-1.5">
          <Button size="sm" variant={mute ? "danger" : "outline"} onPress={() => setMute(!mute)}>
            Mute
          </Button>
          <Button size="sm" variant={solo ? "secondary" : "outline"} onPress={() => setSolo(!solo)}>
            Solo
          </Button>
        </div>
        <Button
          variant="primary"
          onPress={() => builder.trackUpdate({ songIndex, index, name, busId, gainDb, pan, mute, solo })}
        >
          Apply track
        </Button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".wav"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void builder.trackImportWav(songIndex, index, file);
          }}
        />
        <Button
          variant="outline"
          isDisabled={busy}
          onPress={() => fileInputRef.current?.click()}
        >
          {busy ? <Loader2 size={14} className="mr-1.5 inline-block animate-spin" /> : <Upload size={14} className="mr-1.5 inline-block" />}
          Import WAV&hellip;
        </Button>
      </Card.Content>
    </Card>
  );
}

// ─── Events ────────────────────────────────────────────────────────────────

const EVENT_TYPES: { value: EventTypeWire; label: string }[] = [
  { value: "programChange", label: "Program Change" },
  { value: "cc", label: "CC" },
  { value: "noteOn", label: "Note On" },
  { value: "noteOff", label: "Note Off" },
  { value: "http", label: "HTTP" },
  { value: "dmx", label: "DMX" },
];

function EventEditor({ event, songIndex, index }: { event: SongEventRow; songIndex: number; index: number }) {
  const [type, setType] = useState<EventTypeWire>(event.type);
  const [timeSeconds, setTimeSeconds] = useState(event.timeSeconds);
  const [triggerOnLoad, setTriggerOnLoad] = useState(event.triggerOnLoad);
  const [latencyMs, setLatencyMs] = useState(event.latencyMs);
  const [midiChannel, setMidiChannel] = useState(event.midiChannel);
  const [midiProgram, setMidiProgram] = useState(event.midiProgram);
  const [midiCC, setMidiCC] = useState(event.midiCC);
  const [midiCCValue, setMidiCCValue] = useState(event.midiCCValue);
  const [midiNote, setMidiNote] = useState(event.midiNote);
  const [midiVelocity, setMidiVelocity] = useState(event.midiVelocity);
  const [httpUrl, setHttpUrl] = useState(event.httpUrl);

  const isMidi = type === "programChange" || type === "cc" || type === "noteOn" || type === "noteOff";

  return (
    <Card className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <Card.Header className="shrink-0">
        <Card.Title className="text-sm">Event {index + 1}</Card.Title>
      </Card.Header>
      <Card.Content className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <Field label="Type">
          <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as EventTypeWire)}>
            {EVENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Time (s)">
          <input
            type="number"
            step={0.001}
            className={inputCls}
            value={timeSeconds}
            onChange={(e) => setTimeSeconds(Number(e.target.value))}
          />
        </Field>
        <Field label="Trigger on load">
          <ToggleRow
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
            value={triggerOnLoad ? "on" : "off"}
            onChange={(v) => setTriggerOnLoad(v === "on")}
          />
        </Field>
        <Field label="Latency comp (ms)">
          <input
            type="number"
            className={inputCls}
            value={latencyMs}
            onChange={(e) => setLatencyMs(Number(e.target.value))}
          />
        </Field>

        {isMidi && (
          <div className="grid grid-cols-3 gap-2">
            <Field label="MIDI ch">
              <input
                type="number"
                min={1}
                max={16}
                className={inputCls}
                value={midiChannel}
                onChange={(e) => setMidiChannel(Number(e.target.value))}
              />
            </Field>
            {type === "programChange" && (
              <Field label="Program">
                <input
                  type="number"
                  className={inputCls}
                  value={midiProgram}
                  onChange={(e) => setMidiProgram(Number(e.target.value))}
                />
              </Field>
            )}
            {type === "cc" && (
              <>
                <Field label="CC #">
                  <input
                    type="number"
                    className={inputCls}
                    value={midiCC}
                    onChange={(e) => setMidiCC(Number(e.target.value))}
                  />
                </Field>
                <Field label="CC value">
                  <input
                    type="number"
                    className={inputCls}
                    value={midiCCValue}
                    onChange={(e) => setMidiCCValue(Number(e.target.value))}
                  />
                </Field>
              </>
            )}
            {(type === "noteOn" || type === "noteOff") && (
              <>
                <Field label="Note">
                  <input
                    type="number"
                    className={inputCls}
                    value={midiNote}
                    onChange={(e) => setMidiNote(Number(e.target.value))}
                  />
                </Field>
                <Field label="Velocity">
                  <input
                    type="number"
                    className={inputCls}
                    value={midiVelocity}
                    onChange={(e) => setMidiVelocity(Number(e.target.value))}
                  />
                </Field>
              </>
            )}
          </div>
        )}

        {type === "http" && (
          <Field label="HTTP URL">
            <input className={inputCls} value={httpUrl} onChange={(e) => setHttpUrl(e.target.value)} />
          </Field>
        )}

        <Button
          variant="primary"
          onPress={() =>
            builder.eventUpdate({
              songIndex,
              index,
              type,
              timeSeconds,
              triggerOnLoad,
              latencyMs,
              midiChannel,
              midiProgram,
              midiCC,
              midiCCValue,
              midiNote,
              midiVelocity,
              httpUrl,
            })
          }
        >
          Apply event
        </Button>
      </Card.Content>
    </Card>
  );
}

// ─── Busses ─────────────────────────────────────────────────────────────────

function BusEditor({ bus, index }: { bus: WebUiState["busses"][number]; index: number }) {
  const [name, setName] = useState(bus.name);
  const [channels, setChannels] = useState(bus.channels);
  const [startChannel, setStartChannel] = useState(bus.startChannel);
  const [gainDb, setGainDb] = useState(bus.gainDb);
  const [mute, setMute] = useState(bus.mute);
  const [solo, setSolo] = useState(bus.solo);
  const [isAux, setIsAux] = useState(bus.isAux);

  return (
    <Card className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <Card.Header className="shrink-0">
        <Card.Title className="text-sm">Bus {index + 1}</Card.Title>
      </Card.Header>
      <Card.Content className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <Field label="Name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Width">
          <ToggleRow
            options={[
              { value: "1", label: "Mono" },
              { value: "2", label: "Stereo" },
            ]}
            value={String(channels)}
            onChange={(v) => setChannels(Number(v))}
          />
        </Field>
        <Field label="Start channel (0-based)">
          <input
            type="number"
            min={0}
            className={inputCls}
            value={startChannel}
            onChange={(e) => setStartChannel(Number(e.target.value))}
          />
        </Field>
        <GainSlider label="Gain" value={gainDb} onChange={setGainDb} />
        <div className="flex gap-1.5">
          <Button size="sm" variant={mute ? "danger" : "outline"} onPress={() => setMute(!mute)}>
            Mute
          </Button>
          <Button size="sm" variant={solo ? "secondary" : "outline"} onPress={() => setSolo(!solo)}>
            Solo
          </Button>
          <Button size="sm" variant={isAux ? "secondary" : "outline"} onPress={() => setIsAux(!isAux)}>
            Aux bus
          </Button>
        </div>
        <Button
          variant="primary"
          onPress={() => builder.busUpdate({ index, name, channels, startChannel, gainDb, mute, solo, isAux })}
        >
          Apply bus
        </Button>
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
  const [tab, setTab] = useState<EditorTab>("timeline");
  const [songContext, setSongContext] = useState(0);
  const [selected, setSelected] = useState(-1);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.songIndex >= 0) setSongContext(state.songIndex);
  }, [state.songCount]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setSelected(-1), [tab]);

  const song = state.songs[songContext] as SongRow | undefined;

  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importFolder, setImportFolder] = useState<string>("");
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  const handleImportFolderClick = () => {
    if (folderInputRef.current) {
      folderInputRef.current.click();
    }
  };

  const handleFolderChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const allFiles = Array.from(e.target.files ?? []).filter((f) =>
      f.name.toLowerCase().endsWith(".wav") ||
      f.name.toLowerCase().endsWith(".mp3") ||
      f.name.toLowerCase().endsWith(".aif") ||
      f.name.toLowerCase().endsWith(".flac")
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
    return <div className="p-6 text-sm text-foreground/50">No project loaded.</div>;
  }

  const TABS: { id: EditorTab; label: string }[] = [
    { id: "timeline", label: "Timeline" },
    { id: "songs", label: "Songs" },
    { id: "tracks", label: "Tracks" },
    { id: "events", label: "Events" },
    { id: "busses", label: "Busses" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3">
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
          Import in progress&hellip; the app is busy.
        </div>
      )}

      {/* Tab Bar */}
      <div className="flex shrink-0 items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          {TABS.map((t) => (
            <Button key={t.id} size="sm" variant={tab === t.id ? "secondary" : "outline"} onPress={() => setTab(t.id)}>
              {t.id === "timeline" && <Gauge size={13} className="mr-1 inline-block" />}
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Song context selector for tracks / events (only if songs exist) */}
      {(tab === "tracks" || tab === "events") && state.songs.length > 0 && (
        <div className="shrink-0">
          <Field label="Song context">
            <select
              className={inputCls}
              value={songContext}
              onChange={(e) => {
                setSongContext(Number(e.target.value));
                setSelected(-1);
              }}
            >
              {state.songs.map((s, i) => (
                <option key={i} value={i}>
                  {i + 1}. {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {/* ── Timeline Tab ──────────────────────────────────────────────── */}
      {tab === "timeline" && (
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

      {/* ── Other tabs ───────────────────────────────────────────────── */}
      {tab !== "timeline" && (
        <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
          {tab === "songs" && (
            <>
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
                emptyHint="No songs yet."
              />
              {selected >= 0 && state.songs[selected] ? (
                <SongEditor key={selected} song={state.songs[selected]} index={selected} />
              ) : (
                <EmptyDetailPanel />
              )}
            </>
          )}

          {tab === "tracks" && (
            <>
              <ListPanel
                title="Global Tracks"
                rows={state.tracks.map((t) => {
                  const region = song?.regions?.find((r) => r.trackId === t.id);
                  return {
                    key: t.id,
                    label: t.name || t.id,
                    sub: `→ ${t.busId || "(sends only)"} · ${t.gainDb.toFixed(1)} dB${
                      region?.file ? ` · Clip: ${region.file.replace(/^Audio\//, "")}` : ""
                    }`,
                  };
                })}
                selected={selected}
                onSelect={setSelected}
                onAdd={() => builder.trackAdd(songContext)}
                onRemove={() => selected >= 0 && builder.trackRemove(songContext, selected)}
                onMove={(d) => selected >= 0 && builder.trackMove(songContext, selected, d)}
                emptyHint="No project tracks yet."
              />
              {selected >= 0 && state.tracks[selected] ? (
                <TrackEditor
                  key={`${songContext}-${selected}`}
                  track={state.tracks[selected]}
                  songIndex={songContext}
                  index={selected}
                  busses={state.busses}
                  busy={state.busy}
                  region={song?.regions?.find((r) => r.trackId === state.tracks[selected].id)}
                />
              ) : (
                <EmptyDetailPanel />
              )}
            </>
          )}

          {tab === "events" && song && (
            <>
              <ListPanel
                title="Events"
                rows={song.events.map((e) => ({
                  key: e.id,
                  label: `${e.timeSeconds.toFixed(2)}s -- ${e.id}`,
                  sub: e.triggerOnLoad ? "(on load)" : undefined,
                }))}
                selected={selected}
                onSelect={setSelected}
                onAdd={() => builder.eventAdd(songContext)}
                onRemove={() => selected >= 0 && builder.eventRemove(songContext, selected)}
                onMove={(d) => selected >= 0 && builder.eventMove(songContext, selected, d)}
                emptyHint="No events in this song yet."
              />
              {selected >= 0 && song.events[selected] ? (
                <EventEditor
                  key={`${songContext}-${selected}`}
                  event={song.events[selected]}
                  songIndex={songContext}
                  index={selected}
                />
              ) : (
                <EmptyDetailPanel />
              )}
            </>
          )}

          {tab === "busses" && (
            <>
              <ListPanel
                title="Busses"
                rows={state.busses.map((b) => ({
                  key: b.id,
                  label: b.name || b.id,
                  sub: `${b.gainDb.toFixed(1)} dB${b.mute ? " · M" : ""}${b.isAux ? " · Aux" : ""}`,
                }))}
                selected={selected}
                onSelect={setSelected}
                onAdd={() => builder.busAdd()}
                onRemove={() => selected >= 0 && builder.busRemove(selected)}
                onMove={(d) => selected >= 0 && builder.busMove(selected, d)}
                emptyHint="No busses yet."
              />
              {selected >= 0 && state.busses[selected] ? (
                <BusEditor key={selected} bus={state.busses[selected]} index={selected} />
              ) : (
                <EmptyDetailPanel />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
