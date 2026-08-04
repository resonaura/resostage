import { AnimatePresence, motion } from "framer-motion";
import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { IS_ELECTRON } from "../lib/electron";
import { IS_EMBEDDED } from "../lib/embedded";

/**
 * Wire format for Electron's native Menu (see electron main
 * `show-context-menu`). Checkbox items use Electron's `type: "checkbox"` so
 * macOS / Windows draw the platform checkmark — not a text "✓" hack.
 */
export type NativeMenuItem =
  | {
      type: "item";
      id: string;
      label: string;
      danger?: boolean;
      disabled?: boolean;
      /** When set, item is a checkbox (native checkmark in Electron). */
      checked?: boolean;
    }
  | { type: "separator" };

type BridgeWindow = typeof window & {
  resostageElectron?: {
    isElectron?: boolean;
    showContextMenu?: (
      items: NativeMenuItem[],
      x: number,
      y: number,
    ) => Promise<string | null>;
  };
};

function extractLabel(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractLabel).join("").trim();
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return extractLabel(props.children);
  }
  return "";
}

function collectNativeItems(children: ReactNode): {
  items: NativeMenuItem[];
  handlers: Map<string, () => void>;
} {
  const items: NativeMenuItem[] = [];
  const handlers = new Map<string, () => void>();
  let n = 0;
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const t = child.type as { displayName?: string; name?: string };
    const name = t.displayName || t.name || "";
    if (name === "ContextMenuDivider") {
      items.push({ type: "separator" });
      return;
    }
    if (name === "ContextMenuItem") {
      const props = child.props as {
        children?: ReactNode;
        danger?: boolean;
        disabled?: boolean;
        checked?: boolean;
        onClick: () => void;
      };
      const id = `item-${n++}`;
      const item: NativeMenuItem = {
        type: "item",
        id,
        label: extractLabel(props.children) || "…",
        danger: props.danger,
        disabled: props.disabled,
      };
      // Only mark as checkbox when `checked` is explicitly boolean — plain
      // action items stay type "item" without a check column.
      if (typeof props.checked === "boolean") {
        item.checked = props.checked;
      }
      items.push(item);
      handlers.set(id, props.onClick);
    }
  });
  return { items, handlers };
}

/**
 * Shared right-click menu shell for the whole app.
 *
 * When running under Electron (or embedded with the Electron bridge), items
 * are shown via a native OS menu (checkbox items use platform checkmarks).
 * Otherwise a custom portaled panel is used with a reserved check column.
 */
export function ContextMenu({
  x,
  y,
  onClose,
  width = 192,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>(
    { left: x, top: y, ready: false },
  );
  // Keep latest handlers/onClose without re-opening the native menu on every
  // parent re-render (children identity changes constantly).
  const handlersRef = useRef<Map<string, () => void>>(new Map());
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const bridge = (window as BridgeWindow).resostageElectron;
  const useNative =
    (IS_ELECTRON || IS_EMBEDDED) &&
    typeof bridge?.showContextMenu === "function";

  const { items: nativeItems, handlers: nativeHandlers } =
    collectNativeItems(children);
  handlersRef.current = nativeHandlers;
  // Stable key for menu content — reopen only when labels/flags/coords change.
  const nativeItemsKey = JSON.stringify(nativeItems);

  // Any checkbox item in the tree → reserve check column in the DOM menu.
  const hasCheckable = nativeItems.some(
    (it) => it.type === "item" && typeof it.checked === "boolean",
  );

  // Native path (Electron shell with preload bridge).
  useEffect(() => {
    if (!useNative) return;
    const items = JSON.parse(nativeItemsKey) as NativeMenuItem[];
    let cancelled = false;
    void bridge!.showContextMenu!(items, x, y)
      .then((id) => {
        if (cancelled) return;
        if (id) handlersRef.current.get(id)?.();
        onCloseRef.current();
      })
      .catch(() => {
        if (!cancelled) onCloseRef.current();
      });
    return () => {
      cancelled = true;
    };
  }, [useNative, x, y, nativeItemsKey, bridge]);

  useLayoutEffect(() => {
    if (useNative) return;
    const el = menuRef.current;
    if (!el) return;
    const pad = 8;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - pad)
      left = Math.max(pad, window.innerWidth - r.width - pad);
    if (top + r.height > window.innerHeight - pad)
      top = Math.max(pad, window.innerHeight - r.height - pad);
    if (left < pad) left = pad;
    if (top < pad) top = pad;
    setPos({ left, top, ready: true });
  }, [x, y, useNative]);

  useEffect(() => {
    if (useNative) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, useNative]);

  if (useNative) return null;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[9998]"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <AnimatePresence>
        <motion.div
          ref={menuRef}
          key="ctx-menu"
          data-has-checkable={hasCheckable ? "1" : "0"}
          initial={{ opacity: 0, scale: 0.94, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.94 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
          className="fixed z-[9999] overflow-hidden rounded-xl border border-default/40 bg-surface/95 backdrop-blur-md py-1 text-xs shadow-2xl"
          style={{
            left: pos.left,
            top: pos.top,
            width,
            visibility: pos.ready ? "visible" : "hidden",
          }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </>,
    document.body,
  );
}

export function ContextMenuItem({
  children,
  danger = false,
  disabled = false,
  checked,
  onClick,
}: {
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /**
   * When a boolean, this item is a toggle/checkbox:
   * - Electron: native `type: "checkbox"` with OS checkmark
   * - DOM menu: reserved leading check column
   * Omit for ordinary action items.
   */
  checked?: boolean;
  onClick: () => void;
}) {
  const isCheckable = typeof checked === "boolean";
  return (
    <button
      type="button"
      role={isCheckable ? "menuitemcheckbox" : "menuitem"}
      aria-checked={isCheckable ? checked : undefined}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors disabled:opacity-30 disabled:cursor-default ${
        danger
          ? "text-danger hover:bg-danger/10"
          : "text-foreground/80 hover:bg-default/20"
      }`}
    >
      {isCheckable && (
        <span
          className="inline-flex w-3.5 shrink-0 items-center justify-center text-[11px] font-semibold text-accent"
          aria-hidden
        >
          {checked ? "✓" : ""}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
ContextMenuItem.displayName = "ContextMenuItem";

export function ContextMenuDivider() {
  return <div className="my-1 h-px bg-default/20" />;
}
ContextMenuDivider.displayName = "ContextMenuDivider";
