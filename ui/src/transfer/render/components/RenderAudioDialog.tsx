/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import {
  ChevronDown,
  ChevronRight,
  FolderOutput,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AudioRenderOptions } from "@/lib/state/api";
import type { WebUiState } from "@/lib/state/types";
import { Button, Modal, Select, Switch } from "@/components/ui";
import { useAudioRenderJob } from "@/transfer/render/hooks/useAudioRenderJob";
import { useRenderDestination } from "@/transfer/render/hooks/useRenderDestination";
import { RenderDestinationFields } from "@/transfer/render/components/RenderDestinationFields";
import { RenderFormatFields } from "@/transfer/render/components/RenderFormatFields";
import { RenderFormatLabel } from "@/transfer/render/components/RenderFormatLabel";
import {
  estimatedRenderBytes, renderFormatProfile, resolveRenderEncoding,
  type RenderFormat,
} from "@/transfer/render/logic/renderFormats";
import {
  formatBytes,
  formatDuration,
  resolveRange,
  songDuration,
  type RenderOutputChoice,
  type RenderScope,
  type TailPolicy,
} from "@/transfer/render/logic/renderModel";
import {
  Choice,
  Field,
  inputClass,
  NumberField,
  RenderProgress,
  Section,
  SummaryRow,
} from "@/transfer/render/components/RenderFields";

export type RenderDialogIntent =
  | { kind: "generic" }
  | { kind: "all-tracks" }
  | {
      kind: "target";
      targetKind: "master" | "track" | "bus" | "click";
      id?: string;
    };
