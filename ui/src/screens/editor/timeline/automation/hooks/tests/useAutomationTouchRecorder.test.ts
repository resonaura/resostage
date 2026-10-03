/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApiCaches, observeProjectCommandIdentity } from "@/lib/state/api";
import { setRemoteBackend } from "@/lib/state/backend";
import type { AutomationLaneRow } from "@/lib/state/types";
import {
  useAutomationTouchRecorder,
  type UseAutomationTouchRecorderProps,
} from "../useAutomationTouchRecorder";
import {
  loadAutomationGestureDrafts,
  persistAutomationGestureDrafts,
  type AutomationGestureRecoveryDraft,
} from "@/screens/editor/timeline/automation/logic/automationGestureRecovery";

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
  const recoveryLanes: AutomationLaneRow[] = [{
    id: "lane-recovery",
    target: {
      domain: "plugin",
      entityId: "slot-1",
      parameterId: "cutoff",
      valueType: "floatNormalized",
      defaultValue: 0,
      minValue: 0,
      maxValue: 1,
    },
    scope: "track",
    enabled: true,
    writeMode: "touch",
    points: [],
  }];

  beforeEach(() => {
    // @ts-expect-error test env global
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    setRemoteBackend(null);
    window.history.replaceState({}, "", "/?embedded=1");
    clearApiCaches();
    sessionStorage.clear();
    observeProjectCommandIdentity({ stateSessionId: "Core A", projectEpoch: 1 });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearApiCaches();
    vi.unstubAllGlobals();
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

  it("cancels uncommitted points and releases Core ownership without recording", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    const onCommit = vi.fn();
    render({
      songIndex: 0,
      lanes,
      isPlaying: true,
      getCurrentBeats: () => 4.0,
      onCommitGesture: onCommit,
    });

    await act(async () => {
      recorder.startGesture(
        { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" }, 0,
      );
      recorder.recordValue(
        { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" }, -6,
      );
      expect(recorder.cancelGesture(
        { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" },
      )).toEqual(["lane-touch"]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(recorder.isLaneActive("lane-touch")).toBe(false);
    const ownershipCalls = fetch.mock.calls.filter(([input]) =>
      String(input).endsWith("/api/v1/builder/automation/manual-override"),
    );
    expect(ownershipCalls).toHaveLength(2);
    expect(ownershipCalls.map(([, init]) => JSON.parse(String(init?.body)).active))
      .toEqual([true, false]);
    expect(fetch.mock.calls.some(([input]) =>
      String(input).endsWith("/api/v1/builder/automation/record-gesture"),
    )).toBe(false);
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

  it("uses Core cycle passes when a short-loop wrap is absent from playhead samples", () => {
    let currentBeats = 4.0;
    let cyclePassSequence = 12;
    const cycleRange = { leftBeats: 4.0, rightBeats: 8.0 };
    const onCommit = vi.fn();
    const props = {
      songIndex: 0,
      projectIdentity: "core-a:4",
      lanes,
      isPlaying: true,
      getCurrentBeats: () => currentBeats,
      cycleRange,
      cyclePassSequence,
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

    // The UI did not observe the right-edge frame; only Core's pass counter
    // proves transport crossed the loop boundary rather than seeking back.
    currentBeats = 4.05;
    cyclePassSequence += 1;
    render({ ...props, cyclePassSequence });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].releaseBeats).toBe(8.0);
    expect(onCommit.mock.calls[0][0].punchInBeats).toBe(4.0);
    expect(recorder.isLaneActive("lane-touch")).toBe(true);
  });

  it("segments a backwards seek without treating it as a Core cycle pass", () => {
    let currentBeats = 4.0;
    const cyclePassSequence = 12;
    const cycleRange = { leftBeats: 4.0, rightBeats: 8.0 };
    const onCommit = vi.fn();
    const props = {
      songIndex: 0,
      projectIdentity: "core-a:4",
      lanes,
      isPlaying: true,
      getCurrentBeats: () => currentBeats,
      cycleRange,
      cyclePassSequence,
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

    // A user seek to the left side is not a cycle pass.
    currentBeats = 4.05;
    render(props);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].releaseBeats).toBe(7.9);
    expect(onCommit.mock.calls[0][0].punchInBeats).toBe(4.0);
    expect(recorder.isLaneActive("lane-touch")).toBe(true);
  });

  it("bounds catch-up after a long renderer suspension and resumes at the live phase", () => {
    let currentBeats = 4.0;
    let cyclePassSequence = 12;
    const cycleRange = { leftBeats: 4.0, rightBeats: 8.0 };
    const onCommit = vi.fn();
    const props = {
      songIndex: 0,
      projectIdentity: "core-a:4",
      lanes,
      isPlaying: true,
      getCurrentBeats: () => currentBeats,
      cycleRange,
      cyclePassSequence,
      onCommitGesture: onCommit,
    } satisfies UseAutomationTouchRecorderProps;
    render(props);
    act(() => recorder.startGesture(
      { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" }, 0,
    ));
    currentBeats = 7.5;
    render(props);
    act(() => recorder.recordValue(
      { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" }, -4.0,
    ));

    currentBeats = 4.25;
    cyclePassSequence += 5;
    render({ ...props, cyclePassSequence });

    // Missing pass samples cannot be reconstructed; commit only known points
    // and re-arm once, instead of fabricating five identical loop gestures.
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0].releaseBeats).toBe(7.5);
    expect(onCommit.mock.calls[0][0].punchInBeats).toBe(4.0);
    expect(recorder.isLaneActive("lane-touch")).toBe(true);
    currentBeats = 4.5;
    render({ ...props, cyclePassSequence });
    act(() => recorder.recordValue(
      { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" }, -2.0,
    ));
    act(() => recorder.finishGesture(
      { domain: "strip", entityId: "track-1", parameterId: "faderGainDb" }, -2.0,
    ));
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit.mock.calls[1][0].punchInBeats).toBe(4.25);
  });

  it("retains an exact rejected gesture and retries it only against the same project", async () => {
    let requestId = 0;
    let applied = false;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/record-gesture")) {
        expect(loadAutomationGestureDrafts()).toHaveLength(1);
        expect(loadAutomationGestureDrafts()[0].outcome).toBe("unknown");
        requestId += 1;
        return new Response(JSON.stringify({
          accepted: true,
          requestId,
          stateSessionId: "Core A",
          projectEpoch: 1,
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        stateSessionId: "Core A",
        projectEpoch: 1,
        stateRevision: 2,
        playbackProjectEpoch: 1,
        playbackProjectRevision: 2,
        editorCommandResults: [{
          requestId,
          applied,
          projectEpoch: 1,
          projectRevision: 2,
          error: applied ? "" : "Core rejected the recording pass",
          applicationDomain: "audio",
          playbackApplied: applied,
          playbackProjectEpoch: 1,
          playbackRevision: 2,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    render({
      songIndex: 0,
      lanes: recoveryLanes,
      isPlaying: true,
      getCurrentBeats: () => 4.0,
    });

    await act(async () => {
      recorder.startGesture({ domain: "plugin", entityId: "slot-1", parameterId: "cutoff" }, 0);
      recorder.recordValue({ domain: "plugin", entityId: "slot-1", parameterId: "cutoff" }, 0.6);
      recorder.finishGesture({ domain: "plugin", entityId: "slot-1", parameterId: "cutoff" }, 0.6);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(recorder.recoveryDrafts).toHaveLength(1);
    expect(recorder.recoveryDrafts[0].outcome).toBe("rejected");
    expect(recorder.recoveryDrafts[0].payload.points.length).toBeGreaterThan(0);
    expect(recorder.recoveryDrafts[0].persisted).toBe(true);

    applied = true;
    await act(async () => recorder.retryRecoveryDraft(recorder.recoveryDrafts[0].id));
    expect(fetch.mock.calls.filter(([input]) => String(input).includes("/record-gesture"))).toHaveLength(2);
    expect(recorder.recoveryDrafts).toHaveLength(0);
  });

  it("never resends a gesture when the admitted request outcome is unknown", async () => {
    let postCount = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/record-gesture")) {
        postCount += 1;
        return new Response(JSON.stringify({
          accepted: true,
          requestId: postCount,
          stateSessionId: "Core A",
          projectEpoch: 1,
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ stateSessionId: "Core restarted", projectEpoch: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    render({
      songIndex: 0,
      lanes: recoveryLanes,
      isPlaying: true,
      getCurrentBeats: () => 4.0,
    });

    await act(async () => {
      recorder.startGesture({ domain: "plugin", entityId: "slot-1", parameterId: "cutoff" }, 0);
      recorder.recordValue({ domain: "plugin", entityId: "slot-1", parameterId: "cutoff" }, 0.6);
      recorder.finishGesture({ domain: "plugin", entityId: "slot-1", parameterId: "cutoff" }, 0.6);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(recorder.recoveryDrafts).toHaveLength(1);
    expect(recorder.recoveryDrafts[0].outcome).toBe("unknown");
    const requestCount = fetch.mock.calls.length;
    await act(async () => recorder.retryRecoveryDraft(recorder.recoveryDrafts[0].id));
    expect(fetch).toHaveBeenCalledTimes(requestCount);
    expect(postCount).toBe(1);
  });

  it.each(["Core project identity", "song", "lane"] as const)(
    "does not retry an exact rejection when its %s no longer matches",
    async (boundary) => {
      const draft: AutomationGestureRecoveryDraft = {
      id: "rejected-draft",
      projectIdentity: "test-core:1",
      songIndex: 0,
      createdAt: 123,
      outcome: "rejected" as const,
      error: "Core rejected the pass",
      persisted: false,
      payload: {
        laneId: "lane-recovery",
        gestureId: "gesture-rejected",
        writeMode: "touch" as const,
        punchInBeats: 4,
        releaseBeats: 5,
        releaseValue: 0.6,
        returnRampBeats: 0,
        underlyingValue: 0,
        points: [{ timeBeats: 4, value: 0.6 }],
        pointsCompacted: false,
        shouldRevertWriteMode: false,
      },
      };
      if (boundary === "Core project identity") draft.projectIdentity = "another-core:1";
      else if (boundary === "song") draft.songIndex = 1;
      else draft.payload.laneId = "removed-lane";
      persistAutomationGestureDrafts([draft]);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      render({
        songIndex: 0,
        lanes: recoveryLanes,
        isPlaying: true,
        getCurrentBeats: () => 4.0,
      });

      await act(async () => recorder.retryRecoveryDraft(draft.id));

      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
