// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { Popover, Tooltip } from "@heroui/react";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FontIcon } from "@/components/common/FontIcon";
import { ToggleButton, ToggleButtonGroup } from "@/components/ui";
import { builder } from "@/lib/state/api";
import {
  outputSendsToClickRows,
  sourceOutputBusId,
  type ClickSendRow,
  type WebUiState,
} from "@/lib/state/types";

/** Project-global metronome toggle and its independent output/send routing. */
export function PlayerClickControls({ state }: { state: WebUiState }) {
  const [metronomeOverride, setMetronomeOverride] = useState<boolean | null>(
    null,
  );
  const [clickSendsOpen, setClickSendsOpen] = useState(false);
  // Anchors the routing popover; see the note at its trigger.
  const clickRoutingAnchorRef = useRef<HTMLDivElement>(null);
  const hasSongs = state.songs.length > 0;
  // Project-global metronome (not per-song). Optimistic override until
  // state.click catches up from the WS snapshot.
  const isMetronomeOn = metronomeOverride ?? state.click?.enabled ?? false;
  useEffect(() => {
    if (metronomeOverride != null && state.click?.enabled === metronomeOverride)
      setMetronomeOverride(null);
  }, [state.click?.enabled, metronomeOverride]);

  const patchProjectClick = (partial: {
    click?: boolean;
    clickBusId?: string;
    clickSends?: ClickSendRow[];
  }) => {
    const idx = hasSongs ? (state.songIndex >= 0 ? state.songIndex : 0) : -1;
    const s = hasSongs ? state.songs[idx] : null;
    void builder.songUpdate({
      index: idx,
      name: s?.name ?? "",
      bpm: s?.bpm ?? 120,
      mode: s?.mode ?? "wait",
      tsNum: s?.tsNum ?? 4,
      tsDen: s?.tsDen ?? 4,
      click: partial.click ?? state.click?.enabled ?? false,
      // Preserve empty clickBusId (Sends Only) — never coerce "" → main.
      clickBusId:
        partial.clickBusId !== undefined
          ? partial.clickBusId
          : state.click
            ? sourceOutputBusId(state.click.output)
            : (s?.clickBusId ?? ""),
      clickSends: (
        partial.clickSends ??
        (state.click
          ? outputSendsToClickRows(state.click.output)
          : undefined) ??
        s?.clickSends ??
        []
      ).map((cs) => ({
        busId: cs.busId,
        level: cs.level,
        enabled: cs.enabled,
      })),
    });
  };

  const toggleMetronome = () => {
    const nextState = !isMetronomeOn;
    setMetronomeOverride(nextState);
    patchProjectClick({ click: nextState });
  };

  // Toggle a send on/off for the metronome (aux bus click routing)
  const toggleClickSend = (busId: string) => {
    const clickSends = state.click
      ? outputSendsToClickRows(state.click.output)
      : [];
    const existing = clickSends.find((cs) => cs.busId === busId);
    let newSends: ClickSendRow[];
    if (existing) {
      newSends = clickSends.map((cs) =>
        cs.busId === busId ? { ...cs, enabled: !cs.enabled } : cs,
      );
    } else {
      newSends = [...clickSends, { busId, level: 100, enabled: true }];
    }
    patchProjectClick({ clickSends: newSends });
  };

  // Empty string = Sends Only (must not fall back to main via falsy ||).
  const currentClickBus = state.click
    ? sourceOutputBusId(state.click.output)
    : "";
  const auxBusses = state.busses.filter((bus) => bus.isAux);
  const enabledClickSendIds = (
    state.click ? outputSendsToClickRows(state.click.output) : []
  )
    .filter((send) => send.enabled)
    .map((send) => send.busId);

  const changeClickBus = (busId: string) => {
    // busId may be "" for Sends Only. Project-global.
    patchProjectClick({ clickBusId: busId });
  };

  return (
    <>
      {/* Global metronome + its send routing. Two unrelated booleans, hence
              a multiple-selection group rather than an exclusive one: the click
              can be on with the routing panel shut, and vice versa.

              The routing panel is a real Popover: it renders in an overlay
              portal, so it is no longer clipped away by the transport card's
              own `overflow-hidden` (which is what kept it invisible), and it
              closes on an outside click or Escape instead of only on a second
              press of the chevron. `triggerRef` anchors it to the group --
              HeroUI's Popover normally takes its anchor from a Button child,
              and a ToggleButton is a different primitive that never registers
              itself as one. */}
      <Popover isOpen={clickSendsOpen} onOpenChange={setClickSendsOpen}>
        <div ref={clickRoutingAnchorRef}>
          <ToggleButtonGroup
            aria-label="Metronome"
            size="sm"
            selectionMode="multiple"
            selectedKeys={[
              ...(isMetronomeOn ? ["on"] : []),
              ...(clickSendsOpen ? ["routing"] : []),
            ]}
            onSelectionChange={(keys) => {
              const next = new Set(Array.from(keys, String));
              if (next.has("on") !== isMetronomeOn) toggleMetronome();
              setClickSendsOpen(next.has("routing"));
            }}
          >
            <ToggleButton id="on">
              <FontIcon name="metronome" size={16} />
              <span>Click</span>
            </ToggleButton>
            <Tooltip>
              <ToggleButton
                id="routing"
                isIconOnly
                aria-label="Click send routing"
              >
                <ToggleButtonGroup.Separator />
                <ChevronDown
                  size={12}
                  className={`transition-transform ${clickSendsOpen ? "rotate-180" : ""}`}
                />
              </ToggleButton>
              <Tooltip.Content>Click send routing</Tooltip.Content>
            </Tooltip>
          </ToggleButtonGroup>
        </div>
        {/* 1-to-1 track parity with Output Bus select + Aux Sends list */}
        <Popover.Content
          triggerRef={clickRoutingAnchorRef}
          placement="bottom end"
          className="w-64"
        >
          <Popover.Dialog className="space-y-3 select-none">
            <div className="flex items-center justify-between border-b border-default/20 pb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-foreground/50">
                Click Routing
              </span>
              <span className="text-[10px] font-mono text-accent">
                Metronome
              </span>
            </div>

            {/* Primary Destination Bus Select (1-to-1 like track output) */}
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-foreground/60">
                Output Bus
              </label>
              <select
                value={
                  currentClickBus === "" ? "__sends_only__" : currentClickBus
                }
                onChange={(e) =>
                  changeClickBus(
                    e.target.value === "__sends_only__" ? "" : e.target.value,
                  )
                }
                className="w-full rounded-md border border-default/40 bg-default/20 px-2 py-1 text-xs text-foreground focus:outline-none"
              >
                {state.busses.map((bus) => (
                  <option key={bus.id} value={bus.id}>
                    {bus.name || bus.id}
                  </option>
                ))}
                <option value="__sends_only__">Sends Only</option>
              </select>
            </div>

            {/* Aux Sends List (1-to-1 like track sends) */}
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-foreground/60">
                Aux Sends
              </div>
              {auxBusses.length === 0 ? (
                <div className="text-[10px] text-foreground/30 py-1">
                  No Aux buses
                </div>
              ) : (
                /* Independent on/off per bus -- a multiple-selection group,
                       detached so each send reads as its own row rather than a
                       segment of one bar. */
                <ToggleButtonGroup
                  aria-label="Aux sends"
                  orientation="vertical"
                  isDetached
                  fullWidth
                  size="sm"
                  selectionMode="multiple"
                  selectedKeys={enabledClickSendIds}
                  onSelectionChange={(keys) => {
                    const next = new Set(Array.from(keys, String));
                    for (const bus of auxBusses) {
                      if (
                        next.has(bus.id) !==
                        enabledClickSendIds.includes(bus.id)
                      )
                        toggleClickSend(bus.id);
                    }
                  }}
                >
                  {auxBusses.map((bus) => (
                    <ToggleButton key={bus.id} id={bus.id}>
                      <span className="truncate">{bus.name || bus.id}</span>
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              )}
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </>
  );
}
