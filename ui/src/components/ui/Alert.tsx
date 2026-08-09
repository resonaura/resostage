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
