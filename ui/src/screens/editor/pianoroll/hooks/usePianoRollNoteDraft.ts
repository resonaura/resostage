/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeHistoryBoundary } from "@/lib/state/historyNavigation";
import type { MidiNoteRow } from "@/lib/state/types";

/** Complete editable-note comparison, independent of Core's time sorting. */
export function sameEditableNotes(left: MidiNoteRow[], right: MidiNoteRow[]): boolean {
  if (left.length !== right.length) return false;
  const byId = new Map(right.map((note) => [note.id, note]));
  if (byId.size !== right.length || new Set(left.map((note) => note.id)).size !== left.length) return false;
  return left.every((note) => {
    const actual = byId.get(note.id);
    if (!actual || actual.pitch !== note.pitch
      || Math.abs(actual.startBeats - note.startBeats) >= 1e-4
      || Math.abs(actual.durationBeats - note.durationBeats) >= 1e-4
      || Math.abs(actual.velocity - note.velocity) >= 1e-6
      || Math.abs((actual.releaseVelocity ?? 0.5) - (note.releaseVelocity ?? 0.5)) >= 1e-6
      || Math.abs((actual.probability ?? 1) - (note.probability ?? 1)) >= 1e-6
      || (actual.pan ?? -1) !== (note.pan ?? -1)
      || (actual.tuningOffsetCents ?? 0) !== (note.tuningOffsetCents ?? 0)
      || (actual.muted ?? false) !== (note.muted ?? false)
      || (actual.channel ?? 0) !== (note.channel ?? 0)) return false;
    if (!actual.midi2 || !note.midi2) return !actual.midi2 && !note.midi2;
    return actual.midi2.group === note.midi2.group
      && actual.midi2.velocity === note.midi2.velocity
      && actual.midi2.releaseVelocity === note.midi2.releaseVelocity
      && actual.midi2.attributeType === note.midi2.attributeType
      && actual.midi2.attributeData === note.midi2.attributeData;
  });
}

type Status = "idle" | "sending" | "confirming" | "error" | "uncertain";
type PendingNotes = { token: number; notes: MidiNoteRow[] };
type DraftSession = {
  regionId: string;
  resetKey?: string;
  token: number;
  draft: PendingNotes | null;
  admissionsInFlight: number;
  admittedToken: number;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * Each completed gesture enters the shared API command serializer immediately,
 * keeping it ordered before Undo. Admission is separate from a full Core echo;
 * rejected edits remain recoverable drafts. Region/history changes retire the
 * session so late results cannot win.
 */
export function usePianoRollNoteDraft({ regionId, resetKey, notes, onNotesChange,
  confirmationTimeoutMs = 8000 }: {
  regionId: string;
  /** Project epoch/name identity; IDs may be reused by a reopened project. */
  resetKey?: string;
  notes: MidiNoteRow[];
  onNotesChange: (notes: MidiNoteRow[]) => void | Promise<void>;
  confirmationTimeoutMs?: number;
}) {
  const [draft, setDraft] = useState<{ regionId: string; resetKey?: string; notes: MidiNoteRow[] } | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [admissionsPending, setAdmissionsPending] = useState(0);
  const current = useRef<DraftSession | null>(null);
  const mounted = useRef(true);
  const identity = useRef({ regionId, resetKey });
  identity.current = { regionId, resetKey };
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const sender = useRef(onNotesChange);
  sender.current = onNotesChange;

  const retire = useCallback(() => {
    const session = current.current;
    if (session?.timer !== null && session?.timer !== undefined) clearTimeout(session.timer);
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
      || !sameEditableNotes(session.draft.notes, notesRef.current)) return;
    discardDraft();
  }, [discardDraft, isCurrent]);
  useEffect(() => {
    const session = current.current;
    if (session) confirm(session);
  }, [notes, confirm]);

  const sendNotes = useCallback(async (session: DraftSession, pending: PendingNotes): Promise<void> => {
    if (!isCurrent(session)) return;
    ++session.admissionsInFlight;
    setAdmissionsPending(session.admissionsInFlight);
    session.timedOut = false;
    setStatus("sending");
    clearTimer(session);
    session.timer = setTimeout(() => {
      if (!isCurrent(session) || session.draft?.token !== pending.token) return;
      session.timedOut = true;
      setStatus("uncertain");
      setError("Core has not confirmed this note edit. It may still be queued; wait before retrying.");
    }, Math.max(100, confirmationTimeoutMs));
    try {
      await sender.current(pending.notes);
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
      setError(cause instanceof Error ? cause.message : "Core rejected this note edit. Your draft is preserved.");
    }
  }, [confirmationTimeoutMs, confirm, isCurrent]);

  const commitNotes = useCallback((nextNotes: MidiNoteRow[]) => {
    let session = current.current;
    const before = session && isCurrent(session) && session.draft ? session.draft.notes : notesRef.current;
    if (sameEditableNotes(nextNotes, before)) return;
    if (!session || !isCurrent(session)) {
      retire();
      session = { regionId, resetKey, token: 0, draft: null, admissionsInFlight: 0,
        admittedToken: -1, timedOut: false, timer: null };
      current.current = session;
    }
    // Match the persisted MIDI 2.0 shadow before awaiting a complete echo.
    // Unedited 16-bit values remain lossless; normalized velocity edits update
    // only the corresponding shadow, never group or per-note attributes.
    const authoritative = new Map(notesRef.current.map((note) => [note.id, note]));
    const snapshot = nextNotes.map((note) => {
      if (!note.midi2) return { ...note };
      const midi2 = { ...note.midi2 };
      const previous = authoritative.get(note.id);
      if (previous && note.velocity !== previous.velocity)
        midi2.velocity = Math.max(0, Math.min(0xffff, Math.round(note.velocity * 0xffff)));
      if (previous && note.releaseVelocity !== previous.releaseVelocity)
        midi2.releaseVelocity = Math.max(0, Math.min(0xffff, Math.round(note.releaseVelocity * 0xffff)));
      return { ...note, midi2 };
    });
    const pending = { token: ++session.token, notes: snapshot };
    session.draft = pending;
    setDraft({ regionId, resetKey, notes: snapshot });
    setError(null);
    void sendNotes(session, pending);
  }, [regionId, resetKey, sendNotes, isCurrent, retire]);

  const retryDraft = useCallback(() => {
    const session = current.current;
    if (status !== "error" || !session?.draft || !isCurrent(session) || session.admissionsInFlight > 0) return;
    session.draft = { ...session.draft, token: ++session.token };
    setError(null);
    void sendNotes(session, session.draft);
  }, [sendNotes, status, isCurrent]);
  const draftIsCurrent = draft?.regionId === regionId && draft.resetKey === resetKey;
  const editableNotes = draftIsCurrent ? draft.notes : notes;
  const getEditableNotes = useCallback(() => {
    const session = current.current;
    return session && isCurrent(session) && session.draft ? session.draft.notes : notesRef.current;
  }, [isCurrent]);

  return { editableNotes, getEditableNotes, commitNotes, discardDraft, retryDraft,
    error: draftIsCurrent ? error : null, status: draftIsCurrent ? status : "idle" as Status,
    canRetry: draftIsCurrent && status === "error" && admissionsPending === 0,
    isPending: draftIsCurrent && (status === "sending" || status === "confirming") };
}
