import { useEffect, useState } from "react";
import { getLiveLedOutputs, subscribeLiveLedOutputs } from "../lib/liveLevels";
import type { PreviewColor } from "../components/light/ResoLightStage3D";

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
      const lo = getLiveLedOutputs().find(
        (l) => l.fixtureIdx === fixtureIndex,
      );
      setPreviewColor(
        lo
          ? { r: 0, g: 0, b: 0, intensity: 1, ledColors: lo.ledColors }
          : undefined,
      );
    };
    apply();
    return subscribeLiveLedOutputs(apply);
  }, [live, fixtureIndex]);
  return previewColor;
}
