import { useCallback, useEffect, useRef, useState } from "react";
import type { MidiExportIntent } from "../../midi/components/ExportMidiDialog";
import type { RenderDialogIntent } from "../../render/components/RenderAudioDialog";
import type { WebUiState } from "../../../lib/state/types";

export interface MidiImportTarget {
  songIndex: number;
  trackId?: string;
  startBeats?: number;
}

export interface MidiImportRequest {
  files: File[];
  target?: MidiImportTarget;
}

export interface AudioImportRequest {
  files: File[];
  songIndex: number;
  startSeconds?: number;
  trackIndex?: number;
}

/** Owns app-wide import/export/render requests and their native file inputs. */
export function useTransferWorkflows(state: WebUiState) {
  const [renderRequest, setRenderRequest] = useState<{
    open: boolean;
    intent: RenderDialogIntent;
    id: number;
  }>({ open: false, intent: { kind: "generic" }, id: 0 });
  const [midiExport, setMidiExport] = useState<{
    open: boolean;
    intent: MidiExportIntent;
  }>({ open: false, intent: { kind: "all-midi" } });
  const midiImportInput = useRef<HTMLInputElement>(null);
  const audioImportInput = useRef<HTMLInputElement>(null);
  const [midiImportRequest, setMidiImportRequest] =
    useState<MidiImportRequest | null>(null);
  const [audioImportRequest, setAudioImportRequest] =
    useState<AudioImportRequest | null>(null);

  useEffect(() => {
    const midi = () => midiImportInput.current?.click();
    const audio = () => audioImportInput.current?.click();
    window.addEventListener("resostage-open-midi-import", midi);
    window.addEventListener("resostage-open-audio-import", audio);
    return () => {
      window.removeEventListener("resostage-open-midi-import", midi);
      window.removeEventListener("resostage-open-audio-import", audio);
    };
  }, []);

  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<AudioImportRequest>).detail;
      if (detail?.files?.length) setAudioImportRequest(detail);
    };
    window.addEventListener("resostage-import-audio-batch", handle);
    return () =>
      window.removeEventListener("resostage-import-audio-batch", handle);
  }, []);

  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<MidiImportRequest>).detail;
      if (detail?.files?.length) setMidiImportRequest(detail);
    };
    window.addEventListener("resostage-import-midi", handle);
    return () => window.removeEventListener("resostage-import-midi", handle);
  }, []);

  useEffect(() => {
    const handle = (event: Event) => {
      const intent = (event as CustomEvent<MidiExportIntent>).detail;
      setMidiExport({
        open: true,
        intent: intent?.kind ? intent : { kind: "all-midi" },
      });
    };
    window.addEventListener("resostage-open-midi-export", handle);
    return () =>
      window.removeEventListener("resostage-open-midi-export", handle);
  }, []);

  const openRender = useCallback((intent: RenderDialogIntent) => {
    setRenderRequest((current) => ({
      open: true,
      intent,
      id: current.id + 1,
    }));
  }, []);

  useEffect(() => {
    const handleNativeRender = (event: Event) => {
      const detail = (event as CustomEvent<RenderDialogIntent>).detail;
      openRender(detail?.kind === "all-tracks" ? detail : { kind: "generic" });
    };
    window.addEventListener("resostage-open-audio-render", handleNativeRender);
    return () =>
      window.removeEventListener("resostage-open-audio-render", handleNativeRender);
  }, [openRender]);

  const onMidiFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length)
      setMidiImportRequest({ files, target: { songIndex: state.songIndex } });
  };

  const onAudioFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length) return;
    if (files.length > 1) {
      setAudioImportRequest({ files, songIndex: state.songIndex });
      return;
    }
    const index = state.tracks.findIndex(
      (track) => track.id === state.activeTrackId && track.kind === "audio",
    );
    if (index < 0) {
      setAudioImportRequest({ files, songIndex: state.songIndex });
      return;
    }
    setAudioImportRequest({ files, songIndex: state.songIndex, trackIndex: index });
  };

  return {
    renderRequest,
    midiExport,
    midiImportRequest,
    audioImportRequest,
    midiImportInput,
    audioImportInput,
    openRender,
    closeRender: () =>
      setRenderRequest((current) => ({ ...current, open: false })),
    closeMidiExport: () =>
      setMidiExport((current) => ({ ...current, open: false })),
    closeMidiImport: () => setMidiImportRequest(null),
    closeAudioImport: () => setAudioImportRequest(null),
    onMidiFileChange,
    onAudioFileChange,
  };
}

export type TransferWorkflows = ReturnType<typeof useTransferWorkflows>;
