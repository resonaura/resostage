import { AudioLines } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { audioRender, type AudioRenderOptions, type AudioRenderStatus } from "../lib/api";
import type { WebUiState } from "../lib/types";
import { Button, Modal, Select } from "./ui";

export function RenderAudioDialog({
  open,
  state,
  onClose,
}: {
  open: boolean;
  state: WebUiState;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"song" | "project">("song");
  const [songIndex, setSongIndex] = useState(String(Math.max(0, state.songIndex)));
  const [target, setTarget] = useState("master");
  const [sampleRate, setSampleRate] = useState(String(Math.round(state.sampleRate || 48000)));
  const [bitDepth, setBitDepth] = useState("24");
  const [tailSeconds, setTailSeconds] = useState("0");
  const [fileName, setFileName] = useState("");
  const [renderStatus, setRenderStatus] = useState<AudioRenderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targetOptions = useMemo(
    () => [
      { id: "master", label: "Main mix" },
      { id: "click", label: "Metronome only" },
      ...state.tracks.map((track) => ({ id: `track:${track.id}`, label: `Track — ${track.name}` })),
      ...state.busses
        .filter((bus) => !bus.isDirectOut && bus.id !== "audio::main")
        .map((bus) => ({ id: `bus:${bus.id}`, label: `Bus — ${bus.name}` })),
    ],
    [state.tracks, state.busses],
  );

  useEffect(() => {
    if (!open || renderStatus?.state !== "rendering") return;
    const timer = setInterval(() => {
      void audioRender.status().then(setRenderStatus).catch((e) => setError(String(e)));
    }, 400);
    return () => clearInterval(timer);
  }, [open, renderStatus?.state]);

  useEffect(() => {
    if (!open) return;
    void audioRender.status().then((status) => {
      if (status.state !== "idle") setRenderStatus(status);
    }).catch(() => {});
  }, [open]);

  const start = async () => {
    setError(null);
    const [targetKind, targetId] = target.includes(":")
      ? (target.split(/:(.*)/s).slice(0, 2) as ["track" | "bus", string])
      : [target as "master" | "click", ""];
    const options: AudioRenderOptions = {
      scope,
      songIndex: Number(songIndex),
      target: targetKind,
      targetId,
      sampleRate: Number(sampleRate),
      bitDepth: Number(bitDepth) as 16 | 24 | 32,
      tailSeconds: Number(tailSeconds),
      fileName: fileName.trim(),
    };
    try {
      await audioRender.start(options);
      setRenderStatus({ state: "rendering", progress: 0, outputPath: "", error: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!open) return null;
  const rendering = renderStatus?.state === "rendering";

  return (
    <Modal isOpen={open} onOpenChange={(isOpen) => !isOpen && !rendering && onClose()}>
      <Modal.Backdrop isDismissable={!rendering} isKeyboardDismissDisabled={rendering}>
        <Modal.Container size="lg" placement="center">
          <Modal.Dialog aria-label="Render audio" className="rounded-xl border border-default/40 p-4 shadow-2xl">
            <Modal.Header className="flex items-center gap-2 border-b border-default/20 pb-3 text-lg font-bold text-accent">
              <AudioLines size={20} /> Render audio
            </Modal.Header>
            <Modal.Body className="space-y-4 py-4">
              <p className="text-xs text-foreground/55">
                Offline render uses the live mixer graph, including faders, pan, mute/solo, sends, bus routing, region fades, loops, speed and pitch.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Range">
                  <Select size="sm" value={scope} onChange={(v) => setScope(v as "song" | "project")} options={[
                    { id: "song", label: "One song" },
                    { id: "project", label: "Whole project" },
                  ]} />
                </Field>
                <Field label="Song">
                  <Select size="sm" value={songIndex} isDisabled={scope === "project"} onChange={setSongIndex}
                    options={state.songs.map((song, index) => ({ id: String(index), label: `${index + 1}. ${song.name}` }))} />
                </Field>
                <Field label="Source">
                  <Select size="sm" value={target} onChange={setTarget} options={targetOptions} />
                </Field>
                <Field label="Filename">
                  <input value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder={`${state.projectName || "Render"}.wav`}
                    className="h-8 w-full rounded-lg border border-default/30 bg-default/20 px-3 text-xs outline-none focus:border-accent" />
                </Field>
                <Field label="Sample rate">
                  <Select size="sm" value={sampleRate} onChange={setSampleRate} options={[44100, 48000, 88200, 96000, 192000].map((n) => ({ id: String(n), label: `${n / 1000} kHz` }))} />
                </Field>
                <Field label="Format">
                  <Select size="sm" value={bitDepth} onChange={setBitDepth} options={[
                    { id: "16", label: "16-bit PCM" }, { id: "24", label: "24-bit PCM" }, { id: "32", label: "32-bit float" },
                  ]} />
                </Field>
                <Field label="Tail after song">
                  <Select size="sm" value={tailSeconds} onChange={setTailSeconds} options={[0, 1, 2, 5, 10].map((n) => ({ id: String(n), label: n === 0 ? "None" : `${n} s` }))} />
                </Field>
              </div>
              {renderStatus && renderStatus.state !== "idle" && (
                <div className="rounded-lg border border-default/20 bg-default/10 p-3">
                  {renderStatus.state === "rendering" && (
                    <div className="h-2 overflow-hidden rounded-full bg-default/25" aria-label="Render progress">
                      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(renderStatus.progress * 100)}%` }} />
                    </div>
                  )}
                  {renderStatus.state === "complete" && <div className="text-xs text-success">Complete: <span className="font-mono">{renderStatus.outputPath}</span></div>}
                  {renderStatus.state === "failed" && <div className="text-xs text-danger">{renderStatus.error || "Render failed"}</div>}
                </div>
              )}
              {error && <div className="text-xs text-danger">{error}</div>}
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2 border-t border-default/20 pt-3">
              <Button variant="ghost" isDisabled={rendering} onPress={onClose}>Close</Button>
              <Button tone="accent-soft" isDisabled={rendering || state.songs.length === 0} onPress={() => void start()}>
                {rendering ? `Rendering ${Math.round((renderStatus?.progress ?? 0) * 100)}%` : "Render WAV"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="space-y-1"><span className="block text-[10px] font-semibold uppercase text-foreground/45">{label}</span>{children}</label>;
}
