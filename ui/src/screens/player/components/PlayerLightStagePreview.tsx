/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { memo } from "react";
import { Card } from "@/components/ui";
import { ResoLightStage3D } from "@/screens/light/components/LazyResoLightStage3D";
import type { LightFixtureRow } from "@/lib/state/types";

// Memoized on the fixture roster alone. That roster is shipped on every
// telemetry frame ("lighting ... always shipped" in WebServer.cpp) but rarely
// actually changes, and structural sharing in the live-state merge keeps its
// reference stable when it doesn't -- so the WebGL stage now mounts once and
// stays put instead of being re-rendered under the live LED stream.
export const PlayerLightStagePreview = memo(function PlayerLightStagePreview({
  fixtures,
  enabled,
}: {
  fixtures: LightFixtureRow[];
  enabled: boolean;
}) {
  if (fixtures.length === 0) return null;

  return (
    <Card className="relative flex h-40 w-full shrink-0 flex-col overflow-hidden sm:h-full sm:w-52 p-0 gap-0">
      <Card.Header className="h-10 border-b border-default/20 px-3.5 text-[11px] font-bold uppercase tracking-widest text-foreground/35 flex flex-row items-center justify-between z-10 space-y-0 shrink-0">
        <span>Stage Lights</span>
      </Card.Header>
      <Card.Content className="flex flex-col flex-1 min-h-0 relative p-0 overflow-hidden">
        <ResoLightStage3D
          mode="preview"
          fixtures={fixtures}
          live={enabled}
          chrome="minimal"
        />
      </Card.Content>
    </Card>
  );
});
