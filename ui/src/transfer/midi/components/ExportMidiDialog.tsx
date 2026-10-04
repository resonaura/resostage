/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useMemo, useState } from "react";
import {
  analyzeMidi1ExportLoss,
  analyzeMidi2ExportLoss,
  countMidi2TimeSignatureClickIntervalLoss,
  midiExportTracksForSongs,
  writeSongsMidiFile,
} from "@/lib/midi/standardMidiFile";
import type { WebUiState } from "@/lib/state/types";
import { Button, Modal, Switch } from "@/components/ui";

export type MidiExportIntent = { kind: "all-midi" | "track" | "region"; trackId?: string; regionId?: string; songIndex?: number };

export function ExportMidiDialog({ open, state, intent, onClose }: {
  open: boolean;
  state: WebUiState;
  intent: MidiExportIntent;
  onClose: () => void;
}) {
  // Partial structural state can arrive briefly while Core is opening a project.
  const songs = useMemo(() => Array.isArray(state.songs) ? state.songs : [], [state.songs]);
  const projectTracks = useMemo(() => Array.isArray(state.tracks) ? state.tracks : [], [state.tracks]);
  const defaultSong = intent.songIndex ?? Math.max(0, state.songIndex);
  const [selectedSongs, setSelectedSongs] = useState<Set<number>>(() => new Set([defaultSong]));
  const [fromProjectStart, setFromProjectStart] = useState(true);
  const [expandLoops, setExpandLoops] = useState(true);
  const [format, setFormat] = useState<"midi1" | "midi2">("midi1");
  const [lossAccepted, setLossAccepted] = useState(false);
  const [midi2LossAccepted, setMidi2LossAccepted] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setSelectedSongs(new Set([intent.songIndex ?? Math.max(0, state.songIndex)]));
      setFormat("midi1");
      setLossAccepted(false);
      setMidi2LossAccepted(false);
      setError("");
    }
  }, [open, state.songIndex, intent.songIndex]);

  const exportSongIndices = useMemo(
    () => intent.kind === "region" && intent.songIndex !== undefined
      ? [intent.songIndex]
      : [...selectedSongs].sort((a, b) => a - b),
    [intent.kind, intent.songIndex, selectedSongs],
  );
  const exportSelectionKey = exportSongIndices.join(",");
  const exportTracks = useMemo(() => midiExportTracksForSongs(songs, {
    songIndices: exportSongIndices,
    tracks: projectTracks,
    trackIds: (intent.kind === "track" || intent.kind === "region") && intent.trackId
      ? new Set([intent.trackId]) : undefined,
    regionId: intent.kind === "region" ? intent.regionId ?? "" : undefined,
  }), [exportSongIndices, songs, projectTracks, intent.kind, intent.regionId, intent.trackId]);
  const lossReport = useMemo(() => analyzeMidi1ExportLoss(exportTracks), [exportTracks]);
  const hasMidi1Loss = lossReport.noteAttributes + lossReport.groups + lossReport.zeroVelocityNoteOns
    + lossReport.quantizedVelocities + lossReport.nonzeroGroupUmpEvents
    + lossReport.invalidUmpSysExMessages + lossReport.unsupportedUmpEvents > 0;
  const midi2LossReport = useMemo(() => analyzeMidi2ExportLoss(exportTracks, {
    fromProjectStart, expandLoops,
  }), [exportTracks, fromProjectStart, expandLoops]);
  const midi2ClickIntervalLossCount = useMemo(
    () => countMidi2TimeSignatureClickIntervalLoss(songs, exportSongIndices),
    [songs, exportSongIndices],
  );
  const hasMidi2Loss = midi2ClickIntervalLossCount + midi2LossReport.unsupportedMidi1Events > 0;
  const lossFingerprint = JSON.stringify({
    midi1: lossReport,
    midi2: {
      lossReport: midi2LossReport,
      songs: exportSongIndices.map((index) => ({
        index,
        signatures: (songs[index]?.signaturePoints ?? []).map((point) => [
          point.beat,
          point.numerator,
          point.denominator,
          point.midiClocksPerMetronomeClick ?? 24,
        ]),
      })),
    },
  });
  useEffect(() => {
    setLossAccepted(false);
    setMidi2LossAccepted(false);
  }, [format, exportSelectionKey, intent.kind, intent.regionId, intent.trackId, lossFingerprint]);

  const doExport = () => {
    try {
      const indices = intent.kind === "region" && intent.songIndex !== undefined
        ? [intent.songIndex]
        : [...selectedSongs].sort((a, b) => a - b);
      if (!indices.length) throw new Error("Select at least one song");
      if (intent.kind === "track" && !projectTracks.some((track) => track.id === intent.trackId))
        throw new Error("The requested track is no longer available");
      let exportSongs = songs;
      if (intent.kind === "region" && intent.regionId) {
        exportSongs = songs.map((song, index) => index === (intent.songIndex ?? state.songIndex)
          ? { ...song, midiRegions: song.midiRegions?.filter((region) => region.id === intent.regionId) }
          : { ...song, midiRegions: [] });
      }
      const bytes = writeSongsMidiFile(exportSongs, {
        songIndices: indices,
        tracks: projectTracks,
        trackIds: (intent.kind === "track" || intent.kind === "region") && intent.trackId
          ? new Set([intent.trackId]) : undefined,
        fromProjectStart, expandLoops, format,
      });
      const blob = new Blob([Uint8Array.from(bytes)], { type: "audio/midi" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const label = intent.kind === "track" ? projectTracks.find((track) => track.id === intent.trackId)?.name : undefined;
      anchor.href = url;
      anchor.download = `${(label || state.projectName || "ResoStage").replace(/[\\/:*?"<>|]/g, "_")}.${format === "midi2" ? "midi2" : "mid"}`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "MIDI export failed");
    }
  };

  return (
    <Modal isOpen={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header><Modal.Heading>Export MIDI</Modal.Heading></Modal.Header>
            <Modal.Body className="space-y-4">
              <p className="text-xs text-foreground/60">Choose one song or several. Selected songs are concatenated in project order; the MIDI tempo and meter track follows every song and its changes.</p>
              <fieldset className="space-y-2 rounded-lg border border-default/20 p-3 text-xs">
                <legend className="px-1 font-medium">File format</legend>
                <label className="flex cursor-pointer items-start gap-2">
                  <input type="radio" checked={format === "midi1"} onChange={() => setFormat("midi1")} />
                  <span><span className="font-medium">Standard MIDI (.mid)</span><span className="block text-foreground/55">Recommended · works with the widest range of DAWs, notation tools, and devices.</span></span>
                </label>
                <label className="flex cursor-pointer items-start gap-2">
                  <input type="radio" checked={format === "midi2"} onChange={() => setFormat("midi2")} />
                  <span><span className="font-medium">MIDI 2.0 Clip (.midi2)</span><span className="block text-foreground/55">Preserves UMP/MIDI 2.0 data. The clip format is one merged event stream, so exported tracks/songs are combined.</span></span>
                </label>
              </fieldset>
              {format === "midi1" && hasMidi1Loss && <div className="space-y-2 rounded-lg border border-warning/35 bg-warning/5 p-3 text-xs">
                <p className="font-medium text-warning">This export cannot preserve all selected MIDI 2.0 data:</p>
                <ul className="list-inside list-disc text-foreground/70">
                  {lossReport.noteAttributes > 0 && <li>{lossReport.noteAttributes} note attribute(s) will be omitted</li>}
                  {lossReport.groups > 0 && <li>{lossReport.groups} note(s) use a UMP group other than 0</li>}
                  {lossReport.nonzeroGroupUmpEvents > 0 && <li>{lossReport.nonzeroGroupUmpEvents} UMP event(s) use a group other than 0; Standard MIDI has no group field</li>}
                  {lossReport.invalidUmpSysExMessages > 0 && <li>{lossReport.invalidUmpSysExMessages} SysEx7 UMP message(s) are incomplete, interrupted, or have invalid continuation ordering</li>}
                  {lossReport.zeroVelocityNoteOns > 0 && <li>{lossReport.zeroVelocityNoteOns} MIDI 2.0 zero-velocity Note On attack(s) will be raised to velocity 1 so MIDI 1.0 does not interpret them as Note Off</li>}
                  {lossReport.quantizedVelocities > 0 && <li>{lossReport.quantizedVelocities} note(s) have velocity values that exceed MIDI 1.0's 14-bit high-resolution range</li>}
                  {lossReport.unsupportedUmpEvents > 0 && <li>{lossReport.unsupportedUmpEvents} UMP-only event(s) have no implemented MIDI 1.0 conversion</li>}
                </ul>
                <label className="flex items-start gap-2 text-foreground/80">
                  <input type="checkbox" checked={lossAccepted} onChange={(event) => setLossAccepted(event.target.checked)} />
                  <span>Export the compatible .mid file with these losses</span>
                </label>
              </div>}
              {format === "midi2" && hasMidi2Loss && <div className="space-y-2 rounded-lg border border-warning/35 bg-warning/5 p-3 text-xs">
                <p className="font-medium text-warning">This MIDI Clip cannot preserve all selected MIDI 1.0 data:</p>
                <ul className="list-inside list-disc text-foreground/70">
                  {midi2ClickIntervalLossCount > 0 && <li>{midi2ClickIntervalLossCount} time-signature change(s) use a non-default MIDI-clock metronome-click interval, which has no MIDI 2.0 Set Time Signature field</li>}
                  {midi2LossReport.unsupportedMidi1Events > 0 && <li>{midi2LossReport.unsupportedMidi1Events} MIDI 1.0 event(s) cannot be represented in the MIDI Clip UMP stream and will be omitted</li>}
                </ul>
                <label className="flex items-start gap-2 text-foreground/80">
                  <input type="checkbox" checked={midi2LossAccepted} onChange={(event) => setMidi2LossAccepted(event.target.checked)} />
                  <span>Export the .midi2 clip without this MIDI 1.0-only metadata</span>
                </label>
              </div>}
              <div className={`max-h-40 space-y-1 overflow-auto rounded-lg border border-default/20 p-2 ${intent.kind === "region" ? "opacity-60" : ""}`}>
                {songs.map((song, index) => (
                  <label key={index} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-default/15">
                    <input type="checkbox" disabled={intent.kind === "region"} checked={intent.kind === "region" ? index === intent.songIndex : selectedSongs.has(index)} onChange={(event) => {
                      setSelectedSongs((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(index); else next.delete(index);
                        return next;
                      });
                    }} />
                    <span>{index + 1}. {song.name}</span>
                  </label>
                ))}
              </div>
              <Switch isSelected={fromProjectStart} onChange={setFromProjectStart}>Preserve song start / leading silence</Switch>
              <Switch isSelected={expandLoops} onChange={setExpandLoops}>Expand looped MIDI regions</Switch>
              {error && <p className="text-xs text-danger" role="alert">{error}</p>}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={onClose}>Cancel</Button>
              <Button isDisabled={
                (format === "midi1" && hasMidi1Loss && !lossAccepted)
                || (format === "midi2" && hasMidi2Loss && !midi2LossAccepted)
              } onPress={doExport}>Export {format === "midi2" ? ".midi2" : ".mid"}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
