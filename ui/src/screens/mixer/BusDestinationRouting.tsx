import { useEffect, useState } from "react";
import { builder } from "../../lib/api";
import type { BusRow, SettingsState } from "../../lib/types";
import {
  EXT_OUTPUT_VALUE,
  ROUTING_SELECT_CLASS,
  ROUTING_SELECT_SPACER,
} from "./constants";
import {
  directOutputOptions,
  matchOptionId,
  parseOptionId,
} from "./directOutput";
import { MonoStereoIcon } from "./MonoStereoIcon";

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
  const isMaster = bus.id === "main";
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

  if (isMaster) {
    // Master always: [Ext. Out only] + [channel list]. Native option text
    // stays plain ("1/2", "3") — no "Out: " decoration.
    return (
      <div className="w-full my-1 flex flex-col items-center gap-1.5">
        <div className="w-full flex items-center justify-center my-0.5">
          <button
            type="button"
            className="flex items-center justify-center p-1 text-foreground/70 transition-colors hover:text-foreground mx-auto"
            title={
              stereo ? "Stereo (click for mono)" : "Mono (click for stereo)"
            }
            onClick={() => updateBusChannels(stereo ? 1 : 2, bus.startChannel)}
          >
            <MonoStereoIcon stereo={stereo} />
          </button>
        </div>

        <select
          value={EXT_OUTPUT_VALUE}
          onChange={() => {
            /* only one option */
          }}
          className={ROUTING_SELECT_CLASS}
          title="Master always routes to a physical Ext. Out"
        >
          <option value={EXT_OUTPUT_VALUE}>Ext. Out</option>
        </select>

        <select
          value={channelValue}
          onChange={(e) => {
            const parsed = parseOptionId(e.target.value);
            if (parsed)
              updateBusChannels(parsed.pair ? 2 : 1, parsed.startChannel);
          }}
          className={ROUTING_SELECT_CLASS}
          title="Master physical output"
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // Aux / send bus: Master | Ext. Out, then channel picker when Ext. Out.
  return (
    <div className="w-full my-1 flex flex-col items-center gap-1.5">
      <div className="w-full flex items-center justify-center my-0.5">
        <button
          type="button"
          className="flex items-center justify-center p-1 text-foreground/70 transition-colors hover:text-foreground mx-auto"
          title={stereo ? "Stereo (click for mono)" : "Mono (click for stereo)"}
          onClick={() => updateBusChannels(stereo ? 1 : 2, bus.startChannel)}
        >
          <MonoStereoIcon stereo={stereo} />
        </button>
      </div>

      <select
        value={extOutputOpen ? EXT_OUTPUT_VALUE : "master"}
        onChange={(e) => {
          if (e.target.value === EXT_OUTPUT_VALUE) {
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
        className={ROUTING_SELECT_CLASS}
        title="Where this bus goes (Master = same outs as master; both still sum)"
      >
        <option value="master">Master</option>
        <option value={EXT_OUTPUT_VALUE}>Ext. Out</option>
      </select>

      {extOutputOpen ? (
        <select
          value={channelValue}
          onChange={(e) => {
            const parsed = parseOptionId(e.target.value);
            if (parsed)
              updateBusChannels(parsed.pair ? 2 : 1, parsed.startChannel);
          }}
          className={ROUTING_SELECT_CLASS}
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <div className={ROUTING_SELECT_SPACER} aria-hidden />
      )}
    </div>
  );
}
