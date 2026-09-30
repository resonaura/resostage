import type { LightFixtureRow } from "../../../lib/state/types";

export type FixtureLayoutPosition = { id: string; posX: number; posZ: number };

/** Compute the same centered row layout that the backend uses by default. */
export function autoLayoutPositions(
  fixtures: LightFixtureRow[],
): FixtureLayoutPosition[] {
  if (fixtures.length === 0) return [];
  // Matches the backend's default column spacing (regenerateResoLightFixtures
  // in MainComponentLighting.cpp) so manual auto-layout produces the same
  // rig spacing as the initial grid, instead of a denser 1.2m guess.
  const spacing = 2.0;
  const total = fixtures.length;
  const half = (total - 1) / 2;
  return fixtures.map((fixture, index) => ({
    id: fixture.id,
    posX: (index - half) * spacing,
    posZ: 0,
  }));
}

/**
 * Detect overlapping explicit DMX address ranges among generic fixtures.
 * ResoLight bars are auto-packed by the backend and must not be re-modeled
 * here, or frontend validation could drift from actual patch assignment.
 */
export function findDmxChannelConflicts(
  fixtures: LightFixtureRow[],
): Set<string> {
  const conflicting = new Set<string>();
  const generic = fixtures.filter((fixture) => fixture.kind === "dmx::generic");
  for (let i = 0; i < generic.length; i++) {
    const a = generic[i];
    const aEnd = a.dmx.startChannel + Math.max(1, a.dmx.channelCount);
    for (let j = i + 1; j < generic.length; j++) {
      const b = generic[j];
      if (a.dmx.universe !== b.dmx.universe) continue;
      const bEnd = b.dmx.startChannel + Math.max(1, b.dmx.channelCount);
      const overlaps = a.dmx.startChannel < bEnd && b.dmx.startChannel < aEnd;
      if (overlaps) {
        conflicting.add(a.id);
        conflicting.add(b.id);
      }
    }
  }
  return conflicting;
}
