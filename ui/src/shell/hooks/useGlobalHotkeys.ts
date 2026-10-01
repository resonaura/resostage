/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Renderer-side global and fixed keyboard dispatch owner.
// Components register local gestures with HotkeyManager; app-wide project,
// transport, typing-focus, and native-shell shortcuts converge here.

import { useEffect, useRef } from "react";
import { performAction, type ActionId } from "@/lib/state/actions";
import { transport } from "@/lib/state/api";
import { apiFetch } from "@/lib/state/backend";
import { IS_ELECTRON } from "@/lib/platform/electron";
import { IS_EMBEDDED } from "@/lib/platform/embedded";
import { sendTypingFocus } from "@/lib/platform/electronBridge";
import { hotkeyManager, HotkeyScope } from "@/lib/interaction/HotkeyManager";
import type { WebUiState } from "@/lib/state/types";

export function useGlobalHotkeys(
  state: WebUiState,
  setTab: (tab: string) => void,
  isVirtualKeyboardOpen: boolean,
) {
  const playingRef = useRef(state.playing);
  playingRef.current = state.playing;
  const playheadRef = useRef(state.playheadSeconds);
  playheadRef.current = state.playheadSeconds;
  const songsRef = useRef(state.songs);
  songsRef.current = state.songs;
  const songIndexRef = useRef(state.songIndex);
  songIndexRef.current = state.songIndex;
  const lastSpaActionRef = useRef("");
  const lastSpaActionAtRef = useRef(0);
  const bindingSignature = state.settings.keybindings
    .map((binding) => `${binding.action}:${binding.key}`)
    .join("|");

  useEffect(() => hotkeyManager.mount(), []);
  useEffect(() => {
    hotkeyManager.setConfiguredBindings(state.settings.keybindings);
  }, [bindingSignature]);
  useEffect(() => {
    hotkeyManager.setMusicalTypingActive(isVirtualKeyboardOpen);
  }, [isVirtualKeyboardOpen]);

  // Native hosts retain the OS-level capture adapter. In Electron, the shell
  // forwards captured global actions to HotkeyManager; in a browser,
  // HotkeyManager matches the persisted binding snapshot itself. In both
  // cases action handlers and scoped editor commands have one renderer owner.
  // The shell cannot inspect DOM focus, so keep its typing guard synchronized.
  useEffect(() => {
    if (!IS_ELECTRON) return;
    const update = () => {
      const el = document.activeElement as HTMLElement | null;
      const isInput =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      sendTypingFocus(
        isInput ||
          el?.tagName === "SELECT" ||
          isVirtualKeyboardOpen,
      );
    };
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      sendTypingFocus(false);
    };
  }, [isVirtualKeyboardOpen]);

  useEffect(() => {
    const unbind = state.settings.keybindings.map(({ action }) =>
      hotkeyManager.registerActionHandler(action, (event) => {
        const now = Date.now();
        if (
          action === lastSpaActionRef.current &&
          now - lastSpaActionAtRef.current < 120
        ) return true;
        lastSpaActionRef.current = action;
        lastSpaActionAtRef.current = now;

        void apiFetch("/api/v1/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }).catch(() => {
          performAction(
            action as ActionId,
            songsRef.current,
            songIndexRef.current,
            playheadRef.current,
            setTab,
            playingRef.current,
          );
        });
        if (action.startsWith("mode_")) {
          const tabId = action.replace("mode_", "");
          if (["player", "mixer", "editor", "light", "settings"].includes(tabId))
            setTab(tabId);
        }
        if (event?.code === "Space") event.preventDefault();
        return true;
      }),
    );
    const unbindBuiltins = [
      ...Array.from({ length: 9 }, (_, index) =>
        hotkeyManager.registerCommand(
          `song-select-${index + 1}`,
          String(index + 1),
          { scope: HotkeyScope.Global, priority: 0 },
          () => {
            void transport.select(index);
            return true;
          },
        ),
      ),
      hotkeyManager.registerCommand(
        "stop-and-rewind",
        "0",
        { scope: HotkeyScope.Global, priority: 0 },
        () => {
          void apiFetch("/api/v1/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "stop_to_start" }),
          }).catch(() => {
            void transport.stop();
            void transport.seek(0);
          });
          return true;
        },
      ),
      hotkeyManager.registerCommand(
        "seek-to-start",
        "home",
        { scope: HotkeyScope.Global, priority: 0 },
        () => {
          void transport.seek(0);
          return true;
        },
      ),
    ];
    const onShellHotkey = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      if (action) hotkeyManager.dispatchAction(action);
    };
    window.addEventListener("resostage-hotkey", onShellHotkey);
    return () => {
      unbind.forEach((dispose) => dispose());
      unbindBuiltins.forEach((dispose) => dispose());
      window.removeEventListener("resostage-hotkey", onShellHotkey);
    };
  }, [bindingSignature, setTab]);

  // Text-field focus signal: tell the native side when an editable element
  // is focused so MacKeyMonitor suppresses hotkeys (embedded only).
  useEffect(() => {
    if (!IS_EMBEDDED) return;
    const sendFocus = (focused: boolean) => {
      void apiFetch("/api/v1/ui/focus-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ focused }),
      }).catch(() => {});
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        sendFocus(true);
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        sendFocus(false);
      }
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
}
