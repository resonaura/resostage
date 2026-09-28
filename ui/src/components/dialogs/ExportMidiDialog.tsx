import { useEffect, useState } from "react";
import { writeSongsMidiFile } from "../../lib/midi/standardMidiFile";
import type { WebUiState } from "../../lib/state/types";
import { Button, Modal, Switch } from "../ui";

export type MidiExportIntent = { kind: "all-midi" | "track" | "region"; trackId?: string; regionId?: string; songIndex?: number };

export function ExportMidiDialog({ open, state, intent, onClose }: {
  open: boolean;
  state: WebUiState;
  intent: MidiExportIntent;
  onClose: () => void;
}) {
  const defaultSong = intent.songIndex ?? Math.max(0, state.songIndex);
  const [selectedSongs, setSelectedSongs] = useState<Set<number>>(() => new Set([defaultSong]));
  const [fromProjectStart, setFromProjectStart] = useState(true);
  const [expandLoops, setExpandLoops] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setSelectedSongs(new Set([intent.songIndex ?? Math.max(0, state.songIndex)]));
      setError("");
    }
  }, [open, state.songIndex, intent.songIndex]);

  const doExport = () => {
    try {
      const indices = intent.kind === "region" && intent.songIndex !== undefined
        ? [intent.songIndex]
        : [...selectedSongs].sort((a, b) => a - b);
      if (!indices.length) throw new Error("Select at least one song");
      const trackName = intent.kind === "track"
        ? state.tracks.find((track) => track.id === intent.trackId)?.name
        : undefined;
      if (intent.kind === "track" && !trackName)
        throw new Error("The requested track is no longer available");
      let songs = state.songs;
      if (intent.kind === "region" && intent.regionId) {
        songs = state.songs.map((song, index) => index === (intent.songIndex ?? state.songIndex)
          ? { ...song, midiRegions: song.midiRegions?.filter((region) => region.id === intent.regionId) }
          : { ...song, midiRegions: [] });
      }
      const bytes = writeSongsMidiFile(songs, {
        songIndices: indices,
        trackNames: trackName ? new Set([trackName]) : undefined,
        trackIds: intent.kind === "region" && intent.trackId ? new Set([intent.trackId]) : undefined,
        fromProjectStart, expandLoops,
      });
      const blob = new Blob([Uint8Array.from(bytes)], { type: "audio/midi" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const label = intent.kind === "track" ? state.tracks.find((track) => track.id === intent.trackId)?.name : undefined;
      anchor.href = url;
      anchor.download = `${(label || state.projectName || "ResoStage").replace(/[\\/:*?"<>|]/g, "_")}.mid`;
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
            <Modal.Header><Modal.Heading>Export MIDI</Modal.Heading></Modal.Header>
            <Modal.Body className="space-y-4">
              <p className="text-xs text-foreground/60">Choose one song or several. Selected songs are concatenated in project order; the MIDI tempo and meter track follows every song and its changes.</p>
              <div className={`max-h-40 space-y-1 overflow-auto rounded-lg border border-default/20 p-2 ${intent.kind === "region" ? "opacity-60" : ""}`}>
                {state.songs.map((song, index) => (
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
              <Button onPress={doExport}>Export .mid</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
