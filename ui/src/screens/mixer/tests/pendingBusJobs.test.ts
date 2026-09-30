import { describe, expect, it, vi } from "vitest";
import {
  resolvePendingBusJobs,
  type PendingBusJob,
} from "../logic/pendingBusJobs";

const job = (
  knownIds: string[],
  finalize: PendingBusJob["finalize"] = vi.fn(),
): PendingBusJob => ({ knownIds: new Set(knownIds), finalize });

describe("resolvePendingBusJobs", () => {
  it("finalizes a job against the first newly observed bus", () => {
    const finalize = vi.fn();

    const remaining = resolvePendingBusJobs(
      [job(["master", "existing"], finalize)],
      [{ id: "master" }, { id: "existing" }, { id: "new-send" }],
    );

    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith("new-send", 2);
    expect(remaining).toEqual([]);
  });

  it("assigns distinct new buses to concurrent jobs in request order", () => {
    const firstFinalize = vi.fn();
    const secondFinalize = vi.fn();

    const remaining = resolvePendingBusJobs(
      [
        job(["master"], firstFinalize),
        job(["master"], secondFinalize),
      ],
      [{ id: "master" }, { id: "send-a" }, { id: "send-b" }],
    );

    expect(firstFinalize).toHaveBeenCalledWith("send-a", 1);
    expect(secondFinalize).toHaveBeenCalledWith("send-b", 2);
    expect(remaining).toEqual([]);
  });

  it("keeps unmatched jobs pending and does not claim pre-existing buses", () => {
    const finalize = vi.fn();
    const pending = job(["master", "send-a"], finalize);

    const remaining = resolvePendingBusJobs(
      [pending],
      [{ id: "master" }, { id: "send-a" }],
    );

    expect(finalize).not.toHaveBeenCalled();
    expect(remaining).toEqual([pending]);
  });
});
