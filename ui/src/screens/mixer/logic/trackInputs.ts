import type { BusRow, TrackRow } from "../../../lib/state/types";

export type TrackInputOption = {
  id: string;
  label: string;
};

export function getTrackInputState(
  track: Pick<TrackRow, "kind" | "channels" | "inputSource">,
) {
  const isInstrument = track.kind === "instrument";
  const isMidiInputTrack =
    track.kind === "instrument" ||
    track.kind === "midi" ||
    track.kind === "externalMidi";
  const hasAudioInput =
    (track.kind === "audio" || track.kind == null) &&
    track.inputSource !== "none";
  const isMono = track.channels === 1;

  return {
    isInstrument,
    canRecord: hasAudioInput || isMidiInputTrack,
    canMonitorInput: hasAudioInput || isMidiInputTrack,
    isMono,
    currentInput: track.inputSource || (isMono ? "in:1" : "in:1+2"),
  };
}

export function getTrackInputOptions({
  isMono,
  inputChannelNames,
  allBusses,
}: {
  isMono: boolean;
  inputChannelNames?: string[];
  allBusses: Pick<BusRow, "id" | "name">[];
}): TrackInputOption[] {
  const hardwareChannels =
    inputChannelNames && inputChannelNames.length > 0
      ? inputChannelNames
      : ["In 1", "In 2"];

  return [
    ...(isMono
      ? hardwareChannels.map((channelName, channelIndex) => ({
          id: `in:${channelIndex + 1}`,
          label: channelName || `In ${channelIndex + 1}`,
        }))
      : [
          { id: "in:1+2", label: "In 1+2" },
          ...(hardwareChannels.length >= 4
            ? [{ id: "in:3+4", label: "In 3+4" }]
            : []),
          { id: "in:1", label: "In 1 (Spread)" },
          { id: "in:2", label: "In 2 (Spread)" },
        ]),
    ...allBusses.map((bus, busIndex) => ({
      id: `bus:${bus.id}`,
      label: `Bus ${busIndex + 1}: ${bus.name || bus.id}`,
    })),
    { id: "none", label: "No In" },
  ];
}
