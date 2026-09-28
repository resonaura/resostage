import { useEffect, useMemo, useState } from "react";
import {
  adaptMidiTracksToSongTempo,
  midiSecondsAtBeat,
  midiTempoDiffersFromSong,
  parseStandardMidiFile,
  songSecondsAtBeat,
  type ImportedMidiFile,
} from "../../lib/midi/standardMidiFile";
import { builder } from "../../lib/state/api";
import type { WebUiState } from "../../lib/state/types";
import { Button, Modal } from "../ui";

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
  const [trackId, setTrackId] = useState(target?.trackId ?? "");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const song = state.songs[target?.songIndex ?? state.songIndex];
  const midiTracks = useMemo(() => state.tracks.filter((track) =>
    ["instrument", "midi", "externalMidi"].includes(track.kind ?? "")), [state.tracks]);

  useEffect(() => {
    if (!open) return;
    setParsed(null);
    setFailure("");
    setProgress("");
    setTrackId(target?.trackId ?? midiTracks.find((track) => track.id === state.activeTrackId)?.id ?? midiTracks[0]?.id ?? "");
    let cancelled = false;
    void (async () => {
      try {
        if (!files.length) throw new Error("No MIDI files selected");
        if (files.length > 128) throw new Error("Import at most 128 MIDI files at a time");
        const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        if (totalBytes > 128 * 1024 * 1024) throw new Error("The selected MIDI files exceed the 128 MiB batch limit");
        const batch = await Promise.all(files.map(async (file) => {
          if (file.size > 32 * 1024 * 1024) throw new Error(`${file.name}: MIDI file exceeds 32 MiB`);
          return { file, midi: parseStandardMidiFile(new Uint8Array(await file.arrayBuffer())) };
        }));
        if (batch.some(({ midi }) => !midi.tracks.some((track) => track.notes.length || track.events?.length)))
          throw new Error("Every imported MIDI file must contain at least one note or MIDI event track");
        if (!cancelled) setParsed(batch);
      } catch (cause) {
        if (!cancelled) setFailure(cause instanceof Error ? cause.message : "MIDI import failed");
      }
    })();
    return () => { cancelled = true; };
  }, [open, files, target?.trackId, midiTracks, state.activeTrackId]);

  const hasTempoMismatch = Boolean(song && parsed?.some(({ midi }) =>
    midiTempoDiffersFromSong(midi.tempoEvents, song)));
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
      if (choice === "use-midi-tempo" && parsed.length === 1) {
        const sourceSong = parsed[0].midi;
        const bpm = sourceSong.bpm ?? 120;
        const tempoByBeat = new Map<number, { beat: number; bpm: number }>();
        tempoByBeat.set(0, { beat: 0, bpm: 120 });
        for (const point of sourceSong.tempoEvents) {
          if (point.beat >= 0) tempoByBeat.set(point.beat, point);
        }
        const tempoPoints = [...tempoByBeat.values()].sort((a, b) => a.beat - b.beat).map((point) => ({
          ...point,
          timeSeconds: midiSecondsAtBeat(sourceSong.tempoEvents, point.beat),
          curve: 0,
        }));
        const meterByBeat = new Map<number, { beat: number; numerator: number; denominator: number }>();
        meterByBeat.set(0, {
          beat: 0,
          numerator: sourceSong.numerator ?? 4,
          denominator: sourceSong.denominator ?? 4,
        });
        for (const point of sourceSong.meterEvents) {
          if (point.beat >= 0) meterByBeat.set(point.beat, point);
        }
        let bar = 1;
        let previousBeat = 0;
        let previousNumerator = sourceSong.numerator ?? 4;
        let previousDenominator = sourceSong.denominator ?? 4;
        const signaturePoints = [...meterByBeat.values()].sort((a, b) => a.beat - b.beat).map((point) => {
          const beatsPerBar = previousNumerator * 4 / previousDenominator;
          bar += Math.floor(Math.max(0, point.beat - previousBeat) / beatsPerBar + 1e-9);
          const result = { ...point, bar };
          previousBeat = point.beat;
          previousNumerator = point.numerator;
          previousDenominator = point.denominator;
          return result;
        });
        activeTempoSong = { ...song, bpm, tempoPoints };
        await builder.songUpdate({
          index: target?.songIndex ?? state.songIndex,
          name: song.name, bpm, mode: song.mode, tsNum: song.tsNum, tsDen: song.tsDen,
          click: song.click, clickBusId: song.clickBusId, clickSends: song.clickSends,
          tempoPoints, signaturePoints,
        });
      }

      for (let index = 0; index < parsed.length; index++) {
        const { file, midi } = parsed[index];
        setProgress(`Importing ${index + 1} of ${parsed.length}: ${file.name}`);
        const sourceTracks = midi.tracks.filter((track) => track.notes.length > 0 || track.events?.length);
        const sourceEnd = Math.max(1, ...midi.tracks.map((track) => track.durationBeats));
        const originalDurationSeconds = midiSecondsAtBeat(midi.tempoEvents, sourceEnd);
        const convertedTracks = choice === "fit-project-tempo"
          ? adaptMidiTracksToSongTempo(sourceTracks, midi.tempoEvents, song)
          : sourceTracks;
        const fileDurationBeats = choice === "fit-project-tempo"
          ? Math.max(1, ...convertedTracks.map((track) => track.durationBeats))
          : sourceEnd;
        let id = 1;
        const notes = convertedTracks.flatMap((track) => track.notes.map((note) => ({
          ...note,
          id: id++,
        })));
        const events = convertedTracks.flatMap((track) => track.events ?? []);
        await builder.midiRegionAdd({
          songIndex: target?.songIndex ?? state.songIndex,
          trackId,
          name: file.name.replace(/\.(mid|midi)$/i, ""),
          startBeats: cursor,
          durationBeats: fileDurationBeats,
          loop: false,
          loopLengthBeats: fileDurationBeats,
          notes,
          events,
        });
        if (choice === "fit-project-tempo" || choice === "use-midi-tempo") {
          const startSeconds = songSecondsAtBeat(activeTempoSong, cursor);
          endSeconds = Math.max(endSeconds, startSeconds + originalDurationSeconds);
        } else {
          endSeconds = Math.max(endSeconds, songSecondsAtBeat(activeTempoSong, cursor + fileDurationBeats));
        }
        cursor += fileDurationBeats;
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
            <Modal.Header><Modal.Heading>Import MIDI</Modal.Heading></Modal.Header>
            <Modal.Body className="space-y-4">
              <p className="text-xs text-foreground/65">
                {files.length} file{files.length === 1 ? "" : "s"}. Each file becomes its own region; files are placed sequentially from the chosen start. MIDI tracks inside each file are combined into the selected destination track.
              </p>
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
