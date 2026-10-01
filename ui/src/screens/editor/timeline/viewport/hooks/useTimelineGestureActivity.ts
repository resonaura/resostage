// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useRef, useState } from "react";

/**
 * Tracks active timeline gestures for rendering/follow coordination. The refs
 * are read synchronously by the animation loop; React state is only the
 * coarse-render signal for timeline lanes.
 */
export function useTimelineGestureActivity(
  setZoomActive: (active: boolean) => void,
) {
  // Progressive rendering: track gesture activity for coarse→fine rendering.
  const [gestureActive, setGestureActive] = useState(false);
  const gestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Plain ref, set SYNCHRONOUSLY in the same tick as the wheel/pinch handler
  // -- the smooth-follow rAF loop reads THIS, not a ref mirroring the
  // `gestureActive` React state below. That mirror only updates on the NEXT
  // render, and requestAnimationFrame callbacks are scheduled independently
  // of React's render/commit timing: if the loop's tick() ran in the single
  // frame between the wheel event firing and React's batched update
  // flushing, it would still see stale (false) and write scrollLeft for the
  // OLD playhead-anchor target at the exact moment applyZoomAt's own
  // zoom-focus effect was ALSO writing scrollLeft for the NEW zoom target --
  // a one-frame tug-of-war between the two, which is what made the playhead
  // visibly jump during a zoom gesture while autofollowing.
  const gestureActiveNowRef = useRef(false);
  // Mirror of the REACT flag, so the setters below can be skipped when the
  // value would not change. This is not micro-optimisation: markGestureActive
  // fires on every `scroll` event, and calling a useState setter with the
  // value it already holds still re-runs this component -- React only bails
  // out of re-rendering the CHILDREN. Timeline is a large tree, so that was
  // one full element-creation pass per scrolled frame for a boolean that had
  // been true since the gesture started. Same reasoning for zoomActive.
  const gestureActiveStateRef = useRef(false);
  const setGestureActiveDeduped = (value: boolean) => {
    if (gestureActiveStateRef.current === value) return;
    gestureActiveStateRef.current = value;
    setGestureActive(value);
  };
  const zoomActiveStateRef = useRef(false);
  const setZoomActiveDeduped = (value: boolean) => {
    if (zoomActiveStateRef.current === value) return;
    zoomActiveStateRef.current = value;
    setZoomActive(value);
  };
  const markGestureActiveRef = useRef(() => {
    gestureActiveNowRef.current = true;
    setGestureActiveDeduped(true);
    // The timer is always refreshed -- that is what keeps the gesture alive
    // -- but refreshing a timeout costs nothing next to a React render.
    if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
    gestureTimerRef.current = setTimeout(() => {
      gestureActiveNowRef.current = false;
      setGestureActiveDeduped(false);
    }, 700);
  });

  // ZOOM-only flag feeding the playhead clock FREEZE: while the user is
  // zooming, the transport keeps playing but the timeline's clock must stand
  // still so the playhead marker doesn't creep left-right against the
  // zoom-focus anchor ("the playhead must stay in place while zooming").
  // Deliberately NOT set by manual horizontal scrolling -- looking around must
  // never pause time, only a zoom gesture should.
  //
  // Each of the two flags gets its OWN timer: they fire together during a
  // pinch, and if they shared a single timer, markZoomActive's write would
  // overwrite (clear) the timer that resets gestureActiveNowRef, so a pinch
  // whose gestureend was lost would leave gestureActiveNowRef stuck true --
  // which permanently disabled auto-scroll in EVERY follow mode
  // ("auto-scroll is completely broken now").
  /**
   * A follow scroll owed to the playhead once the zoom finishes.
   *
   * During the gesture the zoom owns scrollLeft outright (see the zoom-focus
   * commit) -- a follow write landing in the middle of that fights it and
   * wobbles the whole timeline. So the needle keeps running, the view stays
   * where the pinch put it, and catching up happens once, at the end.
   */
  const pendingFollowAfterZoomRef = useRef(false);

  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markZoomActiveRef = useRef(() => {
    setZoomActiveDeduped(true);
    // Whatever the follow mode would have done during the gesture is owed
    // until after it.
    pendingFollowAfterZoomRef.current = true;
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = setTimeout(() => {
      setZoomActiveDeduped(false);
    }, 700);
  });

  // Explicit end-of-gesture clear. The settle timer above is a fallback for
  // when a gesturechange burst stalls (a slow pinch can emit events more
  // sparsely than the timer window), but the browser ALSO fires gestureend /
  // touchend when the fingers lift -- clearing here makes the end exact
  // instead of waiting out the timer, and guarantees the zoom flag can't
  // outlive the fingers ("pinch keeps getting interrupted" was the timer
  // firing mid-gesture, flipping zoomActive off and unfreezing the clock
  // while fingers were still down).
  const endGestureRef = useRef(() => {
    gestureActiveNowRef.current = false;
    setGestureActiveDeduped(false);
    setZoomActiveDeduped(false);
    if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
    gestureTimerRef.current = null;
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = null;
  });

  return {
    gestureActive,
    gestureActiveNowRef,
    pendingFollowAfterZoomRef,
    markGestureActiveRef,
    markZoomActiveRef,
    endGestureRef,
  };
}
