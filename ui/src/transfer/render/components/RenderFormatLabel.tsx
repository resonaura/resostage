/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Chip } from "@heroui/react";
import { renderFormatProfile, type RenderFormat } from "@/transfer/render/logic/renderFormats";

/** Use the actual filename extension; shared containers carry a codec badge. */
export function RenderFormatLabel({ format }: { format: RenderFormat }) {
  const profile = renderFormatProfile(format);
  return (
    <span className="inline-flex min-w-0 items-center gap-2 whitespace-nowrap">
      <span className="font-mono">{profile.extension}</span>
      {profile.codec && (
        <Chip size="sm" variant="secondary" className="h-5 shrink-0 rounded-md px-1.5 text-[9px]">
          {profile.codec}
        </Chip>
      )}
    </span>
  );
}
