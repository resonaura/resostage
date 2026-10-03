/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Download, RotateCcw, X } from "lucide-react";
import { Alert, Button } from "@/components/ui";
import {
  automationGestureRecoveryLimits,
  type AutomationGestureRecoveryDraft,
} from "@/screens/editor/timeline/automation/logic/automationGestureRecovery";
import { RULER_HEIGHT } from "@/screens/editor/timeline/ruler/logic/constants";

function outcomeLabel(draft: AutomationGestureRecoveryDraft): string {
  switch (draft.outcome) {
    case "not-sent":
      return "Not sent — safe to retry";
    case "rejected":
      return "Core confirmed rejection — safe to retry";
    case "stored":
      return "Project edit was stored; live audio publication was not confirmed. Do not retry.";
    case "unknown":
      return "Outcome unknown. Do not retry; export the captured gesture for recovery.";
  }
}

function downloadDraft(draft: AutomationGestureRecoveryDraft): void {
  const blob = new Blob([JSON.stringify({
    format: "resostage-automation-gesture-recovery-v1",
    projectIdentity: draft.projectIdentity,
    songIndex: draft.songIndex,
    createdAt: new Date(draft.createdAt).toISOString(),
    outcome: draft.outcome,
    error: draft.error,
    gesture: draft.payload,
  }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `automation-gesture-${draft.payload.gestureId}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function AutomationGestureRecoveryNotice({
  drafts,
  projectIdentity,
  songIndex,
  laneIds,
  onRetry,
  onDismiss,
}: {
  drafts: AutomationGestureRecoveryDraft[];
  projectIdentity: string | null;
  songIndex: number;
  laneIds: ReadonlySet<string>;
  onRetry: (draftId: string) => Promise<void>;
  onDismiss: (draftId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pendingDraftId, setPendingDraftId] = useState<string | null>(null);

  useEffect(() => {
    if (drafts.length > 0) setExpanded(true);
  }, [drafts.length]);

  if (drafts.length === 0) return null;

  const retry = async (draftId: string) => {
    if (pendingDraftId) return;
    setPendingDraftId(draftId);
    try {
      await onRetry(draftId);
    } finally {
      setPendingDraftId(null);
    }
  };

  return (
    <div
      className="absolute left-2 right-2 z-50"
      style={{ top: RULER_HEIGHT + 2 }}
      onPointerDown={(event) => event.stopPropagation()}
      aria-live="polite"
    >
      <Alert status="warning" className="border border-warning/25 bg-background-secondary shadow-xl">
        <Alert.Indicator><AlertTriangle size={13} /></Alert.Indicator>
        <Alert.Content className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Alert.Title className="min-w-0 flex-1 truncate text-[11px] font-semibold">
              {drafts.length} automation gesture{drafts.length === 1 ? "" : "s"} need recovery
            </Alert.Title>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]"
              onPress={() => setExpanded((value) => !value)}>
              {expanded ? "Hide" : "Review"}
            </Button>
          </div>
          {expanded && (
            <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">
              {drafts.map((draft) => {
                const sameDocument = draft.projectIdentity === projectIdentity
                  && draft.songIndex === songIndex;
                const canRetry = sameDocument && laneIds.has(draft.payload.laneId)
                  && (draft.outcome === "not-sent" || draft.outcome === "rejected");
                return (
                  <div key={draft.id} className="rounded-md border border-default/25 bg-background-tertiary p-2">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[10px] font-medium text-foreground">
                          {draft.payload.laneId} · {new Date(draft.createdAt).toLocaleTimeString()}
                        </div>
                        <div className="mt-0.5 text-[10px] text-warning">{outcomeLabel(draft)}</div>
                        {!sameDocument && (
                          <div className="mt-0.5 text-[10px] text-foreground/55">
                            Captured in another project or song. Replay is disabled.
                          </div>
                        )}
                        <div className="mt-1 break-words text-[10px] text-foreground/55">{draft.error}</div>
                        {!draft.persisted && (
                          <div className="mt-1 text-[10px] text-warning">
                            Browser storage is full or unavailable; download this draft before closing the app.
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {canRetry && (
                          <Button size="sm" variant="accent-soft" className="h-6 gap-1 px-2 text-[10px]"
                            isDisabled={pendingDraftId !== null}
                            onPress={() => void retry(draft.id)}>
                            <RotateCcw size={11} /> Retry
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" isIconOnly className="h-6 w-6"
                          aria-label="Download automation gesture draft"
                          onPress={() => downloadDraft(draft)}>
                          <Download size={12} />
                        </Button>
                        <Button size="sm" variant="ghost" isIconOnly className="h-6 w-6"
                          aria-label="Dismiss automation gesture draft"
                          onPress={() => onDismiss(draft.id)}>
                          <X size={12} />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {drafts.length >= automationGestureRecoveryLimits.drafts && (
                <p className="text-[10px] text-warning">
                  New automation recording is paused until a recovery draft is exported or dismissed.
                </p>
              )}
            </div>
          )}
        </Alert.Content>
      </Alert>
    </div>
  );
}
