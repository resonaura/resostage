import { Kbd } from "@heroui/react";
import type { KbdKey } from "@heroui/react";

/**
 * A keyboard shortcut, rendered as keys rather than as a string.
 *
 * Takes the same descriptions JUCE's `KeyPress::createFromDescription` reads
 * and the backend stores -- "cmd + p", "space", "shift + n" -- so the
 * settings list can hand its stored binding straight in without a parallel
 * format to keep in sync.
 *
 * Deliberately backgroundless. HeroUI's Kbd ships a filled chip, which is
 * right in prose and wrong here: these sit inside buttons and tooltips that
 * already have a surface, and a chip on a chip reads as two controls.
 */

/** Modifier names JUCE emits, mapped to what Kbd.Abbr knows. */
const MODIFIERS: Record<string, KbdKey> = {
  cmd: "command",
  command: "command",
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "option",
  opt: "option",
  win: "win",
};

/** Named keys with a glyph of their own. */
const NAMED: Record<string, KbdKey> = {
  space: "space",
  enter: "enter",
  return: "enter",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  delete: "delete",
  backspace: "delete",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
};

export function KeyHint({
  binding,
  className = "",
}: {
  /** e.g. "cmd + shift + p". Empty renders nothing. */
  binding: string;
  className?: string;
}) {
  const parts = binding
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const mods = parts.filter((p) => p in MODIFIERS);
  const rest = parts.filter((p) => !(p in MODIFIERS));

  return (
    <Kbd variant="light" className={`rs-kbd-bare ${className}`}>
      {mods.map((m) => (
        <Kbd.Abbr key={m} keyValue={MODIFIERS[m]} />
      ))}
      {rest.map((k) =>
        k in NAMED ? (
          <Kbd.Abbr key={k} keyValue={NAMED[k]} />
        ) : (
          <Kbd.Content key={k}>{k.toUpperCase()}</Kbd.Content>
        ),
      )}
    </Kbd>
  );
}
