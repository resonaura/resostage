// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { activeDragCount, beginCancellableDrag } from "./dragCancel";

const esc = () =>
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );

afterEach(() => {
  // Nothing should ever leak between tests; if it does, that IS the bug the
  // "listener outlives the drag" comment warns about.
  expect(activeDragCount()).toBe(0);
});

describe("beginCancellableDrag", () => {
  it("reverts on Esc and reports cancelled", () => {
    const revert = vi.fn();
    const drag = beginCancellableDrag(revert);
    esc();
    expect(revert).toHaveBeenCalledTimes(1);
    expect(drag.cancelled).toBe(true);
  });

  it("does not revert on a normal end", () => {
    const revert = vi.fn();
    const drag = beginCancellableDrag(revert);
    drag.end();
    expect(revert).not.toHaveBeenCalled();
    expect(drag.cancelled).toBe(false);
  });

  it("ignores Esc after the drag ended", () => {
    // The failure this guards: a stale listener reverting a value the user
    // committed seconds ago, the next time they press Esc to close a menu.
    const revert = vi.fn();
    beginCancellableDrag(revert).end();
    esc();
    expect(revert).not.toHaveBeenCalled();
  });

  it("ignores keys other than Escape", () => {
    const revert = vi.fn();
    const drag = beginCancellableDrag(revert);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(revert).not.toHaveBeenCalled();
    drag.end();
  });

  it("reverts only once, however many times Esc is pressed", () => {
    const revert = vi.fn();
    const drag = beginCancellableDrag(revert);
    esc();
    esc();
    expect(revert).toHaveBeenCalledTimes(1);
    drag.end(); // idempotent after a cancel
    expect(revert).toHaveBeenCalledTimes(1);
  });

  it("cancel() is equivalent to Esc", () => {
    const revert = vi.fn();
    const drag = beginCancellableDrag(revert);
    drag.cancel();
    drag.cancel();
    expect(revert).toHaveBeenCalledTimes(1);
    expect(drag.cancelled).toBe(true);
  });

  it("Esc addresses the innermost drag only", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const outerDrag = beginCancellableDrag(outer);
    const innerDrag = beginCancellableDrag(inner);

    esc();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    expect(innerDrag.cancelled).toBe(true);
    expect(outerDrag.cancelled).toBe(false);

    esc(); // the outer drag is now innermost
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("stops Esc from reaching anything else while a drag is live", () => {
    // Otherwise aborting a knob drag inside a dialog also closes the dialog.
    const bystander = vi.fn();
    window.addEventListener("keydown", bystander);
    const drag = beginCancellableDrag(() => {});
    esc();
    expect(bystander).not.toHaveBeenCalled();

    drag.end();
    esc();
    expect(bystander).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", bystander);
  });

  it("lets a revert start a fresh drag without corrupting the stack", () => {
    // Components that remount on revert re-arm from their own pointerdown; the
    // cancelled entry must already be off the stack when that happens.
    let restarted: ReturnType<typeof beginCancellableDrag> | null = null;
    const drag = beginCancellableDrag(() => {
      restarted = beginCancellableDrag(() => {});
    });
    esc();
    expect(drag.cancelled).toBe(true);
    expect(activeDragCount()).toBe(1);
    restarted!.end();
  });
});
