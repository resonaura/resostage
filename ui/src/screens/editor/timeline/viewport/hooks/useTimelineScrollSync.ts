// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useCallback } from "react";
import type { MutableRefObject, RefObject, UIEvent } from "react";

interface UseTimelineScrollSyncOptions {
  sidebarContentRef: RefObject<HTMLDivElement | null>;
  programmaticScrollLeftRef: MutableRefObject<number | null>;
  lastProgrammaticWriteAtRef: MutableRefObject<number>;
  followEngineScrollRef: MutableRefObject<number | null>;
  lastScrollLeftRef: MutableRefObject<number | null>;
  lastCommittedScrollLeftRef: MutableRefObject<number | null>;
  lastScrollStateCommitAtRef: MutableRefObject<number>;
  commitScrollStateRef: MutableRefObject<(left: number, width: number) => void>;
  playingRef: MutableRefObject<boolean>;
  markGestureActiveRef: MutableRefObject<() => void>;
  suspendFollowFromUserScroll: () => void;
}

const ECHO_GRACE_MS = 200;

/** Keeps horizontal scroll state, auto-follow echoes, and the track sidebar aligned. */
export function useTimelineScrollSync({
  sidebarContentRef,
  programmaticScrollLeftRef,
  lastProgrammaticWriteAtRef,
  followEngineScrollRef,
  lastScrollLeftRef,
  lastCommittedScrollLeftRef,
  lastScrollStateCommitAtRef,
  commitScrollStateRef,
  playingRef,
  markGestureActiveRef,
  suspendFollowFromUserScroll,
}: UseTimelineScrollSyncOptions) {
  return useCallback((event: UIEvent<HTMLDivElement>) => {
    // Vertical sidebar mirror: write HERE (scroll event is sync with the
    // browser's scroll position) so the left track list never lags a frame
    // behind the right pane. rAF only re-applies as a safety net.
    const scroller = event.currentTarget;
    if (sidebarContentRef.current)
      sidebarContentRef.current.style.transform = `translate3d(0, -${scroller.scrollTop}px, 0)`;
    // Hard-clamp past the real content end (macOS rubber-band / trackpad
    // can report scrollLeft beyond scrollWidth-clientWidth briefly).
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    if (scroller.scrollLeft < 0) scroller.scrollLeft = 0;
    else if (scroller.scrollLeft > maxLeft) scroller.scrollLeft = maxLeft;
    const left = scroller.scrollLeft;
    const programmedLeft = programmaticScrollLeftRef.current;
    const exactEcho =
      programmedLeft !== null && Math.abs(left - programmedLeft) < 0.5;
    // Coalesced echo: a programmatic write landed very recently (continuous
    // "smooth" follow writes every rAF frame, faster than the browser
    // necessarily dispatches `scroll` events for each one) -- see
    // lastProgrammaticWriteAtRef's doc comment.
    const recentEcho =
      performance.now() - lastProgrammaticWriteAtRef.current < ECHO_GRACE_MS;
    // Continuous smooth-follow owns the scroller. Any event within a few
    // pixels of the engine target is an echo of our own write (browser
    // rounding / delayed coalesced events), NOT a user fight. Only a real
    // manual drag that pulls the viewport away from the follow anchor
    // should pause autofollow -- without this, own scroll events flipped
    // gestureActive every ~150ms and the timeline stuttered in 700ms chunks.
    const followTarget = followEngineScrollRef.current;
    const followEcho =
      followTarget !== null && Math.abs(left - followTarget) < 32;
    if (exactEcho || recentEcho || followEcho) {
      // Echo of our own auto-follow/zoom-focus write. Do NOT touch
      // lastCommittedScrollLeftRef here -- the rAF loop is the sole owner of
      // React scrollState during follow. Only keep lastScrollLeftRef fresh so
      // a later real user drag is measured correctly.
      lastScrollLeftRef.current = left;
      return;
    }
    // A true user horizontal move supersedes any delayed programmatic echo.
    programmaticScrollLeftRef.current = null;
    followEngineScrollRef.current = null;
    // null means "no baseline yet" (mount / scroll-restore) -- that first
    // event never counts as a user fight.
    const movedHorizontally =
      lastScrollLeftRef.current !== null && left !== lastScrollLeftRef.current;
    lastScrollLeftRef.current = left;
    lastCommittedScrollLeftRef.current = left;
    lastScrollStateCommitAtRef.current = performance.now();
    // Vertical-only scroll (scrollTop changed, scrollLeft didn't) is not a
    // user fight for the horizontal timeline -- don't pause auto-follow for
    // it ("vertical scroll stops the auto-scroll").
    if (movedHorizontally) {
      markGestureActiveRef.current();
      // Manual pan while playing suspends follow; catch flags re-enable later.
      if (playingRef.current) suspendFollowFromUserScroll();
    }
    commitScrollStateRef.current(left, scroller.clientWidth);
  }, [
    sidebarContentRef,
    programmaticScrollLeftRef,
    lastProgrammaticWriteAtRef,
    followEngineScrollRef,
    lastScrollLeftRef,
    lastCommittedScrollLeftRef,
    lastScrollStateCommitAtRef,
    commitScrollStateRef,
    playingRef,
    markGestureActiveRef,
    suspendFollowFromUserScroll,
  ]);
}
