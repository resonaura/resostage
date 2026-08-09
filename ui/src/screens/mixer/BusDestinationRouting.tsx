import { useEffect, useState } from "react";
import { isMainBusId } from "./mixerIds";
import { builder } from "../../lib/api";
import { Select, type SelectOption } from "../../components/ui";
import type { BusRow, SettingsState } from "../../lib/types";
import {
  EXT_OUTPUT_VALUE,
  ROUTING_SELECT_SIZE,
  ROUTING_SELECT_SPACER,
} from "./constants";
import {
  directOutputOptions,
  matchOptionId,
  parseOptionId,
  channelAvailable,
} from "./directOutput";
import { MonoStereoIcon } from "./MonoStereoIcon";
import { missingOutputSelectProps } from "./MissingOutputSelect";
import {
  missingRouteLabel,
  missingRouteOptionId,
} from "./missingOutputUtils";

export function BusDestinationRouting({
  bus,
  index,
  master,
  settings,
}: {
  bus: BusRow;
  index: number;
  master: BusRow | undefined;
  settings: SettingsState;
}) {
  const isMaster = isMainBusId(bus.id);
  const stereo = bus.channels === 2;
  // Master / aux mono toggle: show all singles when mono.
  const options = directOutputOptions(settings, {
    includeAllSingles: !stereo,
  });

  const updateBusChannels = (channels: number, startChannel: number) => {
    void builder.busUpdate({
      index,
      name: bus.name,
      channels,
      startChannel,
      gainDb: bus.gainDb,
      pan: bus.pan,
      mute: bus.mute,
      solo: bus.solo,
      isAux: bus.isAux,
    });
  };

  const isFollowingMaster = Boolean(
    master &&
    bus.channels === master.channels &&
    bus.startChannel === master.startChannel,
  );
  const [extOutputOpen, setExtOutputOpen] = useState(
    isMaster ? true : !isFollowingMaster,
  );

  useEffect(() => {
    if (isMaster) setExtOutputOpen(true);
  }, [isMaster]);

  const channelValue = matchOptionId(options, bus.startChannel, bus.channels);
  // The bus's physical output isn't reachable on this device right now: keep
  // the select on the ACTUAL (missing) pick via a dedicated option + a warning
  // icon to its left, instead of silently snapping to some available output.
  const missing = !channelAvailable(settings, bus.startChannel, bus.channels);
  const missingId = missing
    ? missingRouteOptionId(bus.startChannel, bus.channels)
    : null;
  const shownChannelValue =
    missing && missingId ? missingId : (channelValue ?? "");

  // Option text stays plain ("1/2", "3") — no "Out: " decoration.
  const channelOptions: SelectOption[] = options.map((o) => ({
    id: o.id,
    label: o.label,
  }));
  if (missing && missingId)
    channelOptions.push({
      id: missingId,
      label: missingRouteLabel(bus.startChannel, bus.channels),
      section: "Unavailable",
    });

  const channelSelect = (title: string) => (
    <Select
      aria-label={title}
      title={title}
      size={ROUTING_SELECT_SIZE}
      options={channelOptions}
      value={shownChannelValue}
      onChange={(id) => {
        const parsed = parseOptionId(id);
        if (parsed) updateBusChannels(parsed.pair ? 2 : 1, parsed.startChannel);
      }}
      {...missingOutputSelectProps(missing)}
    />
  );

  const monoStereoToggle = (
    <button
      type="button"
      className="mx-auto flex items-center justify-center rounded-md p-1 text-foreground/60 transition-colors hover:bg-default/40 hover:text-foreground"
      title={stereo ? "Stereo (click for mono)" : "Mono (click for stereo)"}
      onClick={() => updateBusChannels(stereo ? 1 : 2, bus.startChannel)}
    >
      <MonoStereoIcon stereo={stereo} />
    </button>
  );

  if (isMaster) {
    // Master always: [Ext. Out only] + [channel list].
    return (
      <div className="my-1 flex w-full flex-col items-center gap-1.5">
        <div className="my-0.5 flex w-full items-center justify-center">
          {monoStereoToggle}
        </div>

        <Select
          aria-label="Master destination"
          title="Master always routes to a physical Ext. Out"
          size={ROUTING_SELECT_SIZE}
          options={[{ id: EXT_OUTPUT_VALUE, label: "Ext. Out" }]}
          value={EXT_OUTPUT_VALUE}
          isDisabled
        />

        {channelSelect("Master physical output")}
      </div>
    );
  }

  // Aux / send bus: Master | Ext. Out, then channel picker when Ext. Out.
  return (
    <div className="my-1 flex w-full flex-col items-center gap-1.5">
      <div className="my-0.5 flex w-full items-center justify-center">
        {monoStereoToggle}
      </div>

      <Select
        aria-label="Bus destination"
        title="Where this bus goes (Main = same outs as the Main bus; both still sum)"
        size={ROUTING_SELECT_SIZE}
        options={[
          { id: "master", label: "Main" },
          { id: EXT_OUTPUT_VALUE, label: "Ext. Out" },
        ]}
        value={extOutputOpen ? EXT_OUTPUT_VALUE : "master"}
        onChange={(v) => {
          if (v === EXT_OUTPUT_VALUE) {
            setExtOutputOpen(true);
            if (options.length > 0) {
              const free = master
                ? options.find((o) => o.startChannel !== master.startChannel)
                : undefined;
              const pick = free ?? options[0];
              updateBusChannels(pick.pair ? 2 : 1, pick.startChannel);
            }
          } else {
            setExtOutputOpen(false);
            if (master)
              updateBusChannels(
                master.channels >= 2 ? 2 : 1,
                master.startChannel,
              );
          }
        }}
      />

      {extOutputOpen ? (
        channelSelect("Bus physical output")
      ) : (
        <div className={ROUTING_SELECT_SPACER} aria-hidden />
      )}
    </div>
  );
}
