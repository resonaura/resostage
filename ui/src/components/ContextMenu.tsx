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

export type NativeMenuItem =
  | {
      type: "item";
      id: string;
      label: string;
      danger?: boolean;
      disabled?: boolean;
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

/**
 * Shared right-click menu shell for the whole app.
 *
 * When running under Electron (or embedded with the Electron bridge), items
 * are shown via a native OS menu. Otherwise a custom portaled panel is used.
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

  // Native path (Electron / embedded Electron shell).
  useEffect(() => {
    const bridge = (window as BridgeWindow).resostageElectron;
    const useNative =
      (IS_ELECTRON || IS_EMBEDDED) &&
      typeof bridge?.showContextMenu === "function";
    if (!useNative) return;

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
          onClick: () => void;
        };
        const id = `item-${n++}`;
        items.push({
          type: "item",
          id,
          label: extractLabel(props.children) || "…",
          danger: props.danger,
          disabled: props.disabled,
        });
        handlers.set(id, props.onClick);
      }
    });

    let cancelled = false;
    void bridge!.showContextMenu!(items, x, y)
      .then((id) => {
        if (cancelled) return;
        if (id && handlers.has(id)) handlers.get(id)!();
        onClose();
      })
      .catch(() => {
        if (!cancelled) onClose();
      });
    return () => {
      cancelled = true;
    };
  }, [x, y, children, onClose]);

  const bridge = (window as BridgeWindow).resostageElectron;
  const useNative =
    (IS_ELECTRON || IS_EMBEDDED) &&
    typeof bridge?.showContextMenu === "function";

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
  onClick,
}: {
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center px-3 py-1.5 text-left transition-colors disabled:opacity-30 disabled:cursor-default ${
        danger
          ? "text-danger hover:bg-danger/10"
          : "text-foreground/80 hover:bg-default/20"
      }`}
    >
      {children}
    </button>
  );
}
ContextMenuItem.displayName = "ContextMenuItem";

export function ContextMenuDivider() {
  return <div className="my-1 h-px bg-default/20" />;
}
ContextMenuDivider.displayName = "ContextMenuDivider";
