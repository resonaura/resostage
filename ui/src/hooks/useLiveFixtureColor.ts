import { useEffect, useState } from "react";
import { getLiveLedOutputs, subscribeLiveLedOutputs } from "../lib/liveLevels";
import type { PreviewColor } from "../components/light/ResoLightStage3D";

/**
 * One fixture's live per-LED colours off the binary telemetry stream.
 *
 * The subscription fires whenever ANY fixture in the rig changes, so the
 * reference check below is what keeps a single blinking bar from re-rendering
 * (and re-allocating a THREE.Color for every segment of) every other fixture
 * on the stage. liveLevels hands back the same LiveLedOutput object frame
 * after frame while a fixture's colours hold still, which makes that check
 * exact rather than approximate -- see its structural-sharing note.
 */
export function useLiveFixtureColor(
  fixtureIndex: number,
  live: boolean,
): PreviewColor | undefined {
  const [previewColor, setPreviewColor] = useState<PreviewColor | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!live) {
      setPreviewColor(undefined);
      return;
    }
    const apply = () => {
      const lo = getLiveLedOutputs().find((l) => l.fixtureIdx === fixtureIndex);
      setPreviewColor((prev) => {
        const nextLeds = lo?.ledColors;
        // Same wire rows as last time (or still nothing at all): return the
        // previous value so React bails out of the update entirely.
        if (prev?.ledColors === nextLeds) return prev;
        if (!lo) return undefined;
        return { r: 0, g: 0, b: 0, intensity: 1, ledColors: lo.ledColors };
      });
    };
    apply();
    return subscribeLiveLedOutputs(apply);
  }, [live, fixtureIndex]);
  return previewColor;
}
