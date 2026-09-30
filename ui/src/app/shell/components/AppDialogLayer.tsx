import { useState } from "react";
import {
  OpenConfirmDialog,
  QuitConfirmDialog,
  QuitOverlay,
} from "../../overlays/components/AppOverlays";
import type { WebUiState } from "../../../lib/state/types";
import { WorkflowDialogs } from "../../workflows/components/WorkflowDialogs";
import type { AppWorkflows } from "../../workflows/hooks/useAppWorkflows";

/** Mounts app-wide confirmation, quit, import, export, and render dialogs. */
export function AppDialogLayer({
  state,
  workflows,
}: {
  state: WebUiState;
  workflows: AppWorkflows;
}) {
  const [isQuittingOverlay, setIsQuittingOverlay] = useState(false);

  return (
    <>
      <QuitConfirmDialog
        state={state}
        onStartQuitting={() => setIsQuittingOverlay(true)}
      />
      <OpenConfirmDialog state={state} />
      <QuitOverlay open={isQuittingOverlay} />
      <WorkflowDialogs state={state} workflows={workflows} />
    </>
  );
}
