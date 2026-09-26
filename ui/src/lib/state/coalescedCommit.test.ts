import { describe, expect, it } from "vitest";
import { createCoalescedCommit, type CommitScheduler } from "./optimistic";

/** A hand-cranked clock: nothing runs until the test says so. */
function fakeScheduler() {
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();

  const scheduler: CommitScheduler = {
    requestFrame: (cb) => {
      const h = nextHandle++;
      frames.set(h, cb);
      return h;
    },
    cancelFrame: (h) => {
      frames.delete(h);
    },
    setTimer: (cb) => {
      const h = nextHandle++;
      timers.set(h, cb);
      return h as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h) => {
      timers.delete(h as unknown as number);
    },
  };

  return {
    scheduler,
    /** Run every callback queued for the next frame. */
    tickFrame() {
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb();
    },
    /** Run the stall safety net instead, as a stalled rAF would. */
    tickTimer() {
      const due = [...timers.values()];
      timers.clear();
      for (const cb of due) cb();
    },
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size,
  };
}

describe("createCoalescedCommit", () => {
  it("collapses a burst within one frame into a single latest-wins commit", () => {
    const seen: number[] = [];
    const clock = fakeScheduler();
    const { send } = createCoalescedCommit<number>(
      (v) => seen.push(v),
      clock.scheduler,
    );

    for (let i = 1; i <= 20; i++) send(i);
    expect(seen).toEqual([]); // nothing written mid-burst

    clock.tickFrame();
    expect(seen).toEqual([20]);
  });

  it("writes once per frame across a continuing gesture", () => {
    const seen: number[] = [];
    const clock = fakeScheduler();
    const { send } = createCoalescedCommit<number>(
      (v) => seen.push(v),
      clock.scheduler,
    );

    send(1);
    send(2);
    clock.tickFrame();
    send(3);
    send(4);
    clock.tickFrame();

    expect(seen).toEqual([2, 4]);
  });

  it("delivers the last value when a gesture ends before the frame runs", () => {
    const seen: number[] = [];
    const clock = fakeScheduler();
    const { send, flush } = createCoalescedCommit<number>(
      (v) => seen.push(v),
      clock.scheduler,
    );

    send(7);
    flush(); // e.g. the control unmounted on pointerup
    expect(seen).toEqual([7]);

    // The superseded frame and timer must not fire a second write.
    clock.tickFrame();
    clock.tickTimer();
    expect(seen).toEqual([7]);
  });

  it("still writes when the frame never comes", () => {
    const seen: number[] = [];
    const clock = fakeScheduler();
    const { send } = createCoalescedCommit<number>(
      (v) => seen.push(v),
      clock.scheduler,
    );

    send(42);
    clock.tickTimer(); // backgrounded window: rAF stalled, timeout fired
    expect(seen).toEqual([42]);

    clock.tickFrame();
    expect(seen).toEqual([42]);
  });

  it("goes quiet once flushed", () => {
    const seen: number[] = [];
    const clock = fakeScheduler();
    const { send } = createCoalescedCommit<number>(
      (v) => seen.push(v),
      clock.scheduler,
    );

    send(1);
    clock.tickFrame();
    expect(clock.pendingFrames()).toBe(0);
    expect(clock.pendingTimers()).toBe(0);

    clock.tickFrame();
    expect(seen).toEqual([1]);
  });
});
