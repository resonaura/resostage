import { useEffect, useState } from "react";
import type { BusRow, SettingsState } from "../../lib/types";
import {
  EXT_OUTPUT_VALUE,
  ROUTING_SELECT_CLASS,
  ROUTING_SELECT_SPACER,
  SENDS_ONLY_VALUE,
} from "./constants";
import {
  directOutputOptions,
  matchOptionId,
  parseOptionId,
} from "./directOutput";
import { MonoStereoIcon } from "./MonoStereoIcon";

export function TrackOutputRouting({
  busId,
  busses,
  allBusses,
  settings,
  mono = false,
  onMonoChange,
  onBusSelect,
  onDirectOutput,
}: {
  busId: string;
  /** Visible destinations: master + aux only. */
  busses: BusRow[];
  allBusses: BusRow[];
  settings: SettingsState;
  mono?: boolean;
  onMonoChange?: (mono: boolean) => void;
  onBusSelect: (id: string) => void;
  onDirectOutput: (mono: boolean, startChannel: number, pair: boolean) => void;
}) {
  const assigned = allBusses.find((b) => b.id === busId);
  const isExtAssigned = Boolean(
    assigned && assigned.id !== "main" && !assigned.isAux,
  );
  const [directOutputOpen, setDirectOutputOpen] = useState(isExtAssigned);

  useEffect(() => {
    setDirectOutputOpen(isExtAssigned);
  }, [isExtAssigned, busId]);

  // Mono strips list pairs + every single; stereo lists pairs + leftover singles.
  const options = directOutputOptions(settings, {
    includeAllSingles: mono,
  });
  const channelValue = matchOptionId(
    options,
    assigned?.startChannel ?? 0,
    assigned?.channels ?? 2,
  );

  const currentValue = directOutputOpen
    ? EXT_OUTPUT_VALUE
    : busId === ""
      ? SENDS_ONLY_VALUE
      : busses.some((b) => b.id === busId)
        ? busId
        : isExtAssigned
          ? EXT_OUTPUT_VALUE
          : "main";

  return (
    <div className="w-full my-1 flex flex-col items-center gap-1.5">
      {onMonoChange && (
        <div className="w-full flex items-center justify-center my-0.5">
          <button
            type="button"
            className="flex items-center justify-center p-1 text-foreground/70 transition-colors hover:text-foreground mx-auto"
            title={
              mono
                ? "Mono — click for stereo"
                : "Stereo — click for mono (sum L+R)"
            }
            onClick={() => onMonoChange(!mono)}
          >
            <MonoStereoIcon stereo={!mono} />
          </button>
        </div>
      )}

      <select
        value={currentValue}
        onChange={(e) => {
          if (e.target.value === EXT_OUTPUT_VALUE) {
            setDirectOutputOpen(true);
            if (options.length > 0) {
              const pick = options[0];
              onDirectOutput(mono, pick.startChannel, pick.pair);
            }
          } else {
            setDirectOutputOpen(false);
            onBusSelect(
              e.target.value === SENDS_ONLY_VALUE ? "" : e.target.value,
            );
          }
        }}
        className={ROUTING_SELECT_CLASS}
      >
        {busses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name || b.id}
          </option>
        ))}
        <option value={SENDS_ONLY_VALUE}>Sends Only</option>
        <option value={EXT_OUTPUT_VALUE}>Ext. Out</option>
      </select>

      {directOutputOpen ? (
        <select
          value={channelValue}
          onChange={(e) => {
            const parsed = parseOptionId(e.target.value);
            if (parsed) onDirectOutput(mono, parsed.startChannel, parsed.pair);
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
