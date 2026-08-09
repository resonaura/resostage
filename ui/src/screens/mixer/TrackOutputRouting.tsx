import { useEffect, useRef, useState } from "react";
import { isMainBusId } from "./mixerIds";
import { Select, type SelectOption } from "../../components/ui";
import type { BusRow, SettingsState } from "../../lib/types";
import {
  EXT_OUTPUT_VALUE,
  ROUTING_SELECT_SIZE,
  ROUTING_SELECT_SPACER,
  SENDS_ONLY_VALUE,
} from "./constants";
import {
  directOutputOptions,
  matchOptionId,
  parseOptionId,
  parseDirectLanes,
  routeToOptionId,
  channelAvailable,
} from "./directOutput";
import { MonoStereoIcon } from "./MonoStereoIcon";
import { missingOutputSelectProps } from "./MissingOutputSelect";

type PendingRouting = {
  /** Primary select: bus id, SENDS_ONLY_VALUE, or EXT_OUTPUT_VALUE. */
  primary: string;
  /** Secondary channel option id when primary is Ext. Out. */
  channelId?: string;
};

function serverPrimary(
  busId: string,
  destinationBusses: BusRow[],
  isExtAssigned: boolean,
): string {
  if (busId === "") return SENDS_ONLY_VALUE;
  if (destinationBusses.some((b) => b.id === busId)) return busId;
  if (isExtAssigned) return EXT_OUTPUT_VALUE;
  return (
    destinationBusses.find((b) => isMainBusId(b.id))
      ?.id ?? SENDS_ONLY_VALUE
  );
}

function serverMatchesPending(
  pending: PendingRouting,
  primaryValue: string,
  serverChannelId: string,
): boolean {
  if (pending.primary !== primaryValue) return false;
  if (pending.primary !== EXT_OUTPUT_VALUE) return true;
  return !pending.channelId || pending.channelId === serverChannelId;
}

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
  // A direct route is banked by its id(s): one mono lane "audio::out:N" or a
  // compound of two ("audio::out:1,audio::out:2"). Detect from the id so we never
  // rely on a fabricated "stereo pair bus" (which no longer exists).
  const directLanes = parseDirectLanes(busId);
  const isExtAssigned = directLanes !== null;
  const extTarget =
    directLanes && directLanes.length > 0 ? routeToOptionId(busId) : null;

  // Mono strips list pairs + every single; stereo lists pairs + leftover singles.
  const options = directOutputOptions(settings, {
    includeAllSingles: mono,
  });

  const serverChannelId = isExtAssigned && extTarget
    ? matchOptionId(options, extTarget.startChannel, extTarget.pair ? 2 : 1)
    : matchOptionId(options, assigned?.startChannel ?? 0, assigned?.channels ?? 2);
  const serverPrimaryValue = serverPrimary(busId, busses, isExtAssigned);

  // Outputs the track is actually routed to that aren't reachable on this
  // device. A direct route is missing when ANY of its mono lanes is.
  const missing = isExtAssigned && directLanes
    ? directLanes.some((n) => !channelAvailable(settings, n - 1, 1))
    : Boolean(
        assigned?.isDirectOut &&
          !channelAvailable(settings, assigned.startChannel, assigned.channels),
      );
  const firstLane = directLanes && directLanes.length > 0 ? directLanes[0] : undefined;
  const missingOptionId = missing && firstLane != null
    ? `u:${firstLane}` : undefined;
  const missingLabel =
    isExtAssigned && directLanes && directLanes.length > 0
      ? directLanes.join("/")
      : (assigned?.name ?? undefined);

  // Optimistic UI: keep the user's pick until the WS state catches up.
  // Without this the metronome (and any Ext. Out strip) flickers — selecting
  // Ext. Out / a channel fires an async bus create + clickBusId patch, and
  // until that lands `isExtAssigned` is still false so the controlled
  // <select> snaps back to Main.
  const [pending, setPending] = useState<PendingRouting | null>(null);
  const pendingGen = useRef(0);

  useEffect(() => {
    if (!pending) return;
    if (
      serverMatchesPending(pending, serverPrimaryValue, serverChannelId)
    ) {
      setPending(null);
    }
  }, [pending, serverPrimaryValue, serverChannelId]);

  // Drop stale pending if mono flip rebuilds the option list and the old
  // channel id no longer exists (avoid a stuck optimistic value).
  useEffect(() => {
    if (!pending?.channelId) return;
    if (!options.some((o) => o.id === pending.channelId)) {
      setPending((p) =>
        p ? { ...p, channelId: options[0]?.id ?? serverChannelId } : null,
      );
    }
  }, [mono]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentValue = pending?.primary ?? serverPrimaryValue;
  const directOutputOpen = currentValue === EXT_OUTPUT_VALUE;
  const channelValue =
    missing && missingOptionId
      ? missingOptionId
      : (pending?.channelId ?? serverChannelId);

  const commitPending = (next: PendingRouting) => {
    pendingGen.current += 1;
    setPending(next);
  };

  const destinationOptions: SelectOption[] = [
    ...busses.map((b) => ({ id: b.id, label: b.name || b.id })),
    { id: SENDS_ONLY_VALUE, label: "Sends Only" },
    { id: EXT_OUTPUT_VALUE, label: "Ext. Out" },
  ];

  // The unreachable lane is offered as its own option under a heading, so the
  // list still shows exactly what the track targets without implying it is a
  // usable pick alongside the real ones.
  const channelOptions: SelectOption[] = options.map((o) => ({
    id: o.id,
    label: o.label,
  }));
  if (missing && missingOptionId && missingLabel)
    channelOptions.push({
      id: missingOptionId,
      label: missingLabel,
      section: "Unavailable",
    });

  return (
    <div className="my-1 flex w-full flex-col items-center gap-1.5">
      {onMonoChange && (
        <div className="my-0.5 flex w-full items-center justify-center">
          <button
            type="button"
            className="mx-auto flex items-center justify-center rounded-md p-1 text-foreground/60 transition-colors hover:bg-default/40 hover:text-foreground"
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

      <Select
        aria-label="Track output"
        size={ROUTING_SELECT_SIZE}
        options={destinationOptions}
        value={currentValue}
        onChange={(v) => {
          if (v === EXT_OUTPUT_VALUE) {
            const pick = options[0];
            const channelId = pick?.id ?? serverChannelId;
            commitPending({ primary: EXT_OUTPUT_VALUE, channelId });
            if (pick) onDirectOutput(mono, pick.startChannel, pick.pair);
          } else {
            commitPending({ primary: v });
            onBusSelect(v === SENDS_ONLY_VALUE ? "" : v);
          }
        }}
      />

      {directOutputOpen ? (
        <Select
          aria-label="Physical output"
          size={ROUTING_SELECT_SIZE}
          options={channelOptions}
          value={channelValue}
          onChange={(id) => {
            if (id === missingOptionId) return; // locked to the missing lane
            const parsed = parseOptionId(id);
            commitPending({ primary: EXT_OUTPUT_VALUE, channelId: id });
            if (parsed) onDirectOutput(mono, parsed.startChannel, parsed.pair);
          }}
          {...missingOutputSelectProps(missing)}
        />
      ) : (
        <div className={ROUTING_SELECT_SPACER} aria-hidden />
      )}
    </div>
  );
}
