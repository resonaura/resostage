/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationLaneRow } from "@/lib/state/types";
import {
  useAutomationTouchRecorder,
  type UseAutomationTouchRecorderProps,
} from "../useAutomationTouchRecorder";

describe("useAutomationTouchRecorder", () => {
  let root: Root;
  let container: HTMLDivElement;
  let recorder: ReturnType<typeof useAutomationTouchRecorder>;

  const lanes: AutomationLaneRow[] = [
    {
      id: "lane-touch",
      target: {
        domain: "strip",
        entityId: "track-1",
        parameterId: "faderGainDb",
        valueType: "decibels",
        defaultValue: 0,
        minValue: -60,
        maxValue: 12,
      },
      scope: "track",
      enabled: true,
      writeMode: "touch",
      points: [
        { timeBeats: 0, value: 0, curve: 0 },
        { timeBeats: 16, value: 0, curve: 0 },
      ],
    },
    {
      id: "lane-write",
      target: {
        domain: "strip",
        entityId: "track-1",
        parameterId: "pan",
        valueType: "floatNormalized",
        defaultValue: 0,
        minValue: -1,
        maxValue: 1,
      },
      scope: "track",
      enabled: true,
      writeMode: "write",
      points: [],
    },
  ];

  beforeEach(() => {
    // @ts-expect-error test env global
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function Harness(props: UseAutomationTouchRecorderProps) {
    recorder = useAutomationTouchRecorder(props);
    return createElement("div", null);
  }

  function render(props: UseAutomationTouchRecorderProps) {
    act(() => root.render(createElement(Harness, { projectIdentity: "test-core:1", ...props })));
  }

  it("does not start gestures when transport is not playing", () => {
    const onCommit = vi.fn();
    render({
      songIndex: 0,
      lanes,
      isPlaying: false,
      getCurrentBeats: () => 4.0,
      onCommitGesture: onCommit,
    });

    act(() => {
      recorder.startGesture(
        { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" },
        0,
      );
    });

    expect(recorder.isLaneActive("lane-touch")).toBe(false);
  });

  it("does not record until Core session and project epoch are confirmed", () => {
    render({
      songIndex: 0,
      projectIdentity: null,
      lanes,
      isPlaying: true,
      getCurrentBeats: () => 4.0,
    });

    act(() => recorder.startGesture(
      { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" }, 0,
    ));

    expect(recorder.isLaneActive("lane-touch")).toBe(false);
  });

  it("records and commits touch gesture with return ramp", () => {
    let currentBeats = 4.0;
    const onCommit = vi.fn();

    render({
      songIndex: 0,
      lanes,
      isPlaying: true,
      getCurrentBeats: () => currentBeats,
      onCommitGesture: onCommit,
    });

    act(() => {
      recorder.startGesture(
        { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" },
        0,
      );
    });
    expect(recorder.isLaneActive("lane-touch")).toBe(true);

    act(() => {
      currentBeats = 6.0;
      recorder.recordValue(
        { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" },
        -6.0,
      );
    });

    act(() => {
      currentBeats = 7.0;
      recorder.finishGesture(
        { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" },
        -6.0,
        1.0,
      );
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    const commit = onCommit.mock.calls[0][0];
    expect(commit.laneId).toBe("lane-touch");
    expect(commit.punchInBeats).toBe(4.0);
    expect(commit.releaseBeats).toBe(7.0);
    expect(commit.releaseValue).toBe(-6.0);
    expect(commit.returnRampBeats).toBe(1.0);
    expect(commit.shouldRevertWriteMode).toBe(false);
    expect(recorder.isLaneActive("lane-touch")).toBe(false);
  });

  it("signals writeMode revert to safety for Write mode gestures", () => {
    let currentBeats = 2.0;
    const onCommit = vi.fn();
    const onRevert = vi.fn();

    render({
      songIndex: 0,
      lanes,
      isPlaying: true,
      getCurrentBeats: () => currentBeats,
      onCommitGesture: onCommit,
      onWriteModeRevert: onRevert,
    });

    act(() => {
      recorder.startGesture(
        { domain: "strip", entityId: "track-1", parameterId: "pan" },
        0,
      );
    });

    act(() => {
      currentBeats = 4.0;
      recorder.finishGesture(
        { domain: "strip", entityId: "track-1", parameterId: "pan" },
        0.5,
        0,
      );
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].shouldRevertWriteMode).toBe(true);
    expect(onRevert).toHaveBeenCalledWith("lane-write");
  });

  it("commits held latch gestures when transport stops", () => {
    const latchLanes: AutomationLaneRow[] = [
      {
        id: "lane-latch",
        target: {
          domain: "strip",
          entityId: "track-1",
          parameterId: "pan",
          valueType: "floatNormalized",
          defaultValue: 0,
          minValue: -1,
          maxValue: 1,
        },
        scope: "track",
        enabled: true,
        writeMode: "latch",
        points: [],
      },
    ];

    let currentBeats = 2.0;
    const onCommit = vi.fn();

    render({
      songIndex: 0,
      lanes: latchLanes,
      isPlaying: true,
      getCurrentBeats: () => currentBeats,
      onCommitGesture: onCommit,
    });

    act(() => {
      recorder.startGesture(
        { domain: "strip", entityId: "track-1", parameterId: "pan" },
        0,
      );
      currentBeats = 3.0;
      recorder.recordValue(
        { domain: "strip", entityId: "track-1", parameterId: "pan" },
        0.8,
      );
      recorder.finishGesture(
        { domain: "strip", entityId: "track-1", parameterId: "pan" },
        0.8,
      );
    });

    // Latch is holding, not committed yet
    expect(onCommit).not.toHaveBeenCalled();
    expect(recorder.hasHoldingLatch()).toBe(true);

    // Transport stops at beat 5.0
    currentBeats = 5.0;
    render({
      songIndex: 0,
      lanes: latchLanes,
      isPlaying: false,
      getCurrentBeats: () => currentBeats,
      onCommitGesture: onCommit,
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].releaseBeats).toBe(5.0);
    expect(onCommit.mock.calls[0][0].releaseValue).toBe(0.8);
    expect(recorder.hasHoldingLatch()).toBe(false);
  });

  it("cancels capture across Core/project identity changes before stopped transport can commit it", () => {
    let currentBeats = 3.0;
    const onCommit = vi.fn();
    render({
      songIndex: 0,
      projectIdentity: "core-a:4",
      lanes,
      isPlaying: true,
      getCurrentBeats: () => currentBeats,
      onCommitGesture: onCommit,
    });
    act(() => recorder.startGesture(
      { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" }, 0,
    ));
    expect(recorder.isLaneActive("lane-touch")).toBe(true);

    currentBeats = 0.0;
    render({
      songIndex: 0,
      projectIdentity: "core-b:1",
      lanes,
      isPlaying: false,
      getCurrentBeats: () => currentBeats,
      onCommitGesture: onCommit,
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(recorder.isLaneActive("lane-touch")).toBe(false);
  });

  it("observes playhead updates and splits a Touch pass at a cycle wrap", () => {
    let currentBeats = 4.0;
    const cycleRange = { leftBeats: 4.0, rightBeats: 8.0 };
    const onCommit = vi.fn();
    const props = {
      songIndex: 0,
      projectIdentity: "core-a:4",
      lanes,
      isPlaying: true,
      getCurrentBeats: () => currentBeats,
      cycleRange,
      onCommitGesture: onCommit,
    } satisfies UseAutomationTouchRecorderProps;
    render(props);
    act(() => recorder.startGesture(
      { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" }, 0,
    ));

    currentBeats = 7.9;
    render(props);
    act(() => recorder.recordValue(
      { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" }, -3.0,
    ));
    currentBeats = 4.05;
    render(props);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].releaseBeats).toBe(8.0);
    expect(onCommit.mock.calls[0][0].punchInBeats).toBe(4.0);
    expect(recorder.isLaneActive("lane-touch")).toBe(true);
  });
});
