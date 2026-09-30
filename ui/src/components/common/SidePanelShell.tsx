import { ChevronRight, PanelRightOpen } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui";

/**
 * The collapsible right-hand inspector shell, shared by the light and audio
 * side panels.
 *
 * Collapsing matters more here than it looks: the panel is 288px of a
 * timeline that is never wide enough, and on a laptop that is most of a bar
 * at a useful zoom. So it collapses to a rail -- and the rail still says what
 * is selected, because a panel you cannot see is only acceptable if you can
 * tell at a glance whether it has anything in it.
 *
 * ## Why the auto-open is written the way it is
 *
 * "Open when a region is selected" is right the first time and irritating the
 * tenth: the user closes the panel, clicks the next region to hear it, and
 * the panel is back. So a manual collapse WINS. Once you have closed it by
 * hand, selecting things stops opening it, for the rest of the session; the
 * rail's dot is how it tells you there is something to look at instead. The
 * next deliberate open resets that, because opening it by hand is a statement
 * that you want it again.
 */
export function SidePanelShell({
  title,
  icon,
  storageKey,
  hasSelection,
  selectionLabel,
  width = 288,
  header,
  children,
}: {
  title: string;
  icon: ReactNode;
  /** localStorage key for the open/closed preference. */
  storageKey: string;
  /** Whether there is anything to inspect right now. Drives the auto-open. */
  hasSelection: boolean;
  /** Shown on the collapsed rail so it is legible without expanding. */
  selectionLabel?: string;
  width?: number;
  /** Rendered above the scroll area, inside the expanded panel. */
  header?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readOpen(storageKey));
  // Set the moment the user collapses it by hand. Suppresses auto-open until
  // they open it again -- see the note above.
  const suppressAutoRef = useRef(false);
  const hadSelectionRef = useRef(hasSelection);

  useEffect(() => {
    const had = hadSelectionRef.current;
    hadSelectionRef.current = hasSelection;
    // Only the transition into "something is selected" opens it. Staying
    // selected while React re-renders for unrelated reasons must not.
    if (!had && hasSelection && !suppressAutoRef.current) setOpen(true);
  }, [hasSelection]);

  const setOpenByUser = (next: boolean) => {
    suppressAutoRef.current = !next;
    setOpen(next);
    writeOpen(storageKey, next);
  };

  if (!open) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center gap-2 border-l border-default bg-background-secondary py-2">
        <Button
          size="sm"
          isIconOnly
          variant="default-soft"
          aria-label={`Show ${title}`}
          onPress={() => setOpenByUser(true)}
        >
          <PanelRightOpen size={13} />
        </Button>
        {/* Vertical label + a dot when there is a selection waiting. The dot
            is the whole reason the rail is not just a button: it is what
            makes closing the panel safe rather than blind. */}
        <span
          className="mt-1 select-none text-[10px] font-semibold tracking-wide text-muted"
          style={{ writingMode: "vertical-rl" }}
        >
          {hasSelection && selectionLabel ? selectionLabel : title}
        </span>
        {hasSelection && (
          <span
            aria-hidden
            className="mt-auto mb-1 size-1.5 shrink-0 rounded-full bg-accent"
          />
        )}
      </div>
    );
  }

  return (
    <div
      className="flex shrink-0 flex-col overflow-hidden border-l border-default bg-background-secondary"
      style={{ width }}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-default px-2 py-1.5">
        <span className="shrink-0 text-muted">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide uppercase">
          {title}
        </span>
        <Button
          size="sm"
          isIconOnly
          variant="default-soft"
          aria-label={`Hide ${title}`}
          onPress={() => setOpenByUser(false)}
        >
          <ChevronRight size={13} />
        </Button>
      </div>
      {header}
      {children}
    </div>
  );
}

function readOpen(key: string): boolean {
  try {
    const raw = localStorage.getItem(key);
    // Default open: a first-time user has to see the panel exist before
    // hiding it is a choice rather than a mystery.
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function writeOpen(key: string, open: boolean): void {
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    /* best-effort */
  }
}
