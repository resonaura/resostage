// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useState } from "react";
import {
  OpenConfirmDialog,
  QuitConfirmDialog,
  QuitOverlay,
} from "@/shell/overlays/components/AppOverlays";
import type { WebUiState } from "@/lib/state/types";
import { TransferDialogs } from "@/transfer/workflows/components/TransferDialogs";
import type { TransferWorkflows } from "@/transfer/workflows/hooks/useTransferWorkflows";

/** Mounts app-wide confirmation, quit, and file-transfer dialogs. */
export function AppDialogLayer({
  state,
  transferWorkflows,
}: {
  state: WebUiState;
  transferWorkflows: TransferWorkflows;
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
      <TransferDialogs state={state} transfer={transferWorkflows} />
    </>
  );
}
