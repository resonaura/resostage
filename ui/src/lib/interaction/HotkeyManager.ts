/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { keyEventToDescription } from "@/lib/interaction/keyEvents";

/** Application-wide shortcut domains. A command only fires in its active domain. */
export const HotkeyScope = {
  Global: "global",
  Timeline: "timeline",
  PianoRoll: "piano-roll",
  MusicalTyping: "musical-typing",
} as const;
export type HotkeyScope = (typeof HotkeyScope)[keyof typeof HotkeyScope];

export interface ConfiguredHotkey {
  action: string;
  key: string;
}

export interface HotkeyCommandOptions {
  scope: HotkeyScope;
  /** Commands are immutable unless they are part of Core's persisted bindings. */
  priority?: number;
  allowInTextInput?: boolean;
}

type HotkeyHandler = (event?: KeyboardEvent) => boolean | void;

interface RegisteredCommand {
  id: string;
  key: string;
  options: HotkeyCommandOptions;
  handler: HotkeyHandler;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

/**
 * The sole renderer-side keyboard dispatcher.
 *
 * Components register typed commands rather than owning window listeners. Core
 * remains the persistence authority for user-rebindable actions; this manager
 * consumes that settings snapshot and routes both local browser events and
 * shortcut intents received from the Electron shell through the same handlers.
 * Fixed editor gestures are registered with a scope and cannot be rebound.
 */
export class HotkeyManager {
  private target: Window | null = null;
  private configuredBindings: ConfiguredHotkey[] = [];
  private readonly handlers = new Map<string, Set<HotkeyHandler>>();
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly activeScopes = new Map<HotkeyScope, boolean>([
    [HotkeyScope.Global, true],
  ]);
  private musicalTypingActive = false;
  private readonly keyCaptureTokens = new Set<symbol>();

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) return;
    if (this.keyCaptureTokens.size > 0) return;
    let description = keyEventToDescription(event);
    if (description === "__cancel__") description = "escape";
    if (!description) return;
    const modified = event.metaKey || event.ctrlKey || event.altKey;
    const editable = isEditableTarget(event.target);

    // Musical typing reserves bare keys for note input. Modified application
    // commands remain available, as do explicitly registered MIDI-key commands.
    const blockBareGlobal = this.musicalTypingActive && !modified;
    const candidates = [...this.commands.values()]
      .filter((command) =>
        this.activeScopes.get(command.options.scope) === true &&
        command.key.toLowerCase() === description.toLowerCase() &&
        (!editable || command.options.allowInTextInput === true) &&
        (!blockBareGlobal || command.options.scope === HotkeyScope.MusicalTyping),
      )
      .sort((a, b) => (b.options.priority ?? 0) - (a.options.priority ?? 0));

    // High-priority scoped editor commands win over global configurable keys;
    // low-priority built-ins run only when no configured binding matched.
    const scoped = candidates.filter((command) => (command.options.priority ?? 0) > 10);
    for (const command of scoped) {
      if (command.handler(event) === false) continue;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (editable || blockBareGlobal) return;
    const binding = this.configuredBindings.find(
      (candidate) =>
        candidate.key &&
        candidate.key.toLowerCase() === description.toLowerCase(),
    );
    if (binding && this.dispatchAction(binding.action, event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    for (const command of candidates) {
      if ((command.options.priority ?? 0) > 10) continue;
      if (command.handler(event) === false) continue;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  };

  mount(target: Window = window): () => void {
    if (this.target !== target) {
      this.target?.removeEventListener("keydown", this.onKeyDown, true);
      this.target = target;
      this.target.addEventListener("keydown", this.onKeyDown, true);
    }
    return () => {
      if (this.target !== target) return;
      this.target.removeEventListener("keydown", this.onKeyDown, true);
      this.target = null;
    };
  }

  setConfiguredBindings(bindings: ConfiguredHotkey[]): void {
    this.configuredBindings = bindings.filter((binding) => binding.key);
  }

  getShortcutForAction(action: string): string | undefined {
    return this.configuredBindings.find((binding) => binding.action === action)?.key;
  }

  getShortcutForCommand(id: string): string | undefined {
    return [...this.commands.values()].find((command) => command.id === id)?.key;
  }

  setScopeActive(scope: HotkeyScope, active: boolean): void {
    this.activeScopes.set(scope, active);
  }

  setMusicalTypingActive(active: boolean): void {
    this.musicalTypingActive = active;
  }

  beginKeyCapture(): () => void {
    const token = Symbol("key-capture");
    this.keyCaptureTokens.add(token);
    return () => this.keyCaptureTokens.delete(token);
  }

  registerActionHandler(action: string, handler: HotkeyHandler): () => void {
    const current = this.handlers.get(action) ?? new Set<HotkeyHandler>();
    current.add(handler);
    this.handlers.set(action, current);
    return () => {
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(action);
    };
  }

  registerCommand(
    id: string,
    key: string,
    options: HotkeyCommandOptions,
    handler: HotkeyHandler,
  ): () => void {
    const registrationId = `${id}:${Math.random().toString(36).slice(2)}`;
    this.commands.set(registrationId, { id, key, options, handler });
    return () => this.commands.delete(registrationId);
  }

  dispatchAction(action: string, event?: KeyboardEvent): boolean {
    if (this.keyCaptureTokens.size > 0) return false;
    // Electron delivers native accelerators here without a DOM KeyboardEvent.
    // The browser keydown filter therefore cannot protect Musical Typing from
    // song navigation on that path. Keep these two global navigation actions
    // reserved while the virtual keyboard is open, regardless of origin.
    if (this.musicalTypingActive && (action === "prev" || action === "next"))
      return false;
    const actionHandlers = this.handlers.get(action);
    if (!actionHandlers?.size) return false;
    for (const handler of [...actionHandlers]) {
      if (handler(event) === false) continue;
      return true;
    }
    return false;
  }
}

export const hotkeyManager = new HotkeyManager();
