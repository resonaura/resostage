// Best-effort mirror of juce::KeyPress::getTextDescription()'s format
// ("cmd + p", "space", "escape", ...) -- covers the common single-key and
// simple-modifier-combo rebinds; exotic combos may need a manual nudge.
export function keyEventToDescription(e: KeyboardEvent): string | null {
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return null; // wait for a real key
  if (
    e.key === "Escape" &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey
  )
    return "__cancel__";

  const parts: string[] = [];
  if (e.metaKey) parts.push("cmd");
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");

  const named: Record<string, string> = {
    " ": "space",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Enter: "return",
    Tab: "tab",
    Backspace: "backspace",
    Delete: "delete",
    Home: "home",
    End: "end",
    PageUp: "page up",
    PageDown: "page down",
    Escape: "escape",
  };
  // Function keys (F1-F12) already come through as "f1".."f12"; everything
  // else just gets lowercased.
  const key = named[e.key] ?? e.key.toLowerCase();

  parts.push(key);
  return parts.join(" + ");
}
