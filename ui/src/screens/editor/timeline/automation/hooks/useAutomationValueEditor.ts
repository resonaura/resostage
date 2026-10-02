/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeHistoryBoundary } from "@/lib/state/historyNavigation";

interface ValueEditSession {
  identity: string;
  selection: string;
  x: number;
  y: number;
  initialValue: number;
}

const selectionKey = (indices: Iterable<number>) => Array.from(indices).sort((a, b) => a - b).join(",");

/** One exact-value edit owns its original lane/selection until settled once.
 * Cancel retires the session before focus restoration can synchronously blur
 * the input. History/project/selection changes never submit stale values.
 */
export function useAutomationValueEditor(identity: string, selected: Set<number>,
  onCommit: (value: number) => void) {
  const [editor, setEditor] = useState<ValueEditSession | null>(null);
  const active = useRef<ValueEditSession | null>(null);
  const context = useRef({ identity, selection: selectionKey(selected), onCommit });
  context.current = { identity, selection: selectionKey(selected), onCommit };
  const closeEditor = useCallback(() => { active.current = null; setEditor(null); }, []);
  useEffect(() => subscribeHistoryBoundary(closeEditor), [closeEditor]);
  useEffect(() => {
    if (active.current && (active.current.identity !== context.current.identity
      || active.current.selection !== context.current.selection)) closeEditor();
  }, [identity, context.current.selection, closeEditor]);
  useEffect(() => () => { active.current = null; }, []);

  const openEditor = (x: number, y: number, initialValue: number, indices: Iterable<number> = selected) => {
    const session = { identity, selection: selectionKey(indices), x, y, initialValue };
    active.current = session;
    setEditor(session);
  };
  const submitEditor = (value: number) => {
    const session = active.current;
    closeEditor();
    if (session && session.identity === context.current.identity
      && session.selection === context.current.selection && Number.isFinite(value)
      && value !== session.initialValue) context.current.onCommit(value);
  };
  return { editor: editor?.identity === identity && editor.selection === context.current.selection ? editor : null,
    openEditor, closeEditor, submitEditor };
}
