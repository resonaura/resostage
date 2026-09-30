import type { ReactNode } from "react";
import { Label } from "@heroui/react";
import { Card } from "@/components/ui";
import { CAPTION_CLS } from "@/screens/light/logic/lightStyles";

/** One bordered block of the Lighting panel. */
export function Section({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <Card.Content className="flex flex-col gap-3 p-4">
        {(title || action) && (
          <div className="flex items-center justify-between gap-2">
            {title ? <Label className={CAPTION_CLS}>{title}</Label> : <span />}
            {action}
          </div>
        )}
        {children}
      </Card.Content>
    </Card>
  );
}
