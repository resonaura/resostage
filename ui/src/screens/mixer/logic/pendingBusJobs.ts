// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

/** A bus-creation request awaiting its new row in the next state snapshot. */
export interface PendingBusJob {
  knownIds: Set<string>;
  finalize: (busId: string, index: number) => void;
}

/**
 * Match queued creation requests to newly observed buses in order, claiming
 * each new bus at most once. Jobs without a matching row remain pending.
 */
export function resolvePendingBusJobs(
  jobs: PendingBusJob[],
  busses: readonly { id: string }[],
): PendingBusJob[] {
  const claimed = new Set<string>();
  const remaining: PendingBusJob[] = [];

  for (const job of jobs) {
    const index = busses.findIndex(
      (bus) => !job.knownIds.has(bus.id) && !claimed.has(bus.id),
    );
    if (index >= 0) {
      const busId = busses[index].id;
      claimed.add(busId);
      job.finalize(busId, index);
    } else {
      remaining.push(job);
    }
  }

  return remaining;
}
