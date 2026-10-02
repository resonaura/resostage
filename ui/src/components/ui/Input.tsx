/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Input as HeroInput } from "@heroui/react";
import type { ComponentProps } from "react";

type HeroInputProps = ComponentProps<typeof HeroInput>;
export interface InputProps extends HeroInputProps {
  /** Inline edit transactions settle Escape/Enter before returning canvas focus. */
  ownsEditingKeys?: boolean;
}

/** Shared theme-aware input; text editing intentionally retains keyboard focus. */
export function Input({ variant = "secondary", className, ownsEditingKeys = false, ...props }: InputProps) {
  return <HeroInput variant={variant}
    data-rs-editing-keys={ownsEditingKeys ? "owned" : undefined}
    className={`border border-default/50 bg-background-secondary text-foreground ${className ?? ""}`}
    {...props} />;
}
