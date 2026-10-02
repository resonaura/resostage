/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  BoundedCommandQueue,
  coalescingTargetKey,
  utf8ByteLength,
} from "@/lib/state/commandQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("BoundedCommandQueue", () => {
  it("serializes work and releases byte reservations after success and failure", async () => {
    const queue = new BoundedCommandQueue({
      maxPendingCommands: 3,
      maxRetainedPayloadBytes: 8,
    });
    const firstGate = deferred<string>();
    const order: string[] = [];
    const first = queue.run(5, async () => {
      order.push("first-start");
      return firstGate.promise;
    });
    const second = queue.run(3, async () => {
      order.push("second");
      throw new Error("deliberate failure");
    });

    expect(queue.pendingCount).toBe(2);
    expect(queue.retainedBytes).toBe(8);
    await expect(queue.run(1, async () => "over-budget")).rejects.toThrow(
      "Pending Core command payload limit exceeded",
    );

    firstGate.resolve("done");
    await expect(first).resolves.toBe("done");
    await expect(second).rejects.toThrow("deliberate failure");
    expect(order).toEqual(["first-start", "second"]);
    expect(queue.pendingCount).toBe(0);
    expect(queue.retainedBytes).toBe(0);
    await expect(queue.run(8, async () => "recovered")).resolves.toBe("recovered");
    expect(queue.retainedBytes).toBe(0);
  });

  it("rejects command-count exhaustion without retaining the rejected body", async () => {
    const queue = new BoundedCommandQueue({
      maxPendingCommands: 1,
      maxRetainedPayloadBytes: 16,
    });
    const gate = deferred<void>();
    const active = queue.run(4, () => gate.promise);

    await expect(queue.run(4, async () => undefined)).rejects.toThrow(
      "Too many pending Core commands",
    );
    expect(queue.pendingCount).toBe(1);
    expect(queue.retainedBytes).toBe(4);

    gate.resolve();
    await active;
    expect(queue.pendingCount).toBe(0);
    expect(queue.retainedBytes).toBe(0);
  });
});

describe("utf8ByteLength", () => {
  it("counts the exact serialized UTF-8 length without allocating an encoder copy", () => {
    expect(utf8ByteLength("ascii JSON {}\n")).toBe(14);
    expect(utf8ByteLength("é漢🎹")).toBe(9);
    expect(utf8ByteLength("\ud800")).toBe(3);
  });
});

describe("coalescingTargetKey", () => {
  const changingFields = new Set(["level"]);

  it("coalesces values only for the same complete target identity", () => {
    const first = coalescingTargetKey("/send", {
      trackIndex: 2,
      busId: "bus-a",
      level: 0.25,
    }, changingFields, "first");
    const sameTarget = coalescingTargetKey("/send", {
      busId: "bus-a",
      level: 0.75,
      trackIndex: 2,
    }, changingFields, "second");
    const otherBus = coalescingTargetKey("/send", {
      trackIndex: 2,
      busId: "bus-b",
      level: 0.75,
    }, changingFields, "third");
    const differentTap = coalescingTargetKey("/send", {
      trackIndex: 2,
      busId: "bus-a",
      level: 0.75,
      tap: "pre-fader",
    }, changingFields, "fourth");

    expect(sameTarget).toBe(first);
    expect(otherBus).not.toBe(first);
    expect(differentTap).not.toBe(first);
  });
});
