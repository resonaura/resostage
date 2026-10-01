// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useRef } from "react";
import { CollapsibleInline } from "@/components/ui";

/**
 * The drift figure, which appears and disappears while the transport runs.
 *
 * Collapsed rather than unmounted so the bar count beside it does not jump --
 * see CollapsibleInline for why that needs more than an opacity fade. The
 * last non-unity value is held while collapsing so the text does not blank
 * out halfway through its own exit.
 */
export function DriftReadout({ drift }: { drift: number }) {
  const valid = drift !== undefined && drift !== 0;
  const isDrifting = Math.abs(drift - 1) > 0.00005;
  const lastRef = useRef(drift || 1);
  if (valid) lastRef.current = drift;
  return (
    <CollapsibleInline
      open={valid}
      className={isDrifting ? "text-warning font-medium" : "text-foreground/40"}
    >
      drift ×{lastRef.current.toFixed(4)}
    </CollapsibleInline>
  );
}
