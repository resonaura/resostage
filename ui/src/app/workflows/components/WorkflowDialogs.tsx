import { ExportMidiDialog } from "../../midi/components/ExportMidiDialog";
import { ImportMidiDialog } from "../../midi/components/ImportMidiDialog";
import { ImportAudioBatchDialog } from "../../import/audio/components/ImportAudioBatchDialog";
import { RenderAudioDialog } from "../../render/components/RenderAudioDialog";
import type { WebUiState } from "../../../lib/state/types";
import type { AppWorkflows } from "../hooks/useAppWorkflows";

export function WorkflowDialogs({
  state,
  workflows,
}: {
  state: WebUiState;
  workflows: AppWorkflows;
}) {
  const { renderRequest, midiExport, midiImportRequest, audioImportRequest } =
    workflows;

  return (
    <>
      <RenderAudioDialog
        open={renderRequest.open}
        state={state}
        intent={renderRequest.intent}
        requestId={renderRequest.id}
        onClose={workflows.closeRender}
      />
      <ExportMidiDialog
        open={midiExport.open}
        state={state}
        intent={midiExport.intent}
        onClose={workflows.closeMidiExport}
      />
      <ImportMidiDialog
        open={midiImportRequest !== null}
        files={midiImportRequest?.files ?? []}
        target={midiImportRequest?.target}
        state={state}
        onClose={workflows.closeMidiImport}
      />
      <ImportAudioBatchDialog
        open={audioImportRequest !== null}
        files={audioImportRequest?.files ?? []}
        state={state}
        songIndex={audioImportRequest?.songIndex ?? state.songIndex}
        startSeconds={audioImportRequest?.startSeconds}
        trackIndex={audioImportRequest?.trackIndex}
        onClose={workflows.closeAudioImport}
      />
      <input
        ref={workflows.midiImportInput}
        type="file"
        accept=".mid,.midi,.midi2,audio/midi"
        multiple
        className="hidden"
        aria-label="Import MIDI file"
        onChange={workflows.onMidiFileChange}
      />
      <input
        ref={workflows.audioImportInput}
        type="file"
        accept="audio/wav,.wav,.wave"
        multiple
        className="hidden"
        aria-label="Import audio file"
        onChange={workflows.onAudioFileChange}
      />
    </>
  );
}
