import type { ReactNode } from "react";
import { Card } from "../../../components/ui";

export function SettingsStat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg bg-default/30 p-3">
      <div className="text-[11px] uppercase tracking-wide text-foreground/50">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const labelClassName =
  "text-[11px] font-semibold uppercase tracking-wide text-foreground/50";

export function SettingsField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className={labelClassName}>{label}</span>
      {children}
    </div>
  );
}

// Keep settings cards visually consistent across tabs without repeating the
// HeroUI Card header/content structure at each call site.
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <Card.Header>
        <Card.Title>{title}</Card.Title>
        {description && (
          <p className="mt-0.5 text-xs text-foreground/50">{description}</p>
        )}
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">{children}</Card.Content>
    </Card>
  );
}
