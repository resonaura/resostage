/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useRef, useState } from "react";
import { EDITOR_COMMAND_FAILURE_EVENT } from "@/lib/state/api";

/** Shows bounded fire-and-forget editor failures without leaking promise rejections. */
export function useEditorCommandFailure(): string {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleFailure = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown }>).detail;
      if (typeof detail?.message !== "string" || detail.message.length === 0) return;
      setMessage(detail.message.slice(0, 320));
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setMessage("");
      }, 6000);
    };

    window.addEventListener(EDITOR_COMMAND_FAILURE_EVENT, handleFailure);
    return () => {
      window.removeEventListener(EDITOR_COMMAND_FAILURE_EVENT, handleFailure);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  return message;
}
