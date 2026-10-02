/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Input as HeroInput } from "@heroui/react";
import type { ComponentProps } from "react";

export type InputProps = ComponentProps<typeof HeroInput>;

/** Shared theme-aware input; text editing intentionally retains keyboard focus. */
export function Input({ variant = "secondary", className, ...props }: InputProps) {
  return <HeroInput variant={variant}
    className={`border border-default/50 bg-background-secondary text-foreground ${className ?? ""}`}
    {...props} />;
}
