import type { ReactNode } from "react";

/**
 * Something that appears and disappears inside a row without shoving the row
 * around.
 *
 * Mounting and unmounting is the obvious way to do this and the wrong one:
 * everything beside it jumps sideways the instant it appears, which is
 * exactly the movement the eye catches while trying to read something else.
 *
 * Two details are what make the collapse smooth, and both are easy to miss:
 *
 *  - the width comes from a `0fr -> 1fr` grid column, the one way to animate
 *    to and from intrinsic width without measuring the content first;
 *  - `gapPx` cancels the parent flex gap on the way out. Animating the width
 *    alone leaves the gap behind, so the row still jumps at the very end --
 *    which reads as a bug rather than as a short animation.
 *
 * Children stay mounted while collapsed, so whatever they were showing does
 * not blank out halfway through its own exit.
 */
export function CollapsibleInline({
  open,
  gapPx = 8,
  durationMs = 300,
  className = "",
  children,
}: {
  open: boolean;
  /** The parent's flex/grid gap, cancelled while closed. */
  gapPx?: number;
  durationMs?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden={!open}
      className={`grid overflow-hidden transition-[grid-template-columns,opacity,margin-inline-start] ease-out motion-reduce:transition-none ${className}`}
      style={{
        gridTemplateColumns: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
        marginInlineStart: open ? 0 : `-${gapPx}px`,
        transitionDuration: `${durationMs}ms`,
      }}
    >
      <span className="min-w-0 overflow-hidden whitespace-nowrap">
        {children}
      </span>
    </span>
  );
}
