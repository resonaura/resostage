/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { ProgressBar, Spinner } from "@heroui/react";
import { useState } from "react";
import { Button, Modal } from "@/components/ui";
import { decidePluginLoading } from "@/lib/state/api";
import type { PluginLoadingState } from "@/lib/state/types";
import { pluginLoadingView } from "@/shell/plugins/logic/loadingView";

/** Generation-keyed by the parent: a stale request cannot dismiss a new load. */
export function PluginLoadingDialog({ loading, connected }: {
  loading: PluginLoadingState;
  connected: boolean;
}) {
  const [pendingDecision, setPendingDecision] = useState(false);
  const [error, setError] = useState("");
  const view = pluginLoadingView(loading, connected);
  const decide = async (decision: "continue" | "stop" | "retry") => {
    setPendingDecision(true);
    setError("");
    try {
      await decidePluginLoading(loading.epoch, loading.generation, decision);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPendingDecision(false);
    }
  };
  return (
    <Modal isOpen={loading.showDialog && loading.blocksPlayback}>
      <Modal.Backdrop isDismissable={false} isKeyboardDismissDisabled>
        <Modal.Container size="md" placement="center">
          <Modal.Dialog aria-label={view.title} className="border border-default/30">
            <Modal.Header>
              <Modal.Heading className="flex items-center gap-2">
                {view.pending && <Spinner size="sm" />}
                {view.title}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="space-y-3">
              <p className="text-sm text-muted">{view.description}</p>
              <ProgressBar aria-label="Plug-in loading progress" value={view.completed} maxValue={view.total}>
                <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
              </ProgressBar>
              <p className="truncate text-sm">
                {loading.currentName || `${view.completed} / ${loading.total} plug-ins prepared`}
              </p>
              {loading.playRequested && <p className="text-xs text-muted">Play requested — it will start only when the project is ready.</p>}
              {loading.failed > 0 && <p className="text-sm text-warning">{loading.failed} plug-in(s) unavailable. See their slots for details.</p>}
              {(error || loading.error) && <p role="alert" className="max-h-32 overflow-auto wrap-break-word text-sm text-danger">{error || loading.error}</p>}
            </Modal.Body>
            <Modal.Footer className="flex flex-wrap gap-2">
              <Button variant="secondary" isDisabled={!connected || pendingDecision} onPress={() => void decide("stop")}>Keep stopped</Button>
              {!view.pending && <>
                <Button variant="secondary" isDisabled={!view.canRetry || pendingDecision} onPress={() => void decide("retry")}>Retry loading</Button>
                <Button variant="primary" isDisabled={!view.canContinue || pendingDecision} onPress={() => void decide("continue")}>Continue with available</Button>
              </>}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
