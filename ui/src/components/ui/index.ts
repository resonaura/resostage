/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

/**
 * Local wrappers around HeroUI controls to unify colors, tones, and variants.
 */
export { Alert } from "@/components/ui/Alert";
export type { AlertProps } from "@/components/ui/Alert";

export { Button, ButtonGroup } from "@/components/ui/Button";
export type { ButtonGroupProps, ButtonProps, ButtonVariant } from "@/components/ui/Button";

export { Card } from "@/components/ui/Card";
export type { CardProps } from "@/components/ui/Card";

export { Checkbox } from "@/components/ui/Checkbox";

export { Modal } from "@/components/ui/Modal";
export type { ModalBackdropProps, ModalDialogProps, ModalProps } from "@/components/ui/Modal";

export { ToggleButton, ToggleButtonGroup } from "@/components/ui/ToggleButton";
export type {
  ToggleButtonGroupProps,
  ToggleButtonProps,
  ToggleButtonSize,
  ToggleButtonVariant,
} from "@/components/ui/ToggleButton";

export { Select } from "@/components/ui/Select";
export type { SelectOption, SelectProps, SelectSize } from "@/components/ui/Select";

export { Slider } from "@/components/ui/Slider";
export type { SliderProps } from "@/components/ui/Slider";

export { Switch } from "@/components/ui/Switch";
export type { SwitchProps } from "@/components/ui/Switch";

export { ScrollShadow } from "@/components/ui/ScrollShadow";

export { Tabs } from "@/components/ui/Tabs";
export type { TabsProps, TabsVariant } from "@/components/ui/Tabs";

export {
  isTone,
  TOGGLE_BLINK_ACCENT,
  toneClass,
  TONES,
  withTone,
} from "@/components/ui/tones";
export type { Tone } from "@/components/ui/tones";
export { KeyHint } from "@/components/ui/KeyHint";
export { CollapsibleInline } from "@/components/ui/CollapsibleInline";
export { Tooltip } from "@/components/ui/Tooltip";
export { Input } from "@/components/ui/Input";
export type { InputProps } from "@/components/ui/Input";
