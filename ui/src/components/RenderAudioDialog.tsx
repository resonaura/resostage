import { AudioLines, ChevronDown, ChevronRight, FolderOutput, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { audioRender, type AudioRenderOptions, type AudioRenderStatus } from "../lib/api";
import type { WebUiState } from "../lib/types";
import { Button, Modal, Select, Switch } from "./ui";

type Scope = "song" | "project" | "cycle" | "custom";
type TailPolicy = "cut" | "leave";
type OutputChoice = {
  key: string;
  kind: "master" | "track" | "bus" | "click";
  id?: string;
  label: string;
  detail: string;
};

const initialStatus: AudioRenderStatus = {
  state: "rendering", progress: 0, outputPath: "", outputPaths: [], error: "",
};

export function RenderAudioDialog({ open, state, onClose }: {
  open: boolean;
  state: WebUiState;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<Scope>("song");
  const [songIndex, setSongIndex] = useState(String(Math.max(0, state.songIndex)));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(["master"]));
  const [sampleRate, setSampleRate] = useState(String(Math.round(state.sampleRate || 48000)));
  const [bitDepth, setBitDepth] = useState<"16" | "24" | "32">("24");
  const [tailPolicy, setTailPolicy] = useState<TailPolicy>("leave");
  const [tailThresholdDb, setTailThresholdDb] = useState("-96");
  const [tailQuietSeconds, setTailQuietSeconds] = useState("0.5");
  const [maxTailSeconds, setMaxTailSeconds] = useState("30");
  const [customStart, setCustomStart] = useState("0");
  const [customEnd, setCustomEnd] = useState("0");
  const [fileNamePattern, setFileNamePattern] = useState("{project}_{song}_{stem}");
  const [advanced, setAdvanced] = useState(false);
  const [renderStatus, setRenderStatus] = useState<AudioRenderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const outputs = useMemo<OutputChoice[]>(() => [
    { key: "master", kind: "master", label: "Main mix", detail: "Post-master stereo output" },
    ...state.tracks.map((track) => ({ key: `track:${track.id}`, kind: "track" as const, id: track.id, label: track.name, detail: "Post-track fader tap" })),
    ...state.busses.filter((bus) => !bus.isDirectOut && bus.id !== "audio::main").map((bus) => ({ key: `bus:${bus.id}`, kind: "bus" as const, id: bus.id, label: bus.name, detail: "Post-bus fader tap" })),
    { key: "click", kind: "click", label: "Metronome", detail: "Click channel only" },
  ], [state.tracks, state.busses]);

  useEffect(() => {
    if (!open || renderStatus?.state !== "rendering") return;
    const timer = setInterval(() => {
      void audioRender.status().then(setRenderStatus).catch((e) => setError(String(e)));
    }, 350);
    return () => clearInterval(timer);
  }, [open, renderStatus?.state]);

  useEffect(() => {
    if (!open) return;
    setSongIndex(String(Math.max(0, state.songIndex)));
    void audioRender.status().then((status) => {
      if (status.state !== "idle") setRenderStatus(status);
    }).catch(() => {});
  }, [open, state.songIndex]);

  const selectedSong = state.songs[Number(songIndex)];
  const selectedSongDuration = songDuration(selectedSong);
  const cycleAvailable = Boolean(state.cycle?.active && !state.cycle.skip
    && state.cycle.songIndex === Number(songIndex)
    && state.cycle.endSeconds > state.cycle.startSeconds);
  const range = resolveRange(scope, selectedSongDuration, state, Number(songIndex), customStart, customEnd);
  const selectedOutputs = outputs.filter((output) => selected.has(output.key));
  const upperDuration = scope === "project"
    ? state.songs.reduce((sum, song) => sum + songDuration(song), 0)
    : Math.max(0, range.end - range.start);
  const upperTail = tailPolicy === "leave" ? Number(maxTailSeconds) || 0 : 0;
  const estimatedBytes = selectedOutputs.length * (upperDuration + upperTail)
    * Number(sampleRate) * 2 * (Number(bitDepth) / 8);

  const toggleOutput = (key: string, enabled: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (enabled) next.add(key); else next.delete(key);
      return next;
    });
  };

  const applyPreset = (preset: "mix" | "stems") => {
    setSelected(preset === "mix"
      ? new Set(["master"])
      : new Set(outputs.filter((output) => output.kind !== "click").map((output) => output.key)));
    setTailPolicy("leave");
    setBitDepth("24");
  };

  const start = async () => {
    setError(null);
    if (selectedOutputs.length === 0) {
      setError("Select at least one output.");
      return;
    }
    if ((scope === "custom" || scope === "cycle") && range.end <= range.start) {
      setError("The render range must end after it starts.");
      return;
    }
    const options: AudioRenderOptions = {
      scope,
      songIndex: Number(songIndex),
      targets: selectedOutputs.map(({ kind, id }) => ({ kind, id })),
      sampleRate: Number(sampleRate),
      bitDepth: Number(bitDepth) as 16 | 24 | 32,
      rangeStartSeconds: scope === "project" ? 0 : range.start,
      rangeEndSeconds: scope === "project" ? 0 : range.end,
      tailPolicy,
      tailThresholdDb: Number(tailThresholdDb),
      tailQuietSeconds: Number(tailQuietSeconds),
      maxTailSeconds: Number(maxTailSeconds),
      fileNamePattern: fileNamePattern.trim() || "{project}_{song}_{stem}",
    };
    try {
      await audioRender.start(options);
      setRenderStatus(initialStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancel = async () => {
    try { await audioRender.cancel(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (!open) return null;
  const rendering = renderStatus?.state === "rendering";

  return (
    <Modal isOpen={open} onOpenChange={(isOpen) => !isOpen && !rendering && onClose()}>
      <Modal.Backdrop isDismissable={!rendering} isKeyboardDismissDisabled={rendering}>
        <Modal.Container size="lg" placement="center">
          <Modal.Dialog aria-label="Render and export audio" className="max-h-[88vh] rounded-xl border border-default/40 p-0 shadow-2xl">
            <Modal.Header className="flex items-center justify-between border-b border-default/20 px-5 py-4">
              <div className="flex items-center gap-2 text-lg font-bold text-accent"><AudioLines size={20} /> Render / Export</div>
              {!rendering && <Button isIconOnly size="sm" variant="ghost" aria-label="Close" onPress={onClose}><X size={16} /></Button>}
            </Modal.Header>

            <Modal.Body className="grid min-h-0 gap-0 overflow-y-auto p-0 md:grid-cols-[minmax(0,1fr)_17rem]">
              <div className="space-y-5 p-5">
                <Section title="Preset"><div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onPress={() => applyPreset("mix")}>Quick mixdown</Button>
                  <Button size="sm" variant="outline" onPress={() => applyPreset("stems")}>Show backup stems</Button>
                </div></Section>

                <Section title="Range">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Choice active={scope === "song"} onPress={() => setScope("song")}>Song</Choice>
                    <Choice active={scope === "project"} onPress={() => setScope("project")}>Project</Choice>
                    <Choice active={scope === "cycle"} disabled={!cycleAvailable} onPress={() => setScope("cycle")}>Cycle</Choice>
                    <Choice active={scope === "custom"} onPress={() => setScope("custom")}>Custom</Choice>
                  </div>
                  {scope !== "project" && <Select size="sm" value={songIndex} onChange={setSongIndex} options={state.songs.map((song, index) => ({ id: String(index), label: `${index + 1}. ${song.name}` }))} />}
                  {scope === "custom" && <div className="grid grid-cols-2 gap-3">
                    <NumberField label="From (seconds)" value={customStart} onChange={setCustomStart} min={0} />
                    <NumberField label="To (seconds)" value={customEnd} onChange={setCustomEnd} min={0} />
                  </div>}
                </Section>

                <Section title="Outputs" aside={`${selectedOutputs.length} selected`}>
                  <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-default/20 p-2">
                    {outputs.map((output) => <Switch key={output.key} isSelected={selected.has(output.key)} onChange={(enabled) => toggleOutput(output.key, enabled)} className="w-full">
                      <span className="flex min-w-0 flex-col text-left"><span className="truncate text-xs font-semibold">{output.label}</span><span className="truncate text-[10px] text-foreground/45">{output.detail}</span></span>
                    </Switch>)}
                  </div>
                  <p className="text-[10px] text-foreground/45">All selected taps are captured in one graph pass; stems are not produced by changing solo state.</p>
                </Section>

                <Section title="Format"><div className="grid grid-cols-2 gap-3">
                  <Field label="Sample rate"><Select size="sm" value={sampleRate} onChange={setSampleRate} options={[44100, 48000, 88200, 96000, 192000].map((n) => ({ id: String(n), label: `${n / 1000} kHz` }))} /></Field>
                  <Field label="WAV encoding"><Select size="sm" value={bitDepth} onChange={(v) => setBitDepth(v as "16" | "24" | "32")} options={[{ id: "16", label: "16-bit PCM" }, { id: "24", label: "24-bit PCM" }, { id: "32", label: "32-bit float" }]} /></Field>
                </div></Section>

                <Section title="Tail">
                  <div className="grid grid-cols-2 gap-2"><Choice active={tailPolicy === "cut"} onPress={() => setTailPolicy("cut")}>Cut at range end</Choice><Choice active={tailPolicy === "leave"} onPress={() => setTailPolicy("leave")}>Leave natural tail</Choice></div>
                  <p className="text-[10px] text-foreground/45">Wrap is unavailable until it can use a correct stateful second pass instead of a destructive post-sum trick.</p>
                </Section>

                <button type="button" className="flex items-center gap-1 text-xs font-semibold text-foreground/65" onClick={() => setAdvanced((value) => !value)}>{advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Advanced</button>
                {advanced && <div className="grid grid-cols-1 gap-3 rounded-lg border border-default/20 bg-default/10 p-3 sm:grid-cols-3">
                  <NumberField label="Tail threshold (dBFS)" value={tailThresholdDb} onChange={setTailThresholdDb} min={-144} max={-24} disabled={tailPolicy === "cut"} />
                  <NumberField label="Quiet hold (seconds)" value={tailQuietSeconds} onChange={setTailQuietSeconds} min={0.05} max={10} step={0.05} disabled={tailPolicy === "cut"} />
                  <NumberField label="Maximum tail (seconds)" value={maxTailSeconds} onChange={setMaxTailSeconds} min={0} max={60} step={0.5} disabled={tailPolicy === "cut"} />
                  <div className="sm:col-span-3"><Field label="Filename pattern"><input value={fileNamePattern} onChange={(event) => setFileNamePattern(event.target.value)} className={inputClass} /><span className="mt-1 block text-[10px] text-foreground/40">Tokens: {'{project}'} {'{song}'} {'{stem}'}</span></Field></div>
                </div>}
              </div>

              <aside className="space-y-4 border-t border-default/20 bg-default/10 p-5 md:border-l md:border-t-0">
                <div className="flex items-center gap-2 text-sm font-bold"><FolderOutput size={17} /> Summary</div>
                <SummaryRow label="Files" value={String(selectedOutputs.length)} />
                <SummaryRow label="Range" value={formatDuration(upperDuration)} />
                <SummaryRow label="Maximum size" value={formatBytes(estimatedBytes)} />
                <SummaryRow label="Destination" value="Core Exports folder" />
                <div className="rounded-lg border border-default/20 bg-surface/60 p-3 text-[10px] leading-relaxed text-foreground/55">Rendering runs on the Core in the background and does not stop the live transport. In a remote session, output paths belong to the playback computer.</div>
                {renderStatus && renderStatus.state !== "idle" && <RenderProgress status={renderStatus} />}
                {error && <div className="rounded-lg bg-danger/10 p-3 text-xs text-danger">{error}</div>}
              </aside>
            </Modal.Body>

            <Modal.Footer className="flex justify-end gap-2 border-t border-default/20 px-5 py-4">
              {rendering ? <Button variant="danger-soft" onPress={() => void cancel()}>Cancel render</Button> : <Button variant="ghost" onPress={onClose}>Close</Button>}
              <Button tone="accent-soft" isDisabled={rendering || state.songs.length === 0 || selectedOutputs.length === 0} onPress={() => void start()}>{rendering ? `Rendering ${Math.round((renderStatus?.progress ?? 0) * 100)}%` : `Render ${selectedOutputs.length || ""} WAV${selectedOutputs.length === 1 ? "" : "s"}`}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function Section({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  return <section className="space-y-2"><div className="flex items-center justify-between"><h3 className="text-[11px] font-bold uppercase tracking-wide text-foreground/55">{title}</h3>{aside && <span className="text-[10px] text-foreground/40">{aside}</span>}</div>{children}</section>;
}

function Choice({ active, disabled, onPress, children }: { active: boolean; disabled?: boolean; onPress: () => void; children: React.ReactNode }) {
  return <Button size="sm" variant={active ? "accent-soft" : "outline"} isDisabled={disabled} onPress={onPress} className="w-full">{children}</Button>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="space-y-1"><span className="block text-[10px] font-semibold uppercase text-foreground/45">{label}</span>{children}</label>;
}

const inputClass = "h-8 w-full rounded-lg border border-default/30 bg-default/20 px-3 text-xs outline-none focus:border-accent disabled:opacity-40";

function NumberField({ label, value, onChange, min, max, step = 0.001, disabled }: { label: string; value: string; onChange: (value: string) => void; min?: number; max?: number; step?: number; disabled?: boolean }) {
  return <Field label={label}><input type="number" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={inputClass} /></Field>;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-3 text-xs"><span className="text-foreground/45">{label}</span><span className="max-w-[10rem] text-right font-semibold">{value}</span></div>;
}

function RenderProgress({ status }: { status: AudioRenderStatus }) {
  return <div className="space-y-2 rounded-lg border border-default/20 bg-surface/60 p-3">
    {status.state === "rendering" && <><div className="flex justify-between text-[10px]"><span>Rendering</span><span>{Math.round(status.progress * 100)}%</span></div><div className="h-2 overflow-hidden rounded-full bg-default/25"><div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(status.progress * 100)}%` }} /></div></>}
    {status.state === "complete" && <><div className="text-xs font-semibold text-success">Render complete</div><div className="max-h-28 space-y-1 overflow-y-auto">{(status.outputPaths?.length ? status.outputPaths : [status.outputPath]).map((path) => <div key={path} className="break-all font-mono text-[9px] text-foreground/55">{path}</div>)}</div></>}
    {status.state === "cancelled" && <div className="text-xs text-warning">Render cancelled. Partial files were removed.</div>}
    {status.state === "failed" && <div className="text-xs text-danger">{status.error || "Render failed"}</div>}
  </div>;
}

function songDuration(song: WebUiState["songs"][number] | undefined): number {
  if (!song) return 0;
  if ((song.endSeconds ?? 0) > 0) return song.endSeconds ?? 0;
  return Math.max(0, ...(song.regions ?? []).map((region) => region.startSeconds + region.durationSeconds), ...song.events.map((event) => event.timeSeconds));
}

function resolveRange(scope: Scope, songEnd: number, state: WebUiState, songIndex: number, customStart: string, customEnd: string) {
  if (scope === "cycle" && state.cycle?.songIndex === songIndex) return { start: state.cycle.startSeconds, end: state.cycle.endSeconds };
  if (scope === "custom") return { start: Math.max(0, Number(customStart) || 0), end: Math.min(songEnd, Math.max(0, Number(customEnd) || 0)) };
  return { start: 0, end: songEnd };
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
