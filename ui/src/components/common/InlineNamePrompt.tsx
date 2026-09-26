import { createPortal } from "react-dom";

/**
 * A one-field prompt that opens where a context menu just was.
 *
 * It exists as its own component because a text field cannot live inside
 * ContextMenu. Under Electron that menu is a native OS popup: everything
 * passed as children is turned into `NativeMenuItem`s and the React subtree is
 * never rendered at all, so a form nested in there is invisible -- and
 * "Rename..." looked like a dead menu item in the packaged app while working
 * perfectly in a browser tab.
 *
 * Rendering it as a sibling of the menu instead of a child keeps both paths
 * honest: the menu picks the action, this collects the text.
 */
export function InlineNamePrompt({
  x,
  y,
  value,
  placeholder,
  width = 176,
  onChange,
  onCommit,
  onCancel,
}: {
  x: number;
  y: number;
  value: string;
  placeholder?: string;
  width?: number;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[9998]"
        onClick={onCancel}
        onContextMenu={(e) => {
          e.preventDefault();
          onCancel();
        }}
      />
      <form
        className="fixed z-[9999] rounded-xl border border-default/40 bg-surface/95 p-2 shadow-2xl backdrop-blur-md"
        style={{ left: x, top: y, width }}
        onSubmit={(e) => {
          e.preventDefault();
          onCommit();
        }}
      >
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            // The menu that opened this is gone; nothing above should act on
            // a keystroke meant for a text field (Space is a transport key).
            e.stopPropagation();
          }}
          className="w-full rounded border border-default/40 bg-default/20 px-1.5 py-1 text-xs text-foreground focus:outline-none"
        />
      </form>
    </>,
    document.body,
  );
}
