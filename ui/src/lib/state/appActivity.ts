/**
 * "Is this page actually on screen, and does anything need to move?"
 *
 * Every live widget in this app (VU needles, meter ballistics, the light
 * preview, the timeline playhead) is driven by an animation frame. On a stage
 * machine that is exactly right while the window is up. It is pure waste when
 * the window is hidden behind the DAW, minimized to the Dock, or sitting in a
 * background browser tab with the transport stopped -- and that waste is what
 * makes the fans spin on a laptop that is doing nothing.
 *
 * This module is the single place that answers the question, so no widget has
 * to grow its own visibility heuristic:
 *
 *   render = visible || playing
 *
 * `visible` is deliberately conservative. A window that is merely UNFOCUSED
 * (another app on top, the user reading a chart on the second monitor) still
 * counts as visible -- ResoStage is a live tool and a meter the operator can
 * see must never freeze. Only a window the compositor is genuinely not showing
 * (hidden / minimized / background tab) suspends animation, and it comes back
 * on the very next frame after `shell-active` / `visibilitychange`.
 *
 * `playing` is an override, not a condition: with the transport running the UI
 * stays fully live even while hidden, because the operator can bring it
 * forward mid-song and it must already be correct, not catching up.
 *
 * Nothing here touches the data path. Telemetry keeps arriving and keeps
 * updating liveLevels while suspended; only *painting* stops. That is what
 * makes waking up instant rather than a reconnect.
 */

import { useEffect, useState } from "react";

type Listener = (active: boolean) => void;

const listeners = new Set<Listener>();

let documentVisible = true;
/**
 * The Electron shell's verdict, or null when there is no shell (plain browser
 * tab, JUCE webview). When present it WINS over `document.visibilityState`.
 *
 * That precedence is the whole reason this field exists. The shell launches
 * Chromium with renderer backgrounding and occlusion detection disabled --
 * that is what keeps meters alive behind another window -- and a side effect
 * is that the page's own `visibilityState` can keep reporting "visible" for a
 * window that has been hidden or minimized for minutes. Treating the two
 * signals as equally trustworthy (either one saying "visible" wins) meant the
 * shell could never actually put the page to sleep. The main process is the
 * only party that knows the truth here, so when it speaks, it decides.
 */
let shellVisible: boolean | null = null;
let transportPlaying = false;
let lastActive = true;

function computeActive(): boolean {
  const visible = shellVisible ?? documentVisible;
  return visible || transportPlaying;
}

function publish(): void {
  const next = computeActive();
  if (next === lastActive) return;
  lastActive = next;
  for (const l of listeners) l(next);
}

/**
 * True while animation loops should run. Read it live -- it flips from event
 * handlers, never on a React commit.
 */
export function isRenderActive(): boolean {
  return lastActive;
}

export function subscribeRenderActive(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React binding for the same signal. Only for the handful of places that need
 * it as a prop (the WebGL stage's frameloop); anything animating imperatively
 * should go through rafLoop instead of re-rendering on this.
 */
export function useRenderActive(): boolean {
  const [active, setActive] = useState(isRenderActive);
  useEffect(() => {
    setActive(isRenderActive());
    return subscribeRenderActive(setActive);
  }, []);
  return active;
}

/**
 * Transport state, mirrored here from the live WS feed. Keeps a hidden window
 * fully live for the whole song -- see the module comment.
 */
export function setTransportPlaying(playing: boolean): void {
  if (transportPlaying === playing) return;
  transportPlaying = playing;
  publish();
}

if (typeof document !== "undefined") {
  documentVisible = document.visibilityState !== "hidden";
  lastActive = computeActive();

  document.addEventListener("visibilitychange", () => {
    documentVisible = document.visibilityState !== "hidden";
    // Becoming visible is unambiguous in either direction: no shell hides a
    // window and then lets the compositor show the page. Clear the latch so a
    // missed `shell-active` can never strand the UI asleep.
    if (documentVisible) shellVisible = true;
    publish();
  });

  // Electron shell idle policy. `shell-idle` fires only when the window is
  // genuinely not on screen AND the transport is stopped; `shell-active` is
  // sent the instant either of those stops being true.
  window.addEventListener("resoshell-idle", () => {
    shellVisible = false;
    publish();
  });
  const shellWake = () => {
    shellVisible = true;
    publish();
  };
  window.addEventListener("resoshell-active", shellWake);
  window.addEventListener("resoshell-resume", shellWake);

  // Focus / bfcache restore. These say something about the PAGE, not about the
  // shell's policy, so they must not set the shell latch in a plain browser
  // tab -- doing so would pin `shellVisible` true and permanently override the
  // visibilitychange signal that is the only thing a browser tab has.
  const pageWake = () => {
    documentVisible = true;
    if (shellVisible !== null) shellVisible = true;
    publish();
  };
  window.addEventListener("focus", pageWake);
  window.addEventListener("pageshow", pageWake);

  // Last-resort wake. Every path above is event-driven, and a live-performance
  // tool must not have a state it can get stuck asleep in: if something is
  // touching this page, it is on screen, whatever any other signal claims.
  const onInput = () => {
    if (lastActive) return;
    pageWake();
  };
  window.addEventListener("pointerdown", onInput, { capture: true });
  window.addEventListener("keydown", onInput, { capture: true });
  window.addEventListener("wheel", onInput, { capture: true, passive: true });
}
