import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Shared right-click menu shell for the whole app (mixer track/bus menus,
 * and anything else that needs one). Two things every ad-hoc context menu
 * kept getting wrong on its own:
 *
 * - Portaled to <body> so `position: fixed` is always relative to the
 *   viewport. Rendered in place, a menu inside any ancestor with a CSS
 *   `transform` (framer-motion hover/press scale, etc.) would have its
 *   `fixed` positioning silently rebased to that ancestor's box instead of
 *   the viewport -- the classic reason a context menu occasionally opens
 *   off-screen or in the wrong spot.
 * - Clamped position is computed once (useLayoutEffect, before paint) into
 *   local state and rendered from that state. Measuring into a ref callback
 *   and writing `el.style.left` directly (the previous approach) gets
 *   stomped every time the parent re-renders and re-applies its own
 *   `style={{ left, top }}` prop -- and this app's screens re-render at
 *   ~30Hz from the live WebSocket state, so that tug-of-war was constant.
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

  useLayoutEffect(() => {
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
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

export function ContextMenuDivider() {
  return <div className="my-1 h-px bg-default/20" />;
}
