/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeHistoryBoundary } from "@/lib/state/historyNavigation";
import type { MidiClipEventRow } from "@/lib/state/types";
import { sameEditableMidiEvents } from "@/screens/editor/pianoroll/logic/controllerLane";

type Status = "idle" | "sending" | "confirming" | "error" | "uncertain";
type PendingEvents = { token: number; events: MidiClipEventRow[] };
type DraftSession = {
  regionId: string;
  resetKey?: string;
  token: number;
  draft: PendingEvents | null;
  admissionsInFlight: number;
  admittedToken: number;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

function copyEvents(events: MidiClipEventRow[]): MidiClipEventRow[] {
  return events.map((event) => ({ ...event, data: [...event.data] }));
}

/**
 * Retains raw controller edits until a complete authoritative region echo.
 * Admission is not treated as application; history/project boundaries retire
 * pending drafts so delayed replies cannot leak into another document.
 */
export function usePianoRollMidiEventDraft({
  regionId,
  resetKey,
  events,
  onEventsChange,
  confirmationTimeoutMs = 8000,
}: {
  regionId: string;
  resetKey?: string;
  events: MidiClipEventRow[];
  onEventsChange?: (events: MidiClipEventRow[]) => void | Promise<void>;
  confirmationTimeoutMs?: number;
}) {
  const [draft, setDraft] = useState<{
    regionId: string;
    resetKey?: string;
    events: MidiClipEventRow[];
  } | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [admissionsPending, setAdmissionsPending] = useState(0);
  const current = useRef<DraftSession | null>(null);
  const mounted = useRef(true);
  const identity = useRef({ regionId, resetKey });
  identity.current = { regionId, resetKey };
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const sender = useRef(onEventsChange);
  sender.current = onEventsChange;

  const retire = useCallback(() => {
    const session = current.current;
    if (session?.timer !== null && session?.timer !== undefined)
      clearTimeout(session.timer);
    current.current = null;
  }, []);
  const discardDraft = useCallback(() => {
    retire();
    setDraft(null);
    setStatus("idle");
    setError(null);
    setAdmissionsPending(0);
  }, [retire]);
  const dispose = useCallback(() => { mounted.current = false; retire(); }, [retire]);
  useEffect(() => { mounted.current = true; return dispose; }, [dispose]);
  useEffect(discardDraft, [regionId, resetKey, discardDraft]);
  useEffect(() => subscribeHistoryBoundary(discardDraft), [discardDraft]);

  const clearTimer = (session: DraftSession) => {
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = null;
  };
  const isCurrent = useCallback((session: DraftSession) => mounted.current
    && current.current === session && session.regionId === identity.current.regionId
    && session.resetKey === identity.current.resetKey, []);
  const confirm = useCallback((session: DraftSession) => {
    if (!isCurrent(session) || session.admissionsInFlight > 0 || !session.draft
      || session.admittedToken !== session.draft.token
      || !sameEditableMidiEvents(session.draft.events, eventsRef.current)) return;
    discardDraft();
  }, [discardDraft, isCurrent]);
  useEffect(() => {
    const session = current.current;
    if (session) confirm(session);
  }, [events, confirm]);

  const sendEvents = useCallback(async (session: DraftSession, pending: PendingEvents): Promise<void> => {
    if (!isCurrent(session)) return;
    const send = sender.current;
    if (!send) {
      if (session.draft?.token === pending.token) {
        clearTimer(session);
        setStatus("error");
        setError("Raw MIDI event editing is unavailable for this region.");
      }
      return;
    }
    ++session.admissionsInFlight;
    setAdmissionsPending(session.admissionsInFlight);
    session.timedOut = false;
    setStatus("sending");
    clearTimer(session);
    session.timer = setTimeout(() => {
      if (!isCurrent(session) || session.draft?.token !== pending.token) return;
      session.timedOut = true;
      setStatus("uncertain");
      setError("Core has not confirmed this MIDI event edit. It may still be queued; wait before retrying.");
    }, Math.max(100, confirmationTimeoutMs));
    try {
      await send(copyEvents(pending.events));
      if (!isCurrent(session)) return;
      --session.admissionsInFlight;
      setAdmissionsPending(session.admissionsInFlight);
      if (session.draft?.token !== pending.token) { confirm(session); return; }
      session.admittedToken = pending.token;
      if (!session.timedOut) setStatus("confirming");
      confirm(session);
    } catch (cause) {
      if (!isCurrent(session)) return;
      --session.admissionsInFlight;
      setAdmissionsPending(session.admissionsInFlight);
      if (session.draft?.token !== pending.token) { confirm(session); return; }
      clearTimer(session);
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Core rejected this MIDI event edit. Your draft is preserved.");
    }
  }, [confirmationTimeoutMs, confirm, isCurrent]);

  const commitEvents = useCallback((nextEvents: MidiClipEventRow[]) => {
    let session = current.current;
    const before = session && isCurrent(session) && session.draft
      ? session.draft.events
      : eventsRef.current;
    if (sameEditableMidiEvents(nextEvents, before)) return;
    if (!session || !isCurrent(session)) {
      retire();
      session = {
        regionId,
        resetKey,
        token: 0,
        draft: null,
        admissionsInFlight: 0,
        admittedToken: -1,
        timedOut: false,
        timer: null,
      };
      current.current = session;
    }
    const pending = { token: ++session.token, events: copyEvents(nextEvents) };
    session.draft = pending;
    setDraft({ regionId, resetKey, events: pending.events });
    setError(null);
    void sendEvents(session, pending);
  }, [regionId, resetKey, sendEvents, isCurrent, retire]);

  const retryDraft = useCallback(() => {
    const session = current.current;
    if (status !== "error" || !session?.draft || !isCurrent(session)
      || session.admissionsInFlight > 0)
      return;
    session.draft = { ...session.draft, token: ++session.token };
    setError(null);
    void sendEvents(session, session.draft);
  }, [sendEvents, status, isCurrent]);
  const draftIsCurrent = draft?.regionId === regionId && draft.resetKey === resetKey;
  const editableEvents = draftIsCurrent ? draft.events : events;

  return {
    editableEvents,
    commitEvents,
    discardDraft,
    retryDraft,
    error: draftIsCurrent ? error : null,
    status: draftIsCurrent ? status : "idle" as Status,
    canRetry: draftIsCurrent && status === "error" && admissionsPending === 0,
  };
}
