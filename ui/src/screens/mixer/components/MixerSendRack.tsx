/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { Plus } from "lucide-react";
import type { RefObject } from "react";
import type { PluginCatalogEntry } from "@/lib/state/api";
import type { BusRow, WebUiState } from "@/lib/state/types";
import { Button } from "@/components/ui";
import { ConsolePane } from "@/screens/mixer/components/ConsolePane";
import type { WindowResult } from "@/screens/mixer/logic/horizontalWindow";
import { BusStrip } from "@/screens/mixer/strips/BusStrip";
import type { MixerDensity } from "@/screens/mixer/logic/constants";
import type { StripMenuTarget } from "@/screens/mixer/strips/StripContextMenu";

type SendRackState = Pick<WebUiState, "busses" | "meters" | "settings">;

/** The aux/send bus strips and their add-send slot in the mixer. */
export function MixerSendRack({
  state,
  compact,
  density,
  auxBusses,
  master,
  anySoloInGroup,
  pluginCatalog,
  targetPluginSlots,
  contentRef,
  visibleWindow,
  onAddSend,
  onOpenPlugins,
  onShowSignalFlow,
  signalFlowOpenId,
  onMenuTarget,
}: {
  state: SendRackState;
  compact: boolean;
  density: MixerDensity;
  auxBusses: BusRow[];
  master: BusRow | undefined;
  anySoloInGroup: boolean;
  pluginCatalog: PluginCatalogEntry[];
  targetPluginSlots: number;
  contentRef: RefObject<HTMLDivElement | null>;
  visibleWindow: WindowResult;
  onAddSend: () => void;
  onOpenPlugins: (stripId: string, stripName: string) => void;
  onShowSignalFlow: (stripId: string, stripName: string) => void;
  signalFlowOpenId: string | null;
  onMenuTarget: (target: StripMenuTarget) => void;
}) {
  const stripWidth =
    density === "narrow" ? "w-16" : density === "wide" ? "w-28" : "w-20";

  return (
    <ConsolePane
      compact={compact}
      className={`flex shrink-0 ${compact ? "" : "max-w-[35%]"}`}
    >
      <div
        className={`mr-2 flex h-full ${stripWidth} shrink-0 flex-col items-center justify-center`}
      >
        {/* Dashed and full-height on purpose -- it stands where a
            strip would, so it reads as a slot to fill rather than as
            a control in the row. */}
        <Button
          variant="default-soft"
          aria-label="Add a new return/send bus"
          onPress={onAddSend}
          className={`h-full ${stripWidth} shrink-0 flex-col bg-background-secondary hover:bg-background-tertiary/50 transition-all gap-0 rounded-xl border border-dashed border-default/40 text-foreground/60`}
        >
          <Plus size={22} />
          <span className="text-[11px] font-semibold">Send</span>
        </Button>
      </div>

      {/* See the track pane above for what the spacers are doing. */}
      <div
        ref={contentRef}
        className="h-full shrink-0"
        style={{ width: visibleWindow.padStartPx }}
        aria-hidden
      />
      {auxBusses.slice(visibleWindow.start, visibleWindow.end).map((bus) => (
        <div
          key={bus.id}
          className="mr-2 flex h-full min-h-0 shrink-0"
          onContextMenu={(event) => {
            event.preventDefault();
            onMenuTarget({
              kind: "send",
              x: event.clientX,
              y: event.clientY,
              index: state.busses.indexOf(bus),
              bus,
            });
          }}
        >
          <BusStrip
            b={bus}
            index={state.busses.indexOf(bus)}
            meters={state.meters}
            master={master}
            settings={state.settings}
            anySoloInGroup={anySoloInGroup}
            pluginCatalog={pluginCatalog}
            density={density}
            targetPluginSlots={targetPluginSlots}
            onOpenPlugins={onOpenPlugins}
            onShowSignalFlow={onShowSignalFlow}
            signalFlowOpenId={signalFlowOpenId}
          />
        </div>
      ))}
      <div
        className="h-full shrink-0"
        style={{ width: visibleWindow.padEndPx }}
        aria-hidden
      />
    </ConsolePane>
  );
}
