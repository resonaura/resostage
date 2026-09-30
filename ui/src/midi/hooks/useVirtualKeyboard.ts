import { useCallback, useEffect, useState } from "react";
import { hotkeyManager, HotkeyScope } from "@/lib/interaction/HotkeyManager";

/** Synchronizes the keyboard toggle across the renderer, hotkeys, and Electron window. */
export function useVirtualKeyboard() {
  const [isOpen, setIsOpen] = useState(false);

  const toggle = useCallback(() => {
    if (
      window.resostageElectron?.isElectron &&
      window.resostageElectron.toggleKeyboardWindow
    ) {
      void window.resostageElectron.toggleKeyboardWindow();
    } else {
      setIsOpen((previous) => !previous);
    }
  }, []);

  useEffect(
    () =>
      hotkeyManager.registerActionHandler("toggle_musical_typing", () => {
        toggle();
        return true;
      }),
    [toggle],
  );

  useEffect(() => {
    const mod = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "cmd" : "ctrl";
    return hotkeyManager.registerCommand(
      "keyboard.toggle-musical-typing",
      `${mod} + k`,
      { scope: HotkeyScope.Global, priority: 100 },
      () => {
        toggle();
        return true;
      },
    );
  }, [toggle]);

  useEffect(() => {
    const handleKeyboardState = (event: Event) => {
      setIsOpen(Boolean((event as CustomEvent<boolean>).detail));
    };
    window.addEventListener("resostage-keyboard-state-changed", handleKeyboardState);
    return () =>
      window.removeEventListener("resostage-keyboard-state-changed", handleKeyboardState);
  }, []);

  return { isOpen, setIsOpen, toggle };
}
