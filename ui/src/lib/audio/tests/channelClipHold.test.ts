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
  publishChannelClipPeak,
  resetChannelClipHolds,
  subscribeChannelClipHold,
} from "@/lib/audio/channelClipHold";
import { resetLiveLevels, pushLiveLevels } from "@/lib/audio/liveLevels";
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
  it("publishes one peak latch to every view subscribed to a strip", () => {
    const key = channelClipHoldKey("track-1", projectA);
    const timeline = vi.fn();
    const mixer = vi.fn();
    const unsubscribeTimeline = subscribeChannelClipHold(key, timeline);
    const unsubscribeMixer = subscribeChannelClipHold(key, mixer);

    publishChannelClipPeak(key, 1.2);

    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: true, heldPeakDb: 1.2 });
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

    publishChannelClipPeak(key, 2);
    publishChannelClipPeak(key, 2.05);
    expect(listener).toHaveBeenCalledTimes(1);

    clearChannelClipHold(key);
    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: false, heldPeakDb: -100 });
    expect(getChannelClipHoldSnapshot(otherProject)).toEqual({ clipped: false, heldPeakDb: -100 });

    publishChannelClipPeak(key, 1.5);
    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: true, heldPeakDb: 1.5 });
    unsubscribe();
  });

  it("retains the latch when a view unmounts so another view can read it", () => {
    const key = channelClipHoldKey("track-3", projectA);
    const unsubscribe = subscribeChannelClipHold(key, vi.fn());
    publishChannelClipPeak(key, 3.4);
    unsubscribe();

    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: true, heldPeakDb: 3.4 });

    const nextView = vi.fn();
    const unsubscribeNextView = subscribeChannelClipHold(key, nextView);
    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: true, heldPeakDb: 3.4 });
    publishChannelClipPeak(key, 3.8);
    expect(nextView).toHaveBeenCalledTimes(1);
    unsubscribeNextView();
  });

  it("ignores silence, non-finite samples, and impossible telemetry", () => {
    const key = channelClipHoldKey("bus-1", projectA);
    const listener = vi.fn();
    const unsubscribe = subscribeChannelClipHold(key, listener);

    publishChannelClipPeak(key, 0);
    publishChannelClipPeak(key, -0.1);
    publishChannelClipPeak(key, Number.NaN);
    publishChannelClipPeak(key, 300);

    expect(listener).not.toHaveBeenCalled();
    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: false, heldPeakDb: -100 });
    unsubscribe();
  });

  it("clears mounted holds when the live telemetry source resets", () => {
    const key = channelClipHoldKey("track-2", projectA);
    const listener = vi.fn();
    const unsubscribe = subscribeChannelClipHold(key, listener);
    publishChannelClipPeak(key, 1);

    resetChannelClipHolds();

    expect(getChannelClipHoldSnapshot(key)).toEqual({ clipped: false, heldPeakDb: -100 });
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

    expect(getChannelClipHoldSnapshot(trackKey)).toEqual({ clipped: true, heldPeakDb: 1.7 });
    expect(getChannelClipHoldSnapshot(busKey)).toEqual({ clipped: true, heldPeakDb: 2.1 });
    expect(trackListener).toHaveBeenCalledTimes(1);
    expect(busListener).toHaveBeenCalledTimes(1);
    unsubscribeTrack();
    unsubscribeBus();
  });
});
