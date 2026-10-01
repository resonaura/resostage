/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { ArrowLeftRight, Power, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";

export function PluginSlotControl({
  name,
  bypassed,
  onOpen,
  onToggle,
  onSwap,
  onDelete,
  onContextMenu,
  title,
}: {
  name: string;
  bypassed: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onSwap: (event: MouseEvent<HTMLButtonElement>) => void;
  onDelete?: (event: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  title?: string;
}) {
  return (
    <div
      className={`group/plugin-slot relative flex h-5.5 w-full min-w-0 items-center overflow-hidden rounded border text-[8px] font-semibold transition-colors ${
        bypassed
          ? "border-default/25 bg-default/10 text-foreground/40"
          : "border-foreground/55 bg-foreground/12 text-foreground"
      }`}
      title={title ?? name}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        title={bypassed ? `Enable ${name}` : `Disable ${name}`}
        aria-label={bypassed ? `Enable ${name}` : `Disable ${name}`}
        className={`z-10 flex h-full w-5 shrink-0 items-center justify-center border-r border-default/25 transition-colors hover:bg-foreground/10 ${
          bypassed ? "text-muted" : "text-foreground"
        }`}
      >
        <Power size={10} strokeWidth={2.5} />
      </button>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        title={`Open ${name} editor`}
        aria-label={`Open ${name} editor`}
        className="h-full min-w-0 flex-1 truncate px-0.5 text-left transition-opacity duration-150 group-hover/plugin-slot:opacity-0 group-focus-within/plugin-slot:opacity-0"
      >
        {name}
      </button>

      <span className="pointer-events-none absolute inset-y-0 left-5 right-0 flex items-center justify-center text-[8px] font-semibold text-foreground/65 opacity-0 transition-opacity duration-150 group-hover/plugin-slot:opacity-100 group-focus-within/plugin-slot:opacity-100">
        Open
      </span>

      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center gap-0.5 pr-0.5 opacity-0 transition-opacity duration-150 group-hover/plugin-slot:pointer-events-auto group-hover/plugin-slot:opacity-100 group-focus-within/plugin-slot:pointer-events-auto group-focus-within/plugin-slot:opacity-100">
        <button
          type="button"
          onClick={onSwap}
          title={`Swap ${name}`}
          aria-label={`Swap ${name}`}
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-foreground/65 transition-colors hover:bg-foreground/15 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          <ArrowLeftRight size={9} strokeWidth={2.4} />
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title={`Delete ${name}`}
            aria-label={`Delete ${name}`}
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-foreground/65 transition-colors hover:bg-danger/20 hover:text-danger focus-visible:outline focus-visible:outline-1 focus-visible:outline-danger"
          >
            <Trash2 size={9} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  );
}
