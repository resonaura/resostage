import { ScrollShadow } from "@heroui/react";

/**
 * One group of strips (tracks / sends / master).
 *
 * On a desktop console each group is its own horizontal scroller so the master
 * stays pinned on the right while the track pane scrolls under it. That
 * division needs width to make sense: on a phone the master and sends alone
 * eat the entire viewport and the track pane collapses to a sliver. There, the
 * groups stop scrolling individually and the console becomes one continuous
 * strip you swipe through -- the same order, just laid end to end.
 */
export function ConsolePane({
  compact,
  className,
  children,
}: {
  compact: boolean;
  className: string;
  children: React.ReactNode;
}) {
  if (compact) return <div className={className}>{children}</div>;
  return (
    <ScrollShadow
      orientation="horizontal"
      className={`${className} overflow-y-hidden`}
    >
      {children}
    </ScrollShadow>
  );
}
