/**
 * Whether the machine is asking to be left alone.
 *
 * Two independent reasons a laptop cannot sustain 60fps that nothing else in
 * the performance ladder can see:
 *
 *  - it is on battery, and macOS Low Power Mode / Windows battery saver has
 *    already capped the CPU and GPU clocks. Frame times get worse, but so does
 *    everything else, and burning the remaining charge on a preview nobody is
 *    reading is the wrong trade on a stage.
 *  - the SoC is thermally throttled. Same clocks, same outcome, no battery
 *    involved -- a rack Mac mini under a hot lighting truss hits this while
 *    plugged in.
 *
 * The reliable source is Electron's powerMonitor in the main process, relayed
 * as `resoshell-power`. The browser fallback (navigator.getBattery) is only
 * there so the Vite dev server behaves the same as the shell; it cannot see
 * Low Power Mode at all, so it settles for "discharging and nearly flat".
 */

export interface PowerState {
  /** Running from the battery rather than the wall. */
  onBattery: boolean;
  /** The OS has told us it is saving power (Low Power Mode, battery saver). */
  powerSaver: boolean;
  /** macOS thermal pressure, when the shell reports it. */
  thermal: "nominal" | "fair" | "serious" | "critical";
}

export const DEFAULT_POWER_STATE: PowerState = {
  onBattery: false,
  powerSaver: false,
  thermal: "nominal",
};

/** Battery percentage under which the browser fallback calls it power saving. */
const LOW_BATTERY_FRACTION = 0.25;

let current: PowerState = DEFAULT_POWER_STATE;
const listeners = new Set<(s: PowerState) => void>();

function publish(next: PowerState): void {
  if (
    next.onBattery === current.onBattery &&
    next.powerSaver === current.powerSaver &&
    next.thermal === current.thermal
  ) {
    return; // the shell re-sends on every wake; only real changes are news
  }
  current = next;
  for (const fn of listeners) fn(next);
}

export function getPowerState(): PowerState {
  return current;
}

export function onPowerStateChanged(fn: (s: PowerState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * True when the machine is in a state where holding full frame rate costs more
 * than it is worth. Folded into the performance ladder exactly like CPU, disk
 * and audio-underrun pressure -- see lib/performance's `stepAuto`.
 */
export function powerPressure(s: PowerState = current): boolean {
  if (s.thermal === "serious" || s.thermal === "critical") return true;
  return s.onBattery && s.powerSaver;
}

interface BatteryLike extends EventTarget {
  charging: boolean;
  level: number;
}

/**
 * Start listening. Idempotent, and safe to call before the shell exists --
 * both sources simply report when they have something to say.
 */
export function startPowerWatch(): () => void {
  if (typeof window === "undefined") return () => {};

  const onShellPower = (e: Event) => {
    const detail = (e as CustomEvent).detail as Partial<PowerState> | undefined;
    if (!detail) return;
    publish({
      onBattery: detail.onBattery ?? current.onBattery,
      powerSaver: detail.powerSaver ?? current.powerSaver,
      thermal: detail.thermal ?? current.thermal,
    });
  };
  window.addEventListener("resoshell-power", onShellPower);

  // Browser fallback. Skipped entirely under the shell, whose report is both
  // richer and authoritative -- two sources writing the same fields would let
  // the poorer one overwrite Low Power Mode with "charging, so we're fine".
  let detachBattery = () => {};
  const nav = navigator as Navigator & {
    getBattery?: () => Promise<BatteryLike>;
  };
  const underShell = "resostageElectron" in window;
  if (!underShell && typeof nav.getBattery === "function") {
    let cancelled = false;
    void nav
      .getBattery()
      .then((battery) => {
        if (cancelled) return;
        const read = () =>
          publish({
            onBattery: !battery.charging,
            powerSaver: !battery.charging && battery.level <= LOW_BATTERY_FRACTION,
            thermal: current.thermal,
          });
        read();
        battery.addEventListener("chargingchange", read);
        battery.addEventListener("levelchange", read);
        detachBattery = () => {
          battery.removeEventListener("chargingchange", read);
          battery.removeEventListener("levelchange", read);
        };
      })
      .catch(() => {
        /* no battery API (desktop Linux, locked-down browser) */
      });
    detachBattery = () => {
      cancelled = true;
    };
  }

  return () => {
    window.removeEventListener("resoshell-power", onShellPower);
    detachBattery();
  };
}
