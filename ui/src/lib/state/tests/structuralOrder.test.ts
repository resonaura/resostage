/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { StructuralSnapshotOrder } from "@/lib/state/structuralOrder";

describe("structural snapshot ordering", () => {
  it("rejects older project revisions even from a newer HTTP request", () => {
    const order = new StructuralSnapshotOrder();
    expect(order.accept({ stateSessionId: "Core", stateRevision: 8 }, 0, 1)).toBe(true);
    expect(order.accept({ stateSessionId: "Core", stateRevision: 7 }, 0, 2)).toBe(false);
    expect(order.accept({ stateSessionId: "Core", stateRevision: 9 }, 0, 2)).toBe(true);
  });
  it("rejects reordered polls at the same revision", () => {
    const order = new StructuralSnapshotOrder();
    expect(order.accept({ stateRevision: 4 }, 0, 3)).toBe(true);
    expect(order.accept({ stateRevision: 4 }, 0, 2)).toBe(false);
  });
  it("accepts Core restart but never lets the previous session return", () => {
    const order = new StructuralSnapshotOrder();
    expect(order.accept({ stateSessionId: "before", stateRevision: 100 }, 0, 1)).toBe(true);
    expect(order.accept({ stateSessionId: "after", stateRevision: 0 }, 0, 2)).toBe(true);
    expect(order.accept({ stateSessionId: "before", stateRevision: 101 }, 0, 3)).toBe(false);
  });
  it("invalidates all responses from the previously selected backend", () => {
    const order = new StructuralSnapshotOrder();
    const old = order.generation();
    order.reset();
    expect(order.accept({ stateRevision: 10 }, old, 3)).toBe(false);
    expect(order.accept({ stateRevision: 0 }, order.generation(), 1)).toBe(true);
  });
});
