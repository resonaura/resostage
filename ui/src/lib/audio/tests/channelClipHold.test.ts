// @vitest-environment jsdom
/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  channelClipHoldKey,
  clearChannelClipHold,
  getChannelClipHoldSnapshot,
  getChannelPeakHold,
  publishChannelPeak,
  resetChannelClipHolds,
  subscribeChannelClipHold,
} from "@/lib/audio/channelClipHold";
import {
  getLiveLevels,
  getTrackLiveLevel,
  resetLiveLevels,
  pushLiveLevels,
} from "@/lib/audio/liveLevels";
import {
  currentProjectCommandIdentity,
  observeProjectCommandIdentity,
} from "@/lib/state/api";

const projectA = {
  origin: "http://127.0.0.1:2899",
  stateSessionId: "core-a",
  projectEpoch: 7,
};

afterEach(() => {
  resetChannelClipHolds();
  resetLiveLevels();
  observeProjectCommandIdentity({ stateSessionId: "", projectEpoch: -1 });
});

describe("shared channel clip holds", () => {
  it("retains stereo peak maxima without rerendering React subscribers per sample", () => {
    const key = channelClipHoldKey("track-peaks", projectA);
    const listener = vi.fn();
    const unsubscribe = subscribeChannelClipHold(key, listener);

    publishChannelPeak(key, -12, -9);
    publishChannelPeak(key, -7, -10);
    publishChannelPeak(key, -8, -5);

    expect(getChannelPeakHold(key)).toEqual({ leftDb: -7, rightDb: -5 });
    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: false });
    expect(listener).not.toHaveBeenCalled();

    clearChannelClipHold(key);
    expect(getChannelPeakHold(key)).toEqual({ leftDb: -100, rightDb: -100 });
    unsubscribe();
  });

  it("publishes one peak latch to every view subscribed to a strip", () => {
    const key = channelClipHoldKey("track-1", projectA);
    const timeline = vi.fn();
    const mixer = vi.fn();
    const unsubscribeTimeline = subscribeChannelClipHold(key, timeline);
    const unsubscribeMixer = subscribeChannelClipHold(key, mixer);

    publishChannelPeak(key, 1.2, -3);

    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: true });
    expect(getChannelPeakHold(key)).toEqual({ leftDb: 1.2, rightDb: -3 });
    expect(timeline).toHaveBeenCalledTimes(1);
    expect(mixer).toHaveBeenCalledTimes(1);

    unsubscribeTimeline();
    unsubscribeMixer();
  });

  it("shares reset and accepts a later higher peak without changing another project", () => {
    const key = channelClipHoldKey("track-1", projectA);
    const otherProject = channelClipHoldKey("track-1", { ...projectA, projectEpoch: 8 });
    const listener = vi.fn();
    const unsubscribe = subscribeChannelClipHold(key, listener);

    publishChannelPeak(key, 2, -4);
    publishChannelPeak(key, 2.05, -3.8);
    expect(listener).toHaveBeenCalledTimes(1);

    clearChannelClipHold(key);
    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: false });
    expect(getChannelPeakHold(key)).toEqual({ leftDb: -100, rightDb: -100 });
    expect(getChannelClipHoldSnapshot(otherProject)).toEqual({ clipped: false });
    expect(getChannelPeakHold(otherProject)).toEqual({ leftDb: -100, rightDb: -100 });

    publishChannelPeak(key, 1.5, -2);
    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: true });
    expect(getChannelPeakHold(key)).toEqual({ leftDb: 1.5, rightDb: -2 });
    unsubscribe();
  });

  it("retains the latch when a view unmounts so another view can read it", () => {
    const key = channelClipHoldKey("track-3", projectA);
    const unsubscribe = subscribeChannelClipHold(key, vi.fn());
    publishChannelPeak(key, 3.4, 2.7);
    unsubscribe();

    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: true });
    expect(getChannelPeakHold(key)).toEqual({ leftDb: 3.4, rightDb: 2.7 });

    const nextView = vi.fn();
    const unsubscribeNextView = subscribeChannelClipHold(key, nextView);
    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: true });
    publishChannelPeak(key, 3.8, 2.9);
    expect(nextView).not.toHaveBeenCalled();
    expect(getChannelPeakHold(key)).toEqual({ leftDb: 3.8, rightDb: 2.9 });
    unsubscribeNextView();
  });

  it("ignores silence, non-finite samples, and impossible telemetry", () => {
    const key = channelClipHoldKey("bus-1", projectA);
    const listener = vi.fn();
    const unsubscribe = subscribeChannelClipHold(key, listener);

    publishChannelPeak(key, -100, -100);
    publishChannelPeak(key, Number.NaN, -2);
    publishChannelPeak(key, -2, 300);

    expect(listener).not.toHaveBeenCalled();
    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: false });
    expect(getChannelPeakHold(key)).toEqual({ leftDb: -100, rightDb: -100 });
    unsubscribe();
  });

  it("clears mounted holds when the live telemetry source resets", () => {
    const key = channelClipHoldKey("track-2", projectA);
    const listener = vi.fn();
    const unsubscribe = subscribeChannelClipHold(key, listener);
    publishChannelPeak(key, 1, -3);

    resetChannelClipHolds();

    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: false });
    expect(getChannelPeakHold(key)).toEqual({ leftDb: -100, rightDb: -100 });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("feeds shared track and bus holds from the same live telemetry frame", () => {
    observeProjectCommandIdentity({
      stateSessionId: projectA.stateSessionId,
      projectEpoch: projectA.projectEpoch,
    });
    const identity = currentProjectCommandIdentity();
    const trackKey = channelClipHoldKey("track-1", identity);
    const busKey = channelClipHoldKey("bus-1", identity);
    const trackListener = vi.fn();
    const busListener = vi.fn();
    const unsubscribeTrack = subscribeChannelClipHold(trackKey, trackListener);
    const unsubscribeBus = subscribeChannelClipHold(busKey, busListener);

    pushLiveLevels({
      tracks: [{ id: "track-1", peakDbL: 1.7, peakDbR: -3 }],
      meters: [{ id: "bus-1", peakDbL: -4, peakDbR: 2.1 }],
    });

    expect(getChannelClipHoldSnapshot(trackKey)).toEqual({ clipped: true });
    expect(getChannelClipHoldSnapshot(busKey)).toEqual({ clipped: true });
    expect(getChannelPeakHold(trackKey)).toEqual({ leftDb: 1.7, rightDb: -3 });
    expect(getChannelPeakHold(busKey)).toEqual({ leftDb: -4, rightDb: 2.1 });
    expect(trackListener).toHaveBeenCalledTimes(1);
    expect(busListener).toHaveBeenCalledTimes(1);
    unsubscribeTrack();
    unsubscribeBus();
  });

  it("clears raw live readings when a new project reuses the same strip IDs", () => {
    observeProjectCommandIdentity({
      stateSessionId: projectA.stateSessionId,
      projectEpoch: projectA.projectEpoch,
    });
    const trackKey = channelClipHoldKey("track-1", currentProjectCommandIdentity());
    pushLiveLevels({
      tracks: [{ id: "track-1", peakDbL: 2.5, peakDbR: -4 }],
      meters: [{ id: "bus-1", peakDbL: -5, peakDbR: 1.5 }],
    });
    expect(getTrackLiveLevel("track-1")?.peakDbL).toBe(2.5);
    expect(getChannelPeakHold(trackKey)).toEqual({ leftDb: 2.5, rightDb: -4 });

    observeProjectCommandIdentity({
      stateSessionId: projectA.stateSessionId,
      projectEpoch: projectA.projectEpoch + 1,
    });

    expect(getTrackLiveLevel("track-1")).toBeUndefined();
    expect(getLiveLevels().tracks).toEqual([]);
    expect(getLiveLevels().meters).toEqual([]);
    const nextProjectKey = channelClipHoldKey(
      "track-1",
      currentProjectCommandIdentity(),
    );
    expect(getChannelPeakHold(nextProjectKey)).toEqual({
      leftDb: -100,
      rightDb: -100,
    });

    pushLiveLevels({ tracks: [{ id: "track-1", peakDbL: -3, peakDbR: -8 }] });
    expect(getTrackLiveLevel("track-1")?.peakDbL).toBe(-3);
    expect(getChannelPeakHold(nextProjectKey)).toEqual({ leftDb: -3, rightDb: -8 });
  });
});
