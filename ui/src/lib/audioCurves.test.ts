import { describe, it, expect } from "vitest";
import {
  FaderLaw,
  FrequencyScale,
  formatDb,
  formatFrequency,
  ControllerTakeover,
  FADER_UNITY_POSITION,
} from "./audioCurves";

describe("audioCurves", () => {
  describe("FaderLaw", () => {
    it("maps 0.80 normalized position to exactly 0 dB unity gain", () => {
      const db = FaderLaw.positionToDb(FADER_UNITY_POSITION);
      expect(db).toBeCloseTo(0.0, 3);
      const gain = FaderLaw.positionToGain(FADER_UNITY_POSITION);
      expect(gain).toBeCloseTo(1.0, 3);
      const pos = FaderLaw.dbToPosition(0.0);
      expect(pos).toBeCloseTo(FADER_UNITY_POSITION, 3);
    });

    it("maps 1.0 to +12 dB", () => {
      const db = FaderLaw.positionToDb(1.0);
      expect(db).toBeCloseTo(12.0, 2);
      const pos = FaderLaw.dbToPosition(12.0);
      expect(pos).toBeCloseTo(1.0, 2);
    });

    it("maps 0.0 to -Infinity or -80 dB", () => {
      expect(FaderLaw.positionToDb(0.0)).toBe(-Infinity);
      expect(FaderLaw.positionToGain(0.0)).toBe(0.0);
      expect(FaderLaw.dbToPosition(-100)).toBe(0.0);
    });

    it("round-trips decibels accurately between -60 dB and +12 dB", () => {
      const testDbs = [-60, -40, -20, -10, -6, 0, 3, 6, 12];
      for (const targetDb of testDbs) {
        const pos = FaderLaw.dbToPosition(targetDb);
        const roundTripDb = FaderLaw.positionToDb(pos);
        expect(roundTripDb).toBeCloseTo(targetDb, 1);
      }
    });
  });

  describe("FrequencyScale", () => {
    it("maps 0.0 to 20 Hz and 1.0 to 20000 Hz", () => {
      expect(FrequencyScale.positionToHz(0.0)).toBeCloseTo(20.0, 1);
      expect(FrequencyScale.positionToHz(1.0)).toBeCloseTo(20000.0, 1);
      expect(FrequencyScale.hzToPosition(20.0)).toBeCloseTo(0.0, 3);
      expect(FrequencyScale.hzToPosition(20000.0)).toBeCloseTo(1.0, 3);
    });

    it("maps logarithmic midpoint (~0.5) to around 632 Hz (geometric mean)", () => {
      // sqrt(20 * 20000) = sqrt(400000) = 632.45 Hz
      const hz = FrequencyScale.positionToHz(0.5);
      expect(hz).toBeCloseTo(632.45, 0);
      expect(FrequencyScale.hzToPosition(632.45)).toBeCloseTo(0.5, 2);
    });
  });

  describe("formatting", () => {
    it("formats dB values clearly", () => {
      expect(formatDb(-Infinity)).toBe("-inf dB");
      expect(formatDb(-85)).toBe("-inf dB");
      expect(formatDb(0)).toBe("0.0 dB");
      expect(formatDb(2.5)).toBe("+2.5 dB");
      expect(formatDb(-6.2)).toBe("-6.2 dB");
    });

    it("formats frequency values with Hz and kHz", () => {
      expect(formatFrequency(80)).toBe("80 Hz");
      expect(formatFrequency(440)).toBe("440 Hz");
      expect(formatFrequency(1500)).toBe("1.50 kHz");
      expect(formatFrequency(10500)).toBe("10.5 kHz");
    });
  });

  describe("ControllerTakeover", () => {
    it("jumps immediately in Jump mode", () => {
      const takeover = new ControllerTakeover("jump");
      expect(takeover.process(0.2, 0.8)).toBe(0.2);
      expect(takeover.latched).toBe(true);
    });

    it("waits for pickup before latching in Pickup mode", () => {
      const takeover = new ControllerTakeover("pickup");
      // Target is 0.7. Incoming hw moves from 0.1 to 0.4: ignored, stays at target
      expect(takeover.process(0.1, 0.7)).toBe(0.7);
      expect(takeover.latched).toBe(false);
      expect(takeover.process(0.4, 0.7)).toBe(0.7);
      expect(takeover.latched).toBe(false);

      // Now hw crosses 0.7 (moves from 0.4 to 0.75): latched!
      const result = takeover.process(0.75, 0.7);
      expect(takeover.latched).toBe(true);
      expect(result).toBe(0.75);

      // Subsequent moves track hw directly
      expect(takeover.process(0.8, 0.7)).toBe(0.8);
    });

    it("smoothly scales values towards target in ValueScaling mode", () => {
      const takeover = new ControllerTakeover("value_scaling");
      // Target is 0.8. Initial hw arrives at 0.4.
      expect(takeover.process(0.4, 0.8)).toBe(0.8);
      expect(takeover.latched).toBe(false);

      // Move hw towards 1.0 (from 0.4 to 0.6)
      const val = takeover.process(0.6, 0.8);
      expect(val).toBeGreaterThan(0.8);
      expect(val).toBeLessThan(1.0);
    });
  });
});
