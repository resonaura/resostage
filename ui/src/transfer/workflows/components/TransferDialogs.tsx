import { ExportMidiDialog } from "../../midi/components/ExportMidiDialog";
import { ImportMidiDialog } from "../../midi/components/ImportMidiDialog";
import { ImportAudioBatchDialog } from "../../audio/components/ImportAudioBatchDialog";
import { RenderAudioDialog } from "../../render/components/RenderAudioDialog";
import type { WebUiState } from "../../../lib/state/types";
import type { TransferWorkflows } from "../hooks/useTransferWorkflows";

export function TransferDialogs({
  state,
  transfer,
}: {
  state: WebUiState;
  transfer: TransferWorkflows;
}) {
  const { renderRequest, midiExport, midiImportRequest, audioImportRequest } =
    transfer;

  return (
    <>
      <RenderAudioDialog
        open={renderRequest.open}
        state={state}
        intent={renderRequest.intent}
        requestId={renderRequest.id}
        onClose={transfer.closeRender}
      />
      <ExportMidiDialog
        open={midiExport.open}
        state={state}
        intent={midiExport.intent}
        onClose={transfer.closeMidiExport}
      />
      <ImportMidiDialog
        open={midiImportRequest !== null}
        files={midiImportRequest?.files ?? []}
        target={midiImportRequest?.target}
        state={state}
        onClose={transfer.closeMidiImport}
      />
      <ImportAudioBatchDialog
        open={audioImportRequest !== null}
        files={audioImportRequest?.files ?? []}
        state={state}
        songIndex={audioImportRequest?.songIndex ?? state.songIndex}
        startSeconds={audioImportRequest?.startSeconds}
        trackIndex={audioImportRequest?.trackIndex}
        onClose={transfer.closeAudioImport}
      />
      <input
        ref={transfer.midiImportInput}
        type="file"
        accept=".mid,.midi,.midi2,audio/midi"
        multiple
        className="hidden"
        aria-label="Import MIDI file"
        onChange={transfer.onMidiFileChange}
      />
      <input
        ref={transfer.audioImportInput}
        type="file"
        accept="audio/wav,.wav,.wave"
        multiple
        className="hidden"
        aria-label="Import audio file"
        onChange={transfer.onAudioFileChange}
      />
    </>
  );
}
