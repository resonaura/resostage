/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Button, Modal } from "@/components/ui";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchMixGraph } from "@/lib/state/api";
import { SignalFlowGraph } from "@/screens/settings/audio/components/SignalFlowGraph";
import type { MixGraphPayload } from "@/screens/settings/audio/logic/signalFlowLayout";
import type { WebUiState } from "@/lib/state/types";
import {
  buildSignalFlowModel,
  resolveSignalFlowFocus,
} from "@/screens/settings/audio/logic/signalFlowModel";

/** How often the open diagram re-reads the graph. Routing only changes when
 *  someone turns a knob, so this is about staying live during a soundcheck,
 *  not about frame rate. */
const REFRESH_MS = 700;

export function SignalFlowDialog({
  state,
  onClose,
  focusStripId,
  focusStripName,
}: {
  state: WebUiState;
  onClose: () => void;
  /** Stable Core strip identity; never use the strip's current row index. */
  focusStripId?: string;
  focusStripName?: string;
}) {
  const latestState = useRef(state);
  latestState.current = state;
  const openedProject = useRef({
    stateSessionId: state.stateSessionId,
    projectEpoch: state.projectEpoch,
  });
  const [snapshot, setSnapshot] = useState<{ graph: MixGraphPayload; state: WebUiState } | null>(null);
  const [error, setError] = useState(false);
  const [live, setLive] = useState(true);
  const [focusedView, setFocusedView] = useState(Boolean(focusStripId));
  const model = useMemo(() => snapshot ? buildSignalFlowModel(snapshot.graph, snapshot.state) : null, [snapshot]);
  const focus = resolveSignalFlowFocus(model, focusStripId, focusedView,
    openedProject.current, state);
  const focusProjectMatches = focus.projectMatches;
  const focusTargetExists = focus.targetExists;
  const showingFocusedView = focus.focusNodeId !== undefined && focus.focusNodeId !== null;

  useEffect(() => {
    setFocusedView(Boolean(focusStripId));
  }, [focusStripId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await fetchMixGraph();
        if (!cancelled) {
          setSnapshot({ graph: next, state: latestState.current });
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        // One in-flight request, even on a slow remote connection. Frozen
        // mode holds both the audio graph and MIDI configuration together.
        if (!cancelled && live) timer = setTimeout(load, REFRESH_MS);
      }
    };
    if (!live) return;
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [live]);

  return (
    <Modal isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Backdrop>
        <Modal.Container size="cover" placement="center">
          <Modal.Dialog aria-label="Signal flow"
            className="h-[calc(100dvh-3rem)] w-full max-w-350 overflow-hidden p-0">
            <Modal.CloseTrigger />
            <Modal.Header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-default/25 px-4 py-2.5">
              <div className="min-w-0">
                <Modal.Heading className="text-sm font-semibold text-foreground">
                  Signal flow
                </Modal.Heading>
                <p className="truncate text-[11px] text-foreground/45">
                  {focusStripId
                    ? `Core audio routes around ${focusStripName || focusStripId} · physical destinations on the right.`
                    : "Core audio graph and configured MIDI paths · physical destinations on the right."}
                </p>
              </div>

              <div className="ml-auto flex flex-wrap items-center gap-3">
                {focusStripId && (
                  <Button
                    size="sm"
                    variant={showingFocusedView ? "secondary" : "outline"}
                    onPress={() => setFocusedView((value) => !value)}
                    isDisabled={!focusTargetExists}
                    className="h-7! min-h-0! px-2! text-[11px]"
                    aria-label={showingFocusedView ? "Show full signal-flow tree" : `Focus signal flow on ${focusStripName || focusStripId}`}
                  >
                    {showingFocusedView ? "Focused path" : "Full tree"}
                  </Button>
                )}
                <span className="text-[10px] text-foreground/55">Track and mixer colours</span>
                <span className="text-[10px] text-foreground/55">Solid = audio · dotted = MIDI</span>
                <Button
                  size="sm"
                  variant={live ? "secondary" : "outline"}
                  onPress={() => setLive((v) => !v)}
                  className="h-7! min-h-0! px-2! text-[11px]"
                  aria-label={
                    live
                      ? "Following live changes — click to freeze"
                      : "Frozen — click to follow live changes"
                  }
                >
                  <RefreshCw size={12} />
                  {live ? "Live" : "Frozen"}
                </Button>
              </div>
            </Modal.Header>

            <Modal.Body className="min-h-0 flex-1 p-0">
              {error ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-warning">
                  Couldn't read the routing graph from the engine. Is the ResoStage
                  backend running?
                </div>
              ) : model === null ? (
                <div className="flex h-full items-center justify-center text-sm text-foreground/40">
                  Reading routing…
                </div>
              ) : (
                <div className="flex h-full min-h-0 flex-col">
                  {focusStripId && !focusTargetExists && (
                    <div role="status" className="shrink-0 border-b border-warning/25 bg-warning/5 px-4 py-2 text-xs text-warning">
                      {focusProjectMatches
                        ? `${focusStripName || "Focused bus"} is no longer present in the current routing graph. Showing the full graph.`
                        : "The Core project/session changed while Signal Flow was open. The original bus focus was cleared; showing the full graph."}
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
                    <SignalFlowGraph model={model} focusNodeId={focus.focusNodeId} />
                  </div>
                </div>
              )}
            </Modal.Body>

            {model && snapshot && (
              <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-default/25 px-4 py-1.5 text-[10px] text-foreground/40">
                <span>{snapshot.graph.strips.length} audio strips</span>
                <span>{snapshot.graph.edges.length} audio routes</span>
                {model.midiConnections > 0 && <span>{model.midiConnections} MIDI routes</span>}
                <span className="ml-auto">
                  Red dashes = audio muted/soloed · MIDI shows configuration, without delivery telemetry
                </span>
              </div>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
