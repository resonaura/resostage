// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

export function RoutingSlotPlaceholder() {
  return (
    <div
      aria-hidden="true"
      title="Direct output channel (active when Ext. Out is selected)"
      className="h-5.5 w-full shrink-0 rounded-lg ring-1 ring-inset ring-default/25 select-none"
    />
  );
}
