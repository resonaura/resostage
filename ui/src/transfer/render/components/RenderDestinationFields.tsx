/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useId } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui";
import { Field, inputClass, Section } from "@/transfer/render/components/RenderFields";

/** Uses the render dialog's field styling without exposing local OS paths remotely. */
export function RenderDestinationFields({ directory, canBrowse, choosing, error, disabled,
  onChange, onBrowse }: {
  directory: string;
  canBrowse: boolean;
  choosing: boolean;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
  onBrowse: () => Promise<void>;
}) {
  const helpId = useId();
  return (
    <Section title="Destination">
      <div className="flex min-w-0 items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label={canBrowse ? "Output folder" : "Output folder on Core"}>
            <input value={directory} onChange={(event) => onChange(event.target.value)}
              disabled={disabled || choosing} aria-describedby={helpId}
              placeholder="Standard Exports folder" className={inputClass} />
          </Field>
        </div>
        {canBrowse && <Button size="sm" variant="outline" isDisabled={disabled || choosing}
          isPending={choosing} onPress={() => void onBrowse()}>
          <FolderOpen size={14} /> Browse
        </Button>}
      </div>
      <div className="flex items-start justify-between gap-3">
        <p id={helpId} className="text-[10px] text-foreground/45">
          {canBrowse ? "Choose a folder or enter its absolute path. " : "Enter an absolute folder path on the Core computer. "}
          Leave blank to use the standard Exports folder. The last accepted folder is remembered on Core.
        </p>
        {directory && <Button size="sm" variant="ghost" className="shrink-0"
          isDisabled={disabled || choosing} onPress={() => onChange("")}>Use default</Button>}
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </Section>
  );
}
