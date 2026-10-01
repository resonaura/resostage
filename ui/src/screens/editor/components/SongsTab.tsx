// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

// Song-list and song-settings UI used by the Editor's Songs tab.
// The parent owns tab visibility and selection; SongEditor keeps its draft
// values local until the user applies them through the existing builder API.

import { ScrollShadow } from "@heroui/react";
import { ChevronDown, ChevronUp, Plus, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { Button, Card } from "@/components/ui";
import { builder } from "@/lib/state/api";
import type { SongRow } from "@/lib/state/types";

const inputCls =
  "w-full rounded-lg border border-default/60 bg-default/20 px-2 py-1.5 text-sm outline-none focus:border-accent";
const labelCls =
  "text-[11px] font-semibold uppercase tracking-wide text-foreground/50";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  );
}

function ToggleRow({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <Button
          key={o.value}
          size="sm"
          variant={value === o.value ? "secondary" : "outline"}
          onPress={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

export function ListPanel({
  title,
  rows,
  selected,
  onSelect,
  onAdd,
  onRemove,
  onMove,
  onImport,
  empty,
}: {
  title: string;
  rows: { key: string; label: string; sub?: string; active?: boolean }[];
  selected: number;
  onSelect: (i: number) => void;
  onAdd: () => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
  onImport?: () => void;
  /** Shown in place of the list when there is nothing in it. */
  empty: React.ReactNode;
}) {
  return (
    <Card className="flex h-full min-h-0 w-full shrink-0 flex-col md:w-[40%]">
      <Card.Header className="flex flex-row items-center justify-between shrink-0">
        <Card.Title className="text-sm">{title}</Card.Title>
        <div className="flex gap-1">
          {onImport && (
            <Button
              size="sm"
              variant="outline"
              aria-label="Import Song Folder…"
              onPress={onImport}
            >
              <Upload size={14} className="mr-1" />
              Import…
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            aria-label="Add"
            onPress={onAdd}
          >
            <Plus size={14} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            aria-label="Remove"
            isDisabled={selected < 0}
            onPress={onRemove}
          >
            <Trash2 size={14} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            aria-label="Move up"
            isDisabled={selected <= 0}
            onPress={() => onMove(-1)}
          >
            <ChevronUp size={14} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            isIconOnly
            aria-label="Move down"
            isDisabled={selected < 0 || selected >= rows.length - 1}
            onPress={() => onMove(1)}
          >
            <ChevronDown size={14} />
          </Button>
        </div>
      </Card.Header>
      <Card.Content className="flex min-h-0 flex-1 flex-col p-0">
        <ScrollShadow
          orientation="vertical"
          className="flex min-h-0 flex-1 flex-col gap-0.5 p-2"
        >
          {rows.length === 0
            ? empty
            : rows.map((r, i) => (
                <button
                  key={r.key}
                  onClick={() => onSelect(i)}
                  className={`flex flex-col items-start rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    i === selected
                      ? "tint--soft text-foreground"
                      : "text-foreground/70 hover:bg-default/20"
                  }`}
                >
                  <span>
                    {r.active ? "▶ " : ""}
                    {r.label}
                  </span>
                  {r.sub && (
                    <span className="text-xs text-foreground/40">{r.sub}</span>
                  )}
                </button>
              ))}
        </ScrollShadow>
      </Card.Content>
    </Card>
  );
}

export function EmptyDetailPanel({ hasRows }: { hasRows: boolean }) {
  return (
    <Card className="flex h-full min-h-0 flex-1 items-center justify-center border border-default/30 bg-surface/60 p-6 text-center text-sm text-foreground/40">
      {hasRows
        ? "Select an item from the sidebar to view and edit details."
        : "Add a song on the left and its details show up here."}
    </Card>
  );
}

// ─── Songs ─────────────────────────────────────────────────────────────────

export function SongEditor({ song, index }: { song: SongRow; index: number }) {
  const [name, setName] = useState(song.name);
  const [bpm, setBpm] = useState(song.bpm);
  const [mode, setMode] = useState<"auto" | "wait">(song.mode);
  const [tsNum, setTsNum] = useState(song.tsNum);
  const [tsDen, setTsDen] = useState(song.tsDen);

  return (
    <Card className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <Card.Header className="shrink-0">
        <Card.Title className="text-sm">Song {index + 1}</Card.Title>
      </Card.Header>
      <Card.Content className="flex min-h-0 flex-1 flex-col p-0">
        <ScrollShadow
          orientation="vertical"
          className="flex min-h-0 flex-1 flex-col gap-3 p-4"
        >
          <Field label="Name">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="BPM">
            <input
              type="number"
              step={0.1}
              className={inputCls}
              value={bpm}
              onChange={(e) => setBpm(Number(e.target.value))}
            />
          </Field>
          <Field label="End mode">
            <ToggleRow
              options={[
                { value: "wait", label: "Wait for trigger" },
                { value: "auto", label: "Autoplay next" },
              ]}
              value={mode}
              onChange={(v) => setMode(v as "auto" | "wait")}
            />
          </Field>
          <Field label="Time signature">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={32}
                className={inputCls}
                value={tsNum}
                onChange={(e) => setTsNum(Number(e.target.value))}
              />
              <span className="text-foreground/40">/</span>
              <input
                type="number"
                min={1}
                max={32}
                className={inputCls}
                value={tsDen}
                onChange={(e) => setTsDen(Number(e.target.value))}
              />
            </div>
          </Field>

          <Button
            className="mt-2"
            onPress={() =>
              void builder.songUpdate({
                index,
                name,
                bpm,
                mode,
                tsNum,
                tsDen,
                click: song.click,
                clickBusId: song.clickBusId,
                clickSends: song.clickSends ?? [],
              })
            }
          >
            Apply song settings
          </Button>
        </ScrollShadow>
      </Card.Content>
    </Card>
  );
}

