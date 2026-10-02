/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Tooltip as HeroTooltip } from "@heroui/react";
import type { ComponentProps, ReactNode } from "react";

/** Shared compact tooltip material; the child remains the actual control. */
export function Tooltip({ content, children, delay = 500, ...props }:
  Omit<ComponentProps<typeof HeroTooltip>, "children"> & { content: ReactNode; children: ReactNode }) {
  return <HeroTooltip delay={delay} {...props}>{children}
    <HeroTooltip.Content className="border border-default/30 bg-background-secondary px-2 py-1 text-xs text-foreground shadow-sm">
      {content}
    </HeroTooltip.Content>
  </HeroTooltip>;
}
