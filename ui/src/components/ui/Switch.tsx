import { Switch as HeroSwitch } from "@heroui/react";
import type { ComponentProps } from "react";
import React from "react";
import { withTone, type Tone } from "./tones";

type HeroSwitchProps = ComponentProps<typeof HeroSwitch>;

export interface SwitchProps extends HeroSwitchProps {
  tone?: Tone;
}

function SwitchRoot({ tone, className, children, ...rest }: SwitchProps) {
  if (typeof children === "function") {
    return (
      <HeroSwitch className={withTone(className, tone)} {...rest}>
        {children}
      </HeroSwitch>
    );
  }

  const hasContent = React.Children.toArray(children).some(
    (child) =>
      React.isValidElement(child) &&
      (child.type === HeroSwitch.Content ||
        (child.type as any)?.displayName === "SwitchContent" ||
        (child.type as any)?.name === "SwitchContent")
  );

  return (
    <HeroSwitch className={withTone(className, tone)} {...rest}>
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
