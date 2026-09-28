import { useState } from "react";
import { builder } from "../../lib/state/api";
import type { WebUiState } from "../../lib/state/types";
import { Button, Modal } from "../ui";

export function ImportAudioBatchDialog({
  open, files, state, songIndex, startSeconds = 0, trackIndex, onClose,
}: {
  open: boolean;
  files: File[];
  state: WebUiState;
  songIndex: number;
  startSeconds?: number;
  trackIndex?: number;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  const runImport = async () => {
    if (!files.length) return;
    if (files.length > 64) { setError("Import at most 64 audio files at a time"); return; }
    if (files.some((file) => !/\.(wav|wave)$/i.test(file.name))) {
      setError("Batch audio import currently accepts WAV files only");
      return;
    }
    if (files.some((file) => file.size > 512 * 1024 * 1024)) {
      setError("A WAV file exceeds the 512 MiB per-file limit");
      return;
    }
    if (trackIndex !== undefined && files.length !== 1) {
      setError("Import into an existing track is supported for one file at a time");
      return;
    }
    if (trackIndex !== undefined && state.tracks[trackIndex]?.kind !== "audio") {
      setError("Choose an audio track before importing into an existing track");
      return;
    }
    const startTrackIndex = trackIndex ?? state.tracks.length;
    setBusy(true);
    setError("");
    try {
      // Each batch source gets a distinct track. A deliberate single-file
      // import may instead target the selected audio track.
      if (trackIndex === undefined) {
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          const baseName = file.name.replace(/\.(wav|wave)$/i, "").slice(0, 96) || `Audio ${index + 1}`;
          setProgress(`Creating track ${index + 1} of ${files.length}: ${baseName}`);
          await builder.trackAdd(songIndex, { kind: "audio", name: baseName });
        }
      }
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        setProgress(`Importing ${index + 1} of ${files.length}: ${file.name}`);
        await builder.trackImportWav(songIndex, startTrackIndex + index, file, startSeconds);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error
        ? `${cause.message}. Tracks/files imported before the failure remain in the project.`
        : "Audio batch import failed; some earlier files may already be in the project.");
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
            <Modal.Header><Modal.Heading>Import audio files</Modal.Heading></Modal.Header>
            <Modal.Body className="space-y-3">
              <p className="text-xs text-foreground/65">
                {trackIndex === undefined
                  ? `${files.length} file${files.length === 1 ? "" : "s"} will each get a new audio track and region at the import position. Existing tracks and regions are left untouched; new tracks are appended to the project.`
                  : `This file will be imported into ${state.tracks[trackIndex]?.name ?? "the selected audio track"}.`}
              </p>
              <ul className="max-h-36 space-y-1 overflow-auto rounded-lg border border-default/20 p-2 text-xs">
                {files.map((file, index) => <li key={`${file.name}:${file.size}:${file.lastModified}:${index}`} className="flex justify-between gap-3">
                  <span className="truncate">{file.name}</span>
                  <span className="shrink-0 text-foreground/55">{(file.size / (1024 * 1024)).toFixed(1)} MiB</span>
                </li>)}
              </ul>
              {progress && <p className="text-xs text-foreground/60">{progress}</p>}
              {error && <p role="alert" className="text-xs text-danger">{error}</p>}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" isDisabled={busy} onPress={onClose}>Cancel</Button>
              <Button isDisabled={busy || !files.length} onPress={() => void runImport()}>{busy ? "Importing…" : "Import"}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
