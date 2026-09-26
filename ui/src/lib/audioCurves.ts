/**
 * Audio console fader law and logarithmic parameter scaling matching ResoStage Core MidiTransform.h
 * and standard DAW unity positioning (0 dB at 0.80).
 */

export const FADER_UNITY_POSITION = 0.80;
export const FADER_MIN_DB = -80.0;
export const FADER_MAX_DB = 12.0;

export const FREQ_MIN_HZ = 20.0;
export const FREQ_MAX_HZ = 20000.0;

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export const FaderLaw = {
  unityPosition: FADER_UNITY_POSITION,
  minDb: FADER_MIN_DB,
  maxDb: FADER_MAX_DB,

  /**
   * Normalized controller position [0.0, 1.0] -> Decibels [-inf, +12dB]
   */
  positionToDb(x: number): number {
    if (x <= 0.0001) return -Infinity;
    if (x <= FADER_UNITY_POSITION) {
      const norm = x / FADER_UNITY_POSITION;
      const amp = norm * norm * norm; // cubic taper
      if (amp <= 0.0001) return FADER_MIN_DB;
      const db = 20.0 * Math.log10(amp);
      return Math.max(FADER_MIN_DB, db);
    }
    const t = (x - FADER_UNITY_POSITION) / (1.0 - FADER_UNITY_POSITION);
    return t * FADER_MAX_DB;
  },

  /**
   * Normalized controller position [0.0, 1.0] -> Linear Gain [0.0, ~3.98]
   */
  positionToGain(x: number): number {
    if (x <= 0.0001) return 0.0;
    const db = FaderLaw.positionToDb(x);
    if (db <= -79.9) return 0.0;
    return Math.pow(10.0, db / 20.0);
  },

  /**
   * Decibels [-inf, +12dB] -> Normalized controller position [0.0, 1.0]
   */
  dbToPosition(db: number): number {
    if (!Number.isFinite(db) || db <= FADER_MIN_DB) return 0.0;
    if (db <= 0.0) {
      // db = 20 * log10((x / 0.8)^3) = 60 * log10(x / 0.8) => x / 0.8 = 10^(db / 60)
      const norm = Math.pow(10.0, db / 60.0);
      return clamp(norm * FADER_UNITY_POSITION, 0.0, FADER_UNITY_POSITION);
    }
    const t = clamp(db / FADER_MAX_DB, 0.0, 1.0);
    return FADER_UNITY_POSITION + t * (1.0 - FADER_UNITY_POSITION);
  },
};

export const FrequencyScale = {
  minHz: FREQ_MIN_HZ,
  maxHz: FREQ_MAX_HZ,

  /**
   * Normalized [0.0, 1.0] -> Frequency in Hz (20Hz to 20kHz logarithmic)
   */
  positionToHz(x: number): number {
    const clamped = clamp(x, 0.0, 1.0);
    return FREQ_MIN_HZ * Math.pow(FREQ_MAX_HZ / FREQ_MIN_HZ, clamped);
  },

  /**
   * Frequency in Hz -> Normalized [0.0, 1.0]
   */
  hzToPosition(hz: number): number {
    if (hz <= FREQ_MIN_HZ) return 0.0;
    if (hz >= FREQ_MAX_HZ) return 1.0;
    return Math.log(hz / FREQ_MIN_HZ) / Math.log(FREQ_MAX_HZ / FREQ_MIN_HZ);
  },
};

export function formatDb(db: number, decimals = 1): string {
  if (!Number.isFinite(db) || db <= -79.5) return "-inf dB";
  const sign = db > 0.04 ? "+" : "";
  return `${sign}${db.toFixed(decimals)} dB`;
}

export function formatFrequency(hz: number): string {
  if (hz < 1000) {
    return `${Math.round(hz)} Hz`;
  }
  return `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz`;
}

export type TakeoverMode = "jump" | "pickup" | "value_scaling";

export class ControllerTakeover {
  mode: TakeoverMode;
  latched = false;
  previousHardware = 0.0;
  hasPrevious = false;

  constructor(mode: TakeoverMode = "jump") {
    this.mode = mode;
  }

  reset() {
    this.latched = false;
    this.hasPrevious = false;
  }

  process(incomingHardware: number, currentTarget: number, tolerance = 0.03): number {
    const hw = clamp(incomingHardware, 0.0, 1.0);
    const target = clamp(currentTarget, 0.0, 1.0);

    if (this.mode === "jump") {
      this.latched = true;
      this.previousHardware = hw;
      this.hasPrevious = true;
      return hw;
    }

    if (this.mode === "pickup") {
      if (!this.latched) {
        if (!this.hasPrevious) {
          this.previousHardware = hw;
          this.hasPrevious = true;
          if (Math.abs(hw - target) <= tolerance) {
            this.latched = true;
            return hw;
          }
          return target;
        }

        const prev = this.previousHardware;
        const crossed = (prev <= target && hw >= target) || (prev >= target && hw <= target);
        this.previousHardware = hw;

        if (crossed || Math.abs(hw - target) <= tolerance) {
          this.latched = true;
          return hw;
        }
        return target;
      }

      this.previousHardware = hw;
      return hw;
    }

    // Value scaling
    if (!this.hasPrevious) {
      this.previousHardware = hw;
      this.hasPrevious = true;
      if (Math.abs(hw - target) <= tolerance) {
        this.latched = true;
        return hw;
      }
      return target;
    }

    const delta = hw - this.previousHardware;
    this.previousHardware = hw;

    if (this.latched || Math.abs(delta) < 0.0001) {
      if (this.latched) return hw;
      return target;
    }

    let newValue = target;
    if (delta > 0.0) {
      const remainingTarget = 1.0 - target;
      const remainingHw = Math.max(0.0001, 1.0 - (hw - delta));
      const scale = remainingTarget / remainingHw;
      newValue = target + delta * scale;
    } else {
      const remainingTarget = target;
      const remainingHw = Math.max(0.0001, hw - delta);
      const scale = remainingTarget / remainingHw;
      newValue = target + delta * scale;
    }

    newValue = clamp(newValue, 0.0, 1.0);
    if (Math.abs(newValue - hw) <= tolerance) {
      this.latched = true;
      return hw;
    }
    return newValue;
  }
}
