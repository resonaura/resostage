/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useMemo, useState } from "react";
import {
  adaptMidiTracksToSongTempo,
  midiSecondsAtBeat,
  midiTempoDiffersFromSong,
  parseStandardMidiFile,
  songSecondsAtBeat,
  type ImportedMidiFile,
} from "@/lib/midi/standardMidiFile";
import { builder } from "@/lib/state/api";
import type { WebUiState } from "@/lib/state/types";
import { Button, Modal } from "@/components/ui";
import {
  assertMidiBatchContentItemLimit,
  assertMidiBatchEventDataLimit,
  assertMidiRegionEventDataLimits,
  buildMidiRegionImportPatch,
  countMidiContentItems,
  countMidiEventDataBytes,
} from "@/transfer/midi/logic/importBatch";
import { buildImportedSongTiming } from "@/transfer/midi/logic/importTiming";

export type MidiTempoChoice = "keep-beats" | "fit-project-tempo" | "use-midi-tempo";

export function ImportMidiDialog({
  open, files, state, target, onClose,
}: {
  open: boolean;
  files: File[];
  state: WebUiState;
  target?: { songIndex: number; trackId?: string; startBeats?: number };
  onClose: () => void;
}) {
  const [parsed, setParsed] = useState<Array<{ file: File; midi: ImportedMidiFile }> | null>(null);
  const [failure, setFailure] = useState("");
  const [choice, setChoice] = useState<MidiTempoChoice>("keep-beats");
  const [sequenceIndex, setSequenceIndex] = useState(0);
  const [trackId, setTrackId] = useState(target?.trackId ?? "");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const song = state.songs[target?.songIndex ?? state.songIndex];
  const midiTracks = useMemo(() => state.tracks.filter((track) =>
    ["instrument", "midi", "externalMidi"].includes(track.kind ?? "")), [state.tracks]);

  useEffect(() => {
    if (!open) return;
    setTrackId(target?.trackId ?? midiTracks.find((track) => track.id === state.activeTrackId)?.id ?? midiTracks[0]?.id ?? "");
  }, [open, target?.trackId, midiTracks, state.activeTrackId]);

  useEffect(() => {
    if (!open) return;
    setParsed(null);
    setFailure("");
    setProgress("");
    setChoice("keep-beats");
    setSequenceIndex(0);
    let cancelled = false;
    void (async () => {
      try {
        if (!files.length) throw new Error("No MIDI files selected");
        if (files.length > 128) throw new Error("Import at most 128 MIDI files at a time");
        const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        if (totalBytes > 128 * 1024 * 1024) throw new Error("The selected MIDI files exceed the 128 MiB batch limit");
        const batch: Array<{ file: File; midi: ImportedMidiFile }> = [];
        let totalContentItems = 0;
        let totalEventDataBytes = 0;
        for (const file of files) {
          if (cancelled) return;
          if (file.size > 32 * 1024 * 1024) throw new Error(`${file.name}: MIDI file exceeds 32 MiB`);
          const data = await file.arrayBuffer();
          if (cancelled) return;
          const midi = parseStandardMidiFile(new Uint8Array(data));
          totalContentItems += countMidiContentItems(midi);
          assertMidiBatchContentItemLimit(totalContentItems);
          totalEventDataBytes += countMidiEventDataBytes(midi);
          assertMidiBatchEventDataLimit(totalEventDataBytes);
          assertMidiRegionEventDataLimits(midi.tracks, file.name);
          batch.push({ file, midi });
        }
        if (batch.length > 1 && batch.some(({ midi }) => midi.format === 2))
          throw new Error("SMF Format 2 contains independent sequences with separate tempo maps. Import one Format 2 file at a time and choose a sequence explicitly.");
        if (batch.some(({ midi }) => !midi.tracks.some((track) => track.notes.length || track.events?.length || track.umpEvents?.length)))
          throw new Error("Every imported MIDI file must contain at least one note or MIDI event track");
        if (!cancelled) setParsed(batch);
      } catch (cause) {
        if (!cancelled) setFailure(cause instanceof Error ? cause.message : "MIDI import failed");
      }
    })();
    return () => { cancelled = true; };
  }, [open, files]);

  const format2File = parsed?.length === 1 && parsed[0].midi.format === 2 ? parsed[0] : undefined;
  const selectedSequence = format2File?.midi.tracks[Math.min(sequenceIndex, format2File.midi.tracks.length - 1)];
  const selectedTempoEvents = selectedSequence?.tempoEvents ?? format2File?.midi.tempoEvents;
  const selectedMeterEvents = selectedSequence?.meterEvents ?? format2File?.midi.meterEvents;
  const hasTempoMismatch = Boolean(song && parsed?.some(({ midi }) => {
    const tempos = midi.format === 2 && selectedSequence ? selectedSequence.tempoEvents ?? [] : midi.tempoEvents;
    return midiTempoDiffersFromSong(tempos, song);
  }));
  const canUseImportedTempo = Boolean(parsed && parsed.length === 1);

  const doImport = async () => {
    if (!parsed || !song || !trackId) return;
    const destinationTrack = state.tracks.find((track) => track.id === trackId);
    if (!destinationTrack || !["instrument", "midi", "externalMidi"].includes(destinationTrack.kind ?? "")) {
      setFailure("Choose an instrument or MIDI track");
      return;
    }
    setBusy(true);
    setFailure("");
    let cursor = Math.max(0, target?.startBeats ?? 0);
    let endSeconds = Math.max(0, song.endSeconds ?? 0);
    let activeTempoSong = song;
    try {
      let tempoUpdate: { bpm: number; tempoPoints: ReturnType<typeof buildImportedSongTiming>["tempoPoints"];
        signaturePoints: ReturnType<typeof buildImportedSongTiming>["signaturePoints"] } | null = null;
      if (choice === "use-midi-tempo" && parsed.length === 1) {
        const sourceSong = parsed[0].midi;
        const sourceTempoEvents = sourceSong.format === 2 ? selectedTempoEvents ?? [] : sourceSong.tempoEvents;
        const sourceMeterEvents = sourceSong.format === 2 ? selectedMeterEvents ?? [] : sourceSong.meterEvents;
        const importedTiming = buildImportedSongTiming(sourceTempoEvents, sourceMeterEvents);
        const { bpm, tempoPoints, signaturePoints } = importedTiming;
        activeTempoSong = { ...song, bpm, tempoPoints, signaturePoints };
        tempoUpdate = { bpm, tempoPoints, signaturePoints };
      }

      const plans: Array<{
        file: File;
        patch: ReturnType<typeof buildMidiRegionImportPatch>;
      }> = [];
      for (let index = 0; index < parsed.length; index++) {
        const { file, midi } = parsed[index];
        const sourceTempoEvents = midi.format === 2 && selectedSequence ? selectedSequence.tempoEvents ?? [] : midi.tempoEvents;
        const selectedTracks = midi.format === 2 && selectedSequence ? [selectedSequence] : midi.tracks;
        const sourceTracks = selectedTracks.filter((track) => track.notes.length > 0 || track.events?.length || track.umpEvents?.length);
        const sourceEnd = Math.max(1, ...sourceTracks.map((track) => track.durationBeats));
        const originalDurationSeconds = midiSecondsAtBeat(sourceTempoEvents, sourceEnd);
        const convertedTracks = choice === "fit-project-tempo"
          ? adaptMidiTracksToSongTempo(sourceTracks, sourceTempoEvents, song)
          : sourceTracks;
        const fileDurationBeats = choice === "fit-project-tempo"
          ? Math.max(1, ...convertedTracks.map((track) => track.durationBeats))
          : sourceEnd;
        const patch = buildMidiRegionImportPatch({
          songIndex: target?.songIndex ?? state.songIndex,
          trackId,
          name: `${file.name.replace(/\.(mid|midi|midi2)$/i, "")}${midi.format === 2 && selectedSequence ? ` - ${selectedSequence.name}` : ""}`,
          startBeats: cursor,
          durationBeats: fileDurationBeats,
          tracks: convertedTracks,
          sourceName: file.name,
        });
        plans.push({ file, patch });
        if (choice === "fit-project-tempo" || choice === "use-midi-tempo") {
          const startSeconds = songSecondsAtBeat(activeTempoSong, cursor);
          endSeconds = Math.max(endSeconds, startSeconds + originalDurationSeconds);
        } else {
          endSeconds = Math.max(endSeconds, songSecondsAtBeat(activeTempoSong, cursor + fileDurationBeats));
        }
        cursor += fileDurationBeats;
      }

      if (tempoUpdate) {
        const { bpm, tempoPoints, signaturePoints } = tempoUpdate;
        await builder.songUpdate({
          index: target?.songIndex ?? state.songIndex,
          name: song.name, bpm, mode: song.mode,
          tsNum: signaturePoints[0]?.numerator ?? 4,
          tsDen: signaturePoints[0]?.denominator ?? 4,
          click: song.click, clickBusId: song.clickBusId, clickSends: song.clickSends,
          tempoPoints, signaturePoints,
        });
      }
      for (let index = 0; index < plans.length; index++) {
        const plan = plans[index];
        setProgress(`Importing ${index + 1} of ${plans.length}: ${plan.file.name}`);
        await builder.midiRegionAdd(plan.patch);
      }
      if (endSeconds > (song.endSeconds ?? 0) + 0.05)
        await builder.songEnd(target?.songIndex ?? state.songIndex, endSeconds);
      onClose();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "MIDI import failed. Some earlier files may already have been imported.");
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  return (
    <Modal isOpen={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.CloseTrigger isDisabled={busy} />
            <Modal.Header><Modal.Heading>Import MIDI</Modal.Heading></Modal.Header>
            <Modal.Body className="space-y-4">
              <p className="text-xs text-foreground/65">
                {format2File
                  ? "SMF Format 2 stores independent sequences and tempo maps, not parallel tracks. Choose one sequence to import into the selected song; import other sequences separately."
                  : `${files.length} file${files.length === 1 ? "" : "s"}. Each file becomes its own region; files are placed sequentially from the chosen start. MIDI tracks inside each file are combined into the selected destination track.`}
              </p>
              {format2File && <label className="grid gap-1 text-xs">
                Independent sequence
                <select className="rounded-lg border border-default/25 bg-surface px-3 py-2 text-foreground" value={Math.min(sequenceIndex, format2File.midi.tracks.length - 1)} onChange={(event) => setSequenceIndex(Number(event.target.value))}>
                  {format2File.midi.tracks.map((track, index) => <option key={index} value={index}>{index + 1}. {track.name} · {track.tempoEvents?.find((point) => point.beat <= 0)?.bpm?.toFixed(1) ?? 120} BPM</option>)}
                </select>
              </label>}
              {parsed && <ul className="max-h-24 space-y-1 overflow-auto rounded-lg border border-default/20 p-2 text-xs">
                {parsed.map(({ file, midi }) => <li key={`${file.name}:${file.size}:${file.lastModified}`} className="flex justify-between gap-3">
                  <span className="truncate">{file.name}</span>
                  <span className="shrink-0 text-foreground/55">{midi.tracks.filter((track) => track.notes.length).length} note tracks{midi.bpm ? ` · ${midi.bpm.toFixed(1)} BPM` : " · default 120 BPM"}</span>
                </li>)}
              </ul>}
              <label className="grid gap-1 text-xs">
                Destination track
                <select className="rounded-lg border border-default/25 bg-surface px-3 py-2 text-foreground" value={trackId} onChange={(event) => setTrackId(event.target.value)}>
                  {midiTracks.map((track) => <option key={track.id} value={track.id}>{track.name} · {track.kind}</option>)}
                </select>
              </label>
              {hasTempoMismatch && <fieldset className="space-y-2 rounded-lg border border-warning/30 p-3 text-xs">
                <legend className="px-1 font-medium">MIDI tempo differs from the song</legend>
                <label className="flex gap-2"><input type="radio" checked={choice === "keep-beats"} onChange={() => setChoice("keep-beats")} /> Keep beat positions; playback follows the project tempo.</label>
                <label className="flex gap-2"><input type="radio" checked={choice === "fit-project-tempo"} onChange={() => setChoice("fit-project-tempo")} /> Preserve MIDI timing by adapting notes to the project's tempo.</label>
                <label className={`flex gap-2 ${!canUseImportedTempo ? "opacity-50" : ""}`}><input type="radio" disabled={!canUseImportedTempo} checked={choice === "use-midi-tempo"} onChange={() => setChoice("use-midi-tempo")} /> Set the song tempo to the MIDI tempo.</label>
                {!canUseImportedTempo && <p className="text-warning">For a batch with different tempo maps, choose one of the first two options or import files separately.</p>}
              </fieldset>}
              {progress && <p className="text-xs text-foreground/60">{progress}</p>}
              {failure && <p role="alert" className="text-xs text-danger">{failure}</p>}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" isDisabled={busy} onPress={onClose}>Cancel</Button>
              <Button isDisabled={busy || !parsed || !trackId || !midiTracks.length} onPress={() => void doImport()}>{busy ? "Importing…" : "Import"}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
