/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { lazy, Suspense, type ComponentProps } from "react";
import type { ResoLightStage3D as Stage } from "@/screens/light/components/ResoLightStage3D";

/**
 * The 3D stage preview, split into its own chunk.
 *
 * three.js plus @react-three/fiber and drei is by far the largest thing this
 * app ships -- a good fraction of the whole bundle, and all of it parsed
 * before the first paint even for a project with no fixtures at all. That is
 * paid on every load, on the slowest device, to render a preview that may
 * never appear. Behind a dynamic import it is fetched only when a stage view
 * actually mounts, and the browser can cache it independently of the app code
 * that changes far more often.
 *
 * The fallback is deliberately empty: the stage already fades itself in after
 * its first framed camera pass (see ResoLightStage3D's `fadedIn`), so a
 * spinner would only add a flash of something else before that.
 */
const Stage3D = lazy(() =>
  import("@/screens/light/components/ResoLightStage3D").then((m) => ({ default: m.ResoLightStage3D })),
);

export type { PreviewColor } from "@/screens/light/components/ResoLightStage3D";

export function ResoLightStage3D(props: ComponentProps<typeof Stage>) {
  return (
    <Suspense fallback={null}>
      <Stage3D {...props} />
    </Suspense>
  );
}