export function RenderAudioDialog({
  open,
  state,
  intent,
  requestId,
  onClose,
}: {
  open: boolean;
  state: WebUiState;
  intent: RenderDialogIntent;
  requestId: number;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<RenderScope>("song");
  const [songIndex, setSongIndex] = useState(
    String(Math.max(0, state.songIndex)),
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(["master"]),
  );
  const [sampleRate, setSampleRate] = useState(
    resolveRenderEncoding("wav", String(Math.round(state.sampleRate || 48000)), "24").sampleRate,
  );
  const [outputFormat, setOutputFormat] = useState<RenderFormat>("wav");
  const [bitDepth, setBitDepth] = useState<"16" | "24" | "32">("24");
  const [tailPolicy, setTailPolicy] = useState<TailPolicy>("leave");
  const [tailThresholdDb, setTailThresholdDb] = useState("-96");
  const [tailQuietSeconds, setTailQuietSeconds] = useState("0.5");
  const [maxTailSeconds, setMaxTailSeconds] = useState("30");
  const [dither, setDither] = useState<"none" | "tpdf">("none");
  const [normalization, setNormalization] = useState<
    "off" | "overload" | "peak"
  >("off");
  const [normalizationCeilingDb, setNormalizationCeilingDb] = useState("-0.1");
  const [trimOutputLatency, setTrimOutputLatency] = useState(true);
  const [customStart, setCustomStart] = useState("0");
  const [customEnd, setCustomEnd] = useState("0");
  const [fileNamePattern, setFileNamePattern] = useState(
    "{project}_{song}_{stem}",
  );
  const [advanced, setAdvanced] = useState(false);
  const {
    status: renderStatus,
    error,
    clearError,
    setError,
    start: startRender,
    cancel,
  } = useAudioRenderJob(open, requestId, state.songIndex);
  const appliedRequestId = useRef(-1);
  const destination = useRenderDestination(open, requestId, state.settings.renderOutputDirectory);

  const outputs = useMemo<RenderOutputChoice[]>(
    () => [
      {
        key: "master",
        kind: "master",
        label: "Main mix",
        detail: "Post-master stereo output",
      },
      ...state.tracks.map((track) => ({
        key: `track:${track.id}`,
        kind: "track" as const,
        id: track.id,
        label: track.name,
        detail: "Post-track fader tap",
      })),
      ...state.busses
        .filter((bus) => !bus.isDirectOut && bus.id !== "audio::main")
        .map((bus) => ({
          key: `bus:${bus.id}`,
          kind: "bus" as const,
          id: bus.id,
          label: bus.name,
          detail: "Post-bus fader tap",
        })),
      {
        key: "click",
        kind: "click",
        label: "Metronome",
        detail: "Click channel only",
      },
    ],
    [state.tracks, state.busses],
  );

  useEffect(() => {
    if (!open || appliedRequestId.current === requestId) return;
    appliedRequestId.current = requestId;
    if (intent.kind === "all-tracks") {
      setScope("project");
      setSelected(
        new Set(
          outputs
            .filter((output) => output.kind === "track")
            .map((output) => output.key),
        ),
      );
      return;
    }
    if (intent.kind === "target") {
      setScope("song");
      setSongIndex(String(Math.max(0, state.songIndex)));
      const key =
        intent.targetKind === "master" || intent.targetKind === "click"
          ? intent.targetKind
          : `${intent.targetKind}:${intent.id ?? ""}`;
      setSelected(new Set([key]));
      return;
    }
    setScope("song");
    setSongIndex(String(Math.max(0, state.songIndex)));
    setSelected(new Set(["master"]));
  }, [open, requestId, intent, outputs, state.songIndex]);

  useEffect(() => {
    if (open) setSongIndex(String(Math.max(0, state.songIndex)));
  }, [open, state.songIndex]);

  useEffect(() => {
    if (scope === "project" && tailPolicy === "wrap") setTailPolicy("cut");
  }, [scope, tailPolicy]);

  const selectedSong = state.songs[Number(songIndex)];
  const selectedSongDuration = songDuration(selectedSong);
  const cycleAvailable = Boolean(
    state.cycle?.active &&
    !state.cycle.skip &&
    state.cycle.songIndex === Number(songIndex) &&
    state.cycle.endSeconds > state.cycle.startSeconds,
  );
  const range = resolveRange(
    scope,
    selectedSongDuration,
    state,
    Number(songIndex),
    customStart,
    customEnd,
  );
  const selectedOutputs = outputs.filter((output) => selected.has(output.key));
  const upperDuration =
    scope === "project"
      ? state.songs.reduce((sum, song) => sum + songDuration(song), 0)
      : Math.max(0, range.end - range.start);
  const upperTail = tailPolicy === "leave" ? Number(maxTailSeconds) || 0 : 0;
  const formatProfile = renderFormatProfile(outputFormat);
  const estimatedBytes = estimatedRenderBytes(outputFormat, upperDuration + upperTail,
    selectedOutputs.length, Number(sampleRate), bitDepth);

  const toggleOutput = (key: string, enabled: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (enabled) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const applyPreset = (preset: "mix" | "stems" | "loop") => {
    if (preset === "loop") {
      setSelected(new Set(["master"]));
      setScope(cycleAvailable ? "cycle" : "song");
      setTailPolicy("wrap");
      setBitDepth(resolveRenderEncoding(outputFormat, sampleRate, "32").bitDepth);
      setDither("none");
      setNormalization("off");
      return;
    }
    setSelected(
      preset === "mix"
        ? new Set(["master"])
        : new Set(
            outputs
              .filter((output) => output.kind !== "click")
              .map((output) => output.key),
          ),
    );
    setTailPolicy("leave");
    setBitDepth("24");
  };

  const start = async () => {
    if (destination.choosing) return;
    clearError();
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
      outputFormat,
      bitDepth: Number(bitDepth) as 16 | 24 | 32,
      rangeStartSeconds: scope === "project" ? 0 : range.start,
      rangeEndSeconds: scope === "project" ? 0 : range.end,
      tailPolicy,
      tailThresholdDb: Number(tailThresholdDb),
      tailQuietSeconds: Number(tailQuietSeconds),
      maxTailSeconds: Number(maxTailSeconds),
      dither,
      normalization,
      normalizationCeilingDb: Number(normalizationCeilingDb),
      trimOutputLatency,
      fileNamePattern: fileNamePattern.trim() || "{project}_{song}_{stem}",
      outputDirectory: destination.directory,
    };
    await startRender(options);
  };

  if (!open) return null;
  const rendering = renderStatus?.state === "rendering";

  return (
    <Modal
      isOpen={open}
      onOpenChange={(isOpen) => !isOpen && !rendering && onClose()}
    >
      <Modal.Backdrop
        isDismissable={!rendering}
        isKeyboardDismissDisabled={rendering}
      >
        <Modal.Container size="3xl" placement="center">
          <Modal.Dialog
            aria-label="Render"
            className="max-h-[88vh] rounded-xl border border-default/40 p-0 shadow-2xl"
          >
            {!rendering && <Modal.CloseTrigger />}
            <Modal.Header className="items-start border-b border-default/20 px-5 py-4">
              <Modal.Heading className="text-lg font-bold text-foreground">
                Render
              </Modal.Heading>
            </Modal.Header>

            <Modal.Body className="m-0 grid min-h-0 gap-0 overflow-y-auto p-0 md:grid-cols-[minmax(0,1fr)_17rem]">
              <div className="space-y-5 p-5">
                <RenderFormatFields format={outputFormat} sampleRate={sampleRate} bitDepth={bitDepth}
                  onChange={(format, rate, depth) => {
                    setOutputFormat(format);
                    setSampleRate(rate);
                    setBitDepth(depth);
                    if (!renderFormatProfile(format).bitDepths.length || depth === "32") setDither("none");
                    else if (depth !== bitDepth) setDither(depth === "16" ? "tpdf" : "none");
                  }} />
                <Section title="Preset">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onPress={() => applyPreset("mix")}
                    >
                      Quick mixdown
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onPress={() => applyPreset("stems")}
                    >
                      Show backup stems
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onPress={() => applyPreset("loop")}
                    >
                      Loop asset
                    </Button>
                  </div>
                </Section>

                <RenderDestinationFields {...destination} disabled={rendering}
                  onChange={destination.setDirectory} onBrowse={destination.chooseDirectory} />

                <Section title="Range">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Choice
                      active={scope === "song"}
                      onPress={() => setScope("song")}
                    >
                      Song
                    </Choice>
                    <Choice
                      active={scope === "project"}
                      onPress={() => setScope("project")}
                    >
                      Project
                    </Choice>
                    <Choice
                      active={scope === "cycle"}
                      disabled={!cycleAvailable}
                      onPress={() => setScope("cycle")}
                    >
                      Cycle
                    </Choice>
                    <Choice
                      active={scope === "custom"}
                      onPress={() => setScope("custom")}
                    >
                      Custom
                    </Choice>
                  </div>
                  {scope !== "project" && (
                    <Select
                      size="sm"
                      value={songIndex}
                      onChange={setSongIndex}
                      options={state.songs.map((song, index) => ({
                        id: String(index),
                        label: `${index + 1}. ${song.name}`,
                      }))}
                    />
                  )}
                  {scope === "custom" && (
                    <div className="grid grid-cols-2 gap-3">
                      <NumberField
                        label="From (seconds)"
                        value={customStart}
                        onChange={setCustomStart}
                        min={0}
                      />
                      <NumberField
                        label="To (seconds)"
                        value={customEnd}
                        onChange={setCustomEnd}
                        min={0}
                      />
                    </div>
                  )}
                </Section>

                <Section
                  title="Outputs"
                  aside={`${selectedOutputs.length} selected`}
                >
                  <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-default/20 p-2">
                    {outputs.map((output) => (
                      <Switch
                        key={output.key}
                        isSelected={selected.has(output.key)}
                        onChange={(enabled) =>
                          toggleOutput(output.key, enabled)
                        }
                        className="w-full"
                      >
                        <span className="flex min-w-0 flex-col text-left">
                          <span className="truncate text-xs font-semibold">
                            {output.label}
                          </span>
                          <span className="truncate text-[10px] text-foreground/45">
                            {output.detail}
                          </span>
                        </span>
                      </Switch>
                    ))}
                  </div>
                  <p className="text-[10px] text-foreground/45">
                    All selected taps are captured in one graph pass; stems are
                    not produced by changing solo state.
                  </p>
                </Section>

                <Section title="Tail">
                  <div className="grid grid-cols-3 gap-2">
                    <Choice
                      active={tailPolicy === "cut"}
                      onPress={() => setTailPolicy("cut")}
                    >
                      Cut
                    </Choice>
                    <Choice
                      active={tailPolicy === "leave"}
                      onPress={() => setTailPolicy("leave")}
                    >
                      Leave
                    </Choice>
                    <Choice
                      active={tailPolicy === "wrap"}
                      disabled={scope === "project"}
                      onPress={() => setTailPolicy("wrap")}
                    >
                      Wrap
                    </Choice>
                  </div>
                  <p className="text-[10px] text-foreground/45">
                    Wrap primes the complete range once without writing, then
                    records the second pass with processor state carried across
                    the boundary.
                  </p>
                </Section>

                <button
                  type="button"
                  className="flex items-center gap-1 text-xs font-semibold text-foreground/65"
                  onClick={() => setAdvanced((value) => !value)}
                >
                  {advanced ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}{" "}
                  Advanced
                </button>
                {advanced && (
                  <div className="grid grid-cols-1 gap-3 rounded-lg border border-default/20 bg-default/10 p-3 sm:grid-cols-3">
                    <NumberField
                      label="Tail threshold (dBFS)"
                      value={tailThresholdDb}
                      onChange={setTailThresholdDb}
                      min={-144}
                      max={-24}
                      disabled={tailPolicy !== "leave"}
                    />
                    <NumberField
                      label="Quiet hold (seconds)"
                      value={tailQuietSeconds}
                      onChange={setTailQuietSeconds}
                      min={0.05}
                      max={10}
                      step={0.05}
                      disabled={tailPolicy !== "leave"}
                    />
                    <NumberField
                      label="Maximum tail (seconds)"
                      value={maxTailSeconds}
                      onChange={setMaxTailSeconds}
                      min={0}
                      max={60}
                      step={0.5}
                      disabled={tailPolicy !== "leave"}
                    />
                    <Field label="Dither">
                      <Select
                        size="sm"
                        value={dither}
                        isDisabled={bitDepth === "32" || !formatProfile.bitDepths.length}
                        onChange={(value) =>
                          setDither(value as "none" | "tpdf")
                        }
                        options={[
                          { id: "none", label: "None" },
                          { id: "tpdf", label: "TPDF" },
                        ]}
                      />
                    </Field>
                    <Field label="Normalize">
                      <Select
                        size="sm"
                        value={normalization}
                        onChange={(value) =>
                          setNormalization(value as "off" | "overload" | "peak")
                        }
                        options={[
                          { id: "off", label: "Off" },
                          { id: "overload", label: "Overload protection" },
                          { id: "peak", label: "Peak normalize" },
                        ]}
                      />
                    </Field>
                    <NumberField
                      label="Target peak (dBFS)"
                      value={normalizationCeilingDb}
                      onChange={setNormalizationCeilingDb}
                      min={-12}
                      max={0}
                      step={0.1}
                      disabled={normalization === "off"}
                    />
                    <Switch
                      isSelected={trimOutputLatency}
                      isDisabled={tailPolicy === "wrap"}
                      onChange={setTrimOutputLatency}
                      className="sm:col-span-3"
                    >
                      <span className="flex flex-col text-left">
                        <span className="text-xs font-semibold">
                          Trim plug-in delay
                        </span>
                        <span className="text-[10px] text-foreground/45">
                          Keep all selected stems sample-aligned and remove
                          their common PDC startup silence. Wrap is primed by
                          its first pass.
                        </span>
                      </span>
                    </Switch>
                    <div className="sm:col-span-3">
                      <Field label="Filename pattern">
                        <input
                          value={fileNamePattern}
                          onChange={(event) =>
                            setFileNamePattern(event.target.value)
                          }
                          className={inputClass}
                        />
                        <span className="mt-1 block text-[10px] text-foreground/40">
                          Tokens: {"{project}"} {"{song}"} {"{stem}"}{" "}
                          {"{sampleRate}"} {"{bitDepth}"}
                        </span>
                      </Field>
                    </div>
                  </div>
                )}
              </div>

              <aside className="space-y-4 border-t border-default/20 bg-default/10 p-5 md:border-l md:border-t-0">
                <div className="flex items-center gap-2 text-sm font-bold">
                  <FolderOutput size={17} /> Summary
                </div>
                <SummaryRow
                  label="Files"
                  value={String(selectedOutputs.length)}
                />
                <SummaryRow label="Format" value={<RenderFormatLabel format={outputFormat} />} />
                <SummaryRow
                  label="Range"
                  value={formatDuration(upperDuration)}
                />
                <SummaryRow
                  label="Estimated size"
                  value={formatBytes(estimatedBytes)}
                />
                <SummaryRow label="Destination" value={<span className="break-all">
                  {destination.directory || "Core Exports folder"}
                </span>} />
                <div className="rounded-lg border border-default/20 bg-surface/60 p-3 text-[10px] leading-relaxed text-foreground/55">
                  Rendering runs on the Core in the background and does not stop
                  the live transport. In a remote session, output paths belong
                  to the playback computer.
                </div>
                {renderStatus && renderStatus.state !== "idle" && (
                  <RenderProgress status={renderStatus} />
                )}
                {error && (
                  <div className="rounded-lg bg-danger/10 p-3 text-xs text-danger">
                    {error}
                  </div>
                )}
              </aside>
            </Modal.Body>

            <Modal.Footer className="flex justify-end gap-2 border-t border-default/20 px-5 py-4">
              {rendering ? (
                <Button variant="danger-soft" onPress={() => void cancel()}>
                  Cancel render
                </Button>
              ) : (
                <Button variant="ghost" onPress={onClose}>
                  Close
                </Button>
              )}
              <Button
                tone="accent-soft"
                isDisabled={
                  rendering ||
                  destination.choosing ||
                  state.songs.length === 0 ||
                  selectedOutputs.length === 0
                }
                onPress={() => void start()}
              >
                {rendering
                  ? `Rendering ${Math.round((renderStatus?.progress ?? 0) * 100)}%`
                  : `Export ${selectedOutputs.length || ""} ${formatProfile.label} ${selectedOutputs.length === 1 ? "file" : "files"}`}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
