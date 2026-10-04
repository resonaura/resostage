/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Input, Label, TextField } from "@heroui/react";
import { useEffect, useState } from "react";
import { Button, Modal } from "@/components/ui";
import { pluginChains, type PluginPresetEntry } from "@/lib/state/api";

export function PluginPresetDialog({
  open,
  stripId,
  slotId,
  pluginId,
  pluginName,
  onClose,
}: {
  open: boolean;
  stripId: string;
  slotId: string;
  pluginId: string;
  pluginName: string;
  onClose: () => void;
}) {
  const [presets, setPresets] = useState<PluginPresetEntry[]>([]);
  const [name, setName] = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !pluginId) return;
    let active = true;
    setLoadingList(true);
    setError("");
    void pluginChains.presets(pluginId).then((result) => {
      if (!active) return;
      if (result.error) setError(result.error);
      setPresets(result.presets);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not list presets");
    }).finally(() => {
      if (active) setLoadingList(false);
    });
    return () => { active = false; };
  }, [open, pluginId]);

  const encodedNameBytes = new TextEncoder().encode(name.trim()).length;
  const canSave = name.trim().length > 0 && encodedNameBytes <= 128
    && !saving && applyingId === null;

  const savePreset = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");
    const oldIds = new Set(presets.map((preset) => preset.id));
    try {
      await pluginChains.savePreset(stripId, slotId, name.trim());
      // Capture runs away from the UI thread and may wait for a plug-in host.
      // Poll only while this explicit operation is pending; never poll the
      // library continuously when the dialog is idle.
      for (let attempt = 0; attempt < 24; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const result = await pluginChains.presets(pluginId);
        if (result.error) throw new Error(result.error);
        const nextPresets = result.presets;
        setPresets(nextPresets);
        const saved = nextPresets.find((preset) => !oldIds.has(preset.id));
        if (saved) {
          setName("");
          return;
        }
      }
      setError("The Core did not publish the preset. Check its status message and try again only if no preset was created.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save plug-in preset");
    } finally {
      setSaving(false);
    }
  };

  const loadPreset = async (presetId: string) => {
    setApplyingId(presetId);
    setError("");
    try {
      await pluginChains.loadPreset(stripId, slotId, presetId);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not request preset load");
      setApplyingId(null);
    }
  };

  return (
    <Modal isOpen={open} onOpenChange={(next) => {
      if (!next && !saving && applyingId === null) onClose();
    }}>
      <Modal.Backdrop>
        <Modal.Container size="md" placement="center" scroll="inside">
          <Modal.Dialog aria-label={`Plug-in presets for ${pluginName}`}>
            <Modal.CloseTrigger isDisabled={saving || applyingId !== null} />
            <Modal.Header className="border-b border-default/20 pb-3">
              <div className="min-w-0">
                <Modal.Heading className="truncate text-sm font-semibold">
                  Presets · {pluginName}
                </Modal.Heading>
                <p className="mt-1 text-xs text-foreground/50">
                  Presets are stored on this device. Loading one is an undoable project edit.
                </p>
              </div>
            </Modal.Header>
            <Modal.Body className="space-y-4">
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => { event.preventDefault(); void savePreset(); }}
              >
                <TextField className="min-w-0 flex-1" name="plugin-preset-name" value={name} onChange={setName}>
                  <Label className="text-xs">Save current state as</Label>
                  <Input
                    maxLength={128}
                    placeholder="Preset name"
                    aria-label="Preset name"
                    disabled={saving || applyingId !== null}
                  />
                </TextField>
                <Button
                  type="submit"
                  size="sm"
                  isDisabled={!canSave}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </form>

              <section aria-label="Saved presets" className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
                    Presets
                  </h3>
                  <span className="text-[10px] text-foreground/40">{presets.length}</span>
                </div>
                {loadingList ? (
                  <p className="py-5 text-center text-xs text-foreground/45">Loading presets…</p>
                ) : presets.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-default/25 px-3 py-5 text-center text-xs text-foreground/45">
                    No saved presets for this plug-in yet.
                  </p>
                ) : (
                  <ul className="max-h-52 space-y-1 overflow-y-auto">
                    {presets.map((preset) => (
                      <li key={preset.id}>
                        <Button
                          variant="secondary"
                          size="sm"
                          fullWidth
                          isDisabled={saving || applyingId !== null}
                          onPress={() => void loadPreset(preset.id)}
                          className="justify-between"
                        >
                          <span className="truncate">{preset.name}</span>
                          <span className="ml-3 shrink-0 text-[10px] text-foreground/40">
                            {Math.max(1, Math.round(preset.stateBytes / 1024))} KB
                          </span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {error && <p role="alert" className="text-xs text-danger">{error}</p>}
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="secondary"
                isDisabled={saving || applyingId !== null}
                onPress={onClose}
              >
                Close
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
