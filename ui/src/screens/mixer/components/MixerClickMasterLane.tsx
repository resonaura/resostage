import type { PluginCatalogEntry } from "@/lib/state/api";
import { mixer } from "@/lib/state/api";
import {
  outputSendsToClickRows,
  type BusRow,
  type WebUiState,
} from "@/lib/state/types";
import { patchClickFields } from "@/screens/mixer/logic/mixerUtils";
import { BusStrip } from "@/screens/mixer/strips/BusStrip";
import { MetronomeStrip } from "@/screens/mixer/strips/MetronomeStrip";
import type { MixerDensity } from "@/screens/mixer/logic/constants";
import type { StripMenuTarget } from "@/screens/mixer/strips/StripContextMenu";

/** The fixed right-hand metronome and master strips of the mixer console. */
export function MixerClickMasterLane({
  state,
  density,
  targetPluginSlots,
  pluginCatalog,
  master,
  masterBusses,
  onDirectOutput,
  onOpenPlugins,
  onMenuTarget,
}: {
  state: WebUiState;
  density: MixerDensity;
  targetPluginSlots: number;
  pluginCatalog: PluginCatalogEntry[];
  master: BusRow | undefined;
  masterBusses: BusRow[];
  onDirectOutput: (startChannel: number, pair: boolean) => void;
  onOpenPlugins: (stripId: string, stripName: string) => void;
  onMenuTarget: (target: StripMenuTarget) => void;
}) {
  const clickSends = state.click
    ? outputSendsToClickRows(state.click.output)
    : [];

  return (
    <div className="flex h-full min-h-0 shrink-0 items-stretch gap-2">
      <div
        className="flex h-full min-h-0 shrink-0"
        onContextMenu={(event) => {
          event.preventDefault();
          onMenuTarget({
            kind: "click",
            x: event.clientX,
            y: event.clientY,
            name: state.click?.name?.trim() || "Click",
            onRename: (name) => patchClickFields(state, { clickName: name }),
            onResetGainPan: () =>
              patchClickFields(state, { clickGainDb: 0, clickPan: 0 }),
            onClearMuteSolo: () => {
              patchClickFields(state, { click: true });
              void mixer.setClickSolo(false);
            },
            hasSends: clickSends.length > 0,
            onRemoveAllSends: () => patchClickFields(state, { clickSends: [] }),
          });
        }}
      >
        <MetronomeStrip
          state={state}
          density={density}
          targetPluginSlots={targetPluginSlots}
          onDirectOutput={onDirectOutput}
          onOpenPlugins={onOpenPlugins}
          pluginCatalog={pluginCatalog}
        />
      </div>

      <div className="mx-1 w-px shrink-0 self-stretch bg-default/40" />

      {masterBusses.map((bus) => (
        <div
          key={bus.id}
          className="flex h-full min-h-0 shrink-0"
          onContextMenu={(event) => {
            event.preventDefault();
            onMenuTarget({
              kind: "master",
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
            anySoloInGroup={bus.soloActiveInGroup}
            isMaster
            pluginCatalog={pluginCatalog}
            density={density}
            targetPluginSlots={targetPluginSlots}
            onOpenPlugins={onOpenPlugins}
          />
        </div>
      ))}
    </div>
  );
}
