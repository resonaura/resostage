// Trackpad haptic feedback (macOS Force Touch Taptic Engine), routed through
// the Electron shell's native bridge -- see electron/native/mac/Haptics.m.
// A no-op everywhere else (plain browser tab, JUCE WKWebView, non-mac,
// non-Force-Touch hardware): there is no web API for trackpad haptics, so
// this degrades silently rather than trying to fake it with something like
// the Gamepad vibration API (wrong hardware, wrong feel).

type HapticPattern = "generic" | "alignment" | "levelChange";

type BridgeWindow = typeof window & {
  resostageElectron?: {
    hapticFeedback?: (pattern?: HapticPattern) => void;
  };
};

/**
 * Fire a single, brief trackpad haptic tick. Meant for discrete moments
 * (a drag snapped to a new grid line, a clip was picked up/dropped) --
 * never call this on every pointermove, only on state transitions, or it
 * reads as a buzz instead of a tactile detent.
 */
export function triggerHaptic(pattern: HapticPattern = "alignment"): void {
  const bridge = (window as BridgeWindow).resostageElectron;
  bridge?.hapticFeedback?.(pattern);
}
