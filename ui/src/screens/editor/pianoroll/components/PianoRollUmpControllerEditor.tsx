/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { MidiUmpEventRow } from "@/lib/state/types";
import { Button, Input, Modal } from "@/components/ui";
import {
  applyPianoRollUmpControllerDraft,
  copyPianoRollUmpEvents,
  createPianoRollUmpControllerDraftRow,
  readPianoRollUmpControllerDraft,
  sameEditablePianoRollUmpEvents,
  validatePianoRollUmpControllerDraft,
  type PianoRollUmpControllerDraftRow,
  type PianoRollUmpControllerKind,
} from "@/screens/editor/pianoroll/logic/umpControllerEditing";

interface PianoRollUmpControllerEditorProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  events: MidiUmpEventRow[];
  defaultBeat: number;
  onSave: (events: MidiUmpEventRow[]) => void;
}

function NumericField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[10px] font-medium text-foreground/55">
      <span className="truncate">{label}</span>
      <Input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? String(value) : ""}
        onChange={(event) => onChange(event.currentTarget.value === ""
          ? Number.NaN : Number(event.currentTarget.value))}
        className="h-8 min-w-0 px-2 text-xs tabular-nums"
      />
    </label>
  );
}

function eventKindLabel(row: PianoRollUmpControllerDraftRow): string {
  return row.kind === "cc" ? `CC ${row.controller}` : "Pitch Bend";
}

/** Bounded semantic editor; it never exposes opaque UMP words as editable hex. */
export function PianoRollUmpControllerEditor({
  isOpen,
  onOpenChange,
  events,
  defaultBeat,
  onSave,
}: PianoRollUmpControllerEditorProps) {
  const [baseEvents, setBaseEvents] = useState<MidiUmpEventRow[] | null>(null);
  const [rows, setRows] = useState<PianoRollUmpControllerDraftRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(0);
  const wasOpen = useRef(false);
  const sourceEvents = events;
  const sourceChanged = isOpen && baseEvents !== null
    && !sameEditablePianoRollUmpEvents(baseEvents, sourceEvents);
  const opaqueCount = Math.max(0, events.length - readPianoRollUmpControllerDraft(events).length);

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      const snapshot = copyPianoRollUmpEvents(sourceEvents);
      setBaseEvents(snapshot);
      setRows(readPianoRollUmpControllerDraft(snapshot));
      setError(null);
    }
    wasOpen.current = isOpen;
  }, [events, isOpen, sourceEvents]);

  const syncToLatest = () => {
    const snapshot = copyPianoRollUmpEvents(sourceEvents);
    setBaseEvents(snapshot);
    setRows(readPianoRollUmpControllerDraft(snapshot));
    setError(null);
  };

  const reloadLatest = () => {
    syncToLatest();
  };

  const addEvent = (kind: PianoRollUmpControllerKind) => {
    const defaults = rows[0];
    const row = createPianoRollUmpControllerDraftRow(
      `new-${++nextId.current}`,
      kind,
      defaultBeat,
      { group: defaults?.group ?? 0, channel: defaults?.channel ?? 0 },
    );
    setRows((current) => [...current, row]);
    setError(null);
  };

  const updateRow = (id: string, patch: Partial<PianoRollUmpControllerDraftRow>) => {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
    setError(null);
  };

  const save = () => {
    if (!baseEvents) return;
    if (sourceChanged) {
      setError("The region changed while this editor was open. Reload the latest events before saving.");
      return;
    }
    const validationError = validatePianoRollUmpControllerDraft(baseEvents, rows);
    if (validationError) {
      setError(validationError);
      return;
    }
    const updated = applyPianoRollUmpControllerDraft(baseEvents, rows);
    if (!updated) {
      setError("The MIDI 2.0 edit could not be prepared safely.");
      return;
    }
    onSave(updated);
    onOpenChange(false);
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && onOpenChange(false)}>
        <Modal.Backdrop>
          <Modal.Container size="3xl" placement="center" scroll="inside">
            <Modal.Dialog aria-label="MIDI 2.0 controller events">
              <Modal.CloseTrigger />
              <Modal.Header className="border-b border-default/20 px-5 py-3">
                <Modal.Heading className="text-sm font-semibold">
                  MIDI 2.0 Controller Events
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="space-y-3 px-5 py-4">
                <p className="text-xs leading-relaxed text-foreground/60">
                  Edit standard Channel Voice CC and Pitch Bend packets. Beat is in the
                  region&apos;s source timeline; value is the exact unsigned 32-bit data word.
                  Unsupported and reserved packets remain unchanged.
                </p>
                {sourceChanged && (
                  <div role="alert" className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                    <span className="min-w-0 flex-1">The region changed while this editor was open.</span>
                    <Button size="sm" variant="secondary" onPress={reloadLatest}>Reload latest</Button>
                  </div>
                )}
                {error && <p role="alert" className="text-xs text-danger">{error}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" onPress={() => addEvent("cc")}>
                    <Plus size={13} /> Add CC
                  </Button>
                  <Button size="sm" variant="secondary" onPress={() => addEvent("pitchBend")}>
                    <Plus size={13} /> Add Pitch Bend
                  </Button>
                  <span className="ml-auto text-[10px] text-foreground/45">
                    {rows.length} editable · {opaqueCount} preserved opaque/reserved
                  </span>
                </div>
                {rows.length === 0 ? (
                  <div className="rounded-md border border-default/20 bg-background-secondary px-4 py-6 text-center text-xs text-foreground/50">
                    No supported MIDI 2.0 controller packets in this region yet.
                  </div>
                ) : (
                  <div className="max-h-[min(55vh,34rem)] space-y-2 overflow-auto pr-1">
                    {rows.map((row) => (
                      <section key={row.id} className="rounded-md border border-default/20 bg-background-secondary p-2.5">
                        <div className="mb-2 flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground/80">
                            {eventKindLabel(row)}{row.sourceIndex === null ? " · New" : ` · #${row.sourceIndex + 1}`}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            isIconOnly
                            aria-label={`Delete ${eventKindLabel(row)}`}
                            onPress={() => {
                              setRows((current) => current.filter((candidate) => candidate.id !== row.id));
                              setError(null);
                            }}
                          >
                            <Trash2 size={13} />
                          </Button>
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                          <NumericField label="Source beat" value={row.beat} min={0} max={1_000_000} step={0.001}
                            onChange={(beat) => updateRow(row.id, { beat })} />
                          <NumericField label="Group" value={row.group} min={0} max={15}
                            onChange={(group) => updateRow(row.id, { group })} />
                          <NumericField label="Channel (0–15)" value={row.channel} min={0} max={15}
                            onChange={(channel) => updateRow(row.id, { channel })} />
                          {row.kind === "cc" && (
                            <NumericField label="CC number" value={row.controller} min={0} max={127}
                              onChange={(controller) => updateRow(row.id, { controller })} />
                          )}
                          <NumericField label="32-bit value" value={row.value} min={0} max={0xffff_ffff}
                            onChange={(value) => updateRow(row.id, { value })} />
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </Modal.Body>
              <Modal.Footer className="flex justify-end gap-2 border-t border-default/20 px-5 py-3">
                <Button size="sm" variant="ghost" onPress={() => onOpenChange(false)}>Cancel</Button>
                <Button size="sm" variant="primary" isDisabled={sourceChanged} onPress={save}>Save MIDI 2.0 events</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
    </Modal>
  );
}
