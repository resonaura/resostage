/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeHistoryBoundary } from "@/lib/state/historyNavigation";

export type ReliableRegionDraftStatus = "idle" | "sending" | "confirming" | "error" | "uncertain";

interface PendingValue<T> {
  token: number;
  value: T;
}

interface DraftSession<T> {
  regionId: string;
  resetKey?: string;
  token: number;
  draft: PendingValue<T> | null;
  admissionsInFlight: number;
  admittedToken: number;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Shared reliable-edit lifecycle for independently typed MIDI event
 * collections. Admission is not project application: drafts persist until the
 * full authoritative collection is echoed, and history/identity changes retire
 * the session so delayed replies cannot leak into another region or project.
 */
export function usePianoRollReliableCollectionDraft<T>({
  regionId,
  resetKey,
  value,
  onChange,
  copy,
  equals,
  confirmationTimeoutMs = 8000,
  unavailableMessage,
  confirmationMessage,
  rejectionMessage,
}: {
  regionId: string;
  resetKey?: string;
  value: T;
  onChange?: (value: T) => void | Promise<void>;
  copy: (value: T) => T;
  equals: (left: T, right: T) => boolean;
  confirmationTimeoutMs?: number;
  unavailableMessage: string;
  confirmationMessage: string;
  rejectionMessage: string;
}) {
  const [draft, setDraft] = useState<{
    regionId: string;
    resetKey?: string;
    value: T;
  } | null>(null);
  const [status, setStatus] = useState<ReliableRegionDraftStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [admissionsPending, setAdmissionsPending] = useState(0);
  const current = useRef<DraftSession<T> | null>(null);
  const mounted = useRef(true);
  const identity = useRef({ regionId, resetKey });
  identity.current = { regionId, resetKey };
  const valueRef = useRef(value);
  valueRef.current = value;
  const sender = useRef(onChange);
  sender.current = onChange;

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

  const clearTimer = (session: DraftSession<T>) => {
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = null;
  };
  const isCurrent = useCallback((session: DraftSession<T>) => mounted.current
    && current.current === session && session.regionId === identity.current.regionId
    && session.resetKey === identity.current.resetKey, []);
  const confirm = useCallback((session: DraftSession<T>) => {
    if (!isCurrent(session) || session.admissionsInFlight > 0 || !session.draft
        || session.admittedToken !== session.draft.token
        || !equals(session.draft.value, valueRef.current)) return;
    discardDraft();
  }, [discardDraft, equals, isCurrent]);
  useEffect(() => {
    const session = current.current;
    if (session) confirm(session);
  }, [value, confirm]);

  const sendValue = useCallback(async (
    session: DraftSession<T>,
    pending: PendingValue<T>,
  ): Promise<void> => {
    if (!isCurrent(session)) return;
    const send = sender.current;
    if (!send) {
      if (session.draft?.token === pending.token) {
        clearTimer(session);
        setStatus("error");
        setError(unavailableMessage);
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
      setError(confirmationMessage);
    }, Math.max(100, confirmationTimeoutMs));
    try {
      await send(copy(pending.value));
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
      setError(cause instanceof Error ? cause.message : rejectionMessage);
    }
  }, [confirmationMessage, confirmationTimeoutMs, confirm, copy, isCurrent, rejectionMessage, unavailableMessage]);

  const commitValue = useCallback((nextValue: T) => {
    let session = current.current;
    const before = session && isCurrent(session) && session.draft
      ? session.draft.value
      : valueRef.current;
    if (equals(nextValue, before)) return;
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
    const pending = { token: ++session.token, value: copy(nextValue) };
    session.draft = pending;
    setDraft({ regionId, resetKey, value: pending.value });
    setError(null);
    void sendValue(session, pending);
  }, [copy, equals, regionId, resetKey, sendValue, isCurrent, retire]);

  const retryDraft = useCallback(() => {
    const session = current.current;
    if (status !== "error" || !session?.draft || !isCurrent(session)
        || session.admissionsInFlight > 0) return;
    session.draft = { ...session.draft, token: ++session.token };
    setError(null);
    void sendValue(session, session.draft);
  }, [isCurrent, sendValue, status]);
  const draftIsCurrent = draft?.regionId === regionId && draft.resetKey === resetKey;

  return {
    editableValue: draftIsCurrent ? draft.value : value,
    commitValue,
    discardDraft,
    retryDraft,
    error: draftIsCurrent ? error : null,
    status: draftIsCurrent ? status : "idle" as ReliableRegionDraftStatus,
    canRetry: draftIsCurrent && status === "error" && admissionsPending === 0,
  };
}
