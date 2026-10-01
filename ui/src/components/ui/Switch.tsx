/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Switch as HeroSwitch } from "@heroui/react";
import type { ComponentProps } from "react";
import React from "react";
import { withTone, type Tone } from "@/components/ui/tones";

type HeroSwitchProps = ComponentProps<typeof HeroSwitch>;

export interface SwitchProps extends HeroSwitchProps {
  tone?: Tone;
  /** Optional HTML tabIndex. Defaults to -1 to prevent cluttering DAW tab order. */
  tabIndex?: number;
}

function SwitchRoot({
  tone,
  className,
  children,
  tabIndex = -1,
  onMouseDown,
  ...rest
}: SwitchProps) {
  const handleMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (tabIndex === -1) {
      e.preventDefault();
    }
    onMouseDown?.(e as any);
  };

  if (typeof children === "function") {
    return (
      <HeroSwitch
        {...(tabIndex !== undefined ? ({ tabIndex } as any) : {})}
        onMouseDown={handleMouseDown}
        className={withTone(className, tone)}
        {...rest}
      >
        {children}
      </HeroSwitch>
    );
  }

  const hasContent = React.Children.toArray(children).some(
    (child) =>
      React.isValidElement(child) &&
      (child.type === HeroSwitch.Content ||
        (child.type as any)?.displayName === "SwitchContent" ||
        (child.type as any)?.name === "SwitchContent"),
  );

  return (
    <HeroSwitch
      {...(tabIndex !== undefined ? ({ tabIndex } as any) : {})}
      onMouseDown={handleMouseDown}
      className={withTone(className, tone)}
      {...rest}
    >
      {hasContent ? (
        (children as React.ReactNode)
      ) : (
        <HeroSwitch.Content className="cursor-pointer">
          <HeroSwitch.Control>
            <HeroSwitch.Thumb />
          </HeroSwitch.Control>
          {children as React.ReactNode}
        </HeroSwitch.Content>
      )}
    </HeroSwitch>
  );
}

export const Switch = Object.assign(SwitchRoot, {
  Root: SwitchRoot,
  Content: HeroSwitch.Content,
  Control: HeroSwitch.Control,
  Thumb: HeroSwitch.Thumb,
  Icon: HeroSwitch.Icon,
});
