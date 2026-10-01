/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Alert as HeroAlert } from "@heroui/react";
import type { ComponentProps } from "react";

/**
 * Local Alert wrapper that uses background-tertiary surface fill by default,
 * matching Card and other panel containers.
 */

type HeroAlertProps = ComponentProps<typeof HeroAlert>;

export type AlertProps = HeroAlertProps;

function AlertRoot({ className, ...rest }: AlertProps) {
  const alertClassName = ["rs-card-surface", className]
    .filter(Boolean)
    .join(" ");

  return <HeroAlert className={alertClassName} {...rest} />;
}

export const Alert = Object.assign(AlertRoot, {
  Indicator: HeroAlert.Indicator,
  Content: HeroAlert.Content,
  Title: HeroAlert.Title,
  Description: HeroAlert.Description,
});
