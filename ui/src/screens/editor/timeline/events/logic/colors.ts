import { roleColor, type ColorRole } from "@/lib/theme";

/** Event type on the wire -> the role that names its colour. */
const EVENT_COLOR_ROLES: Record<string, ColorRole> = {
  programChange: "eventProgramChange",
  noteOn: "eventNoteOn",
  noteOff: "eventNoteOff",
  cc: "eventCc",
  http: "eventHttp",
  dmx: "eventDmx",
};

/** Resolved event-marker colour by event type; grey for an unknown type. */
export function getEventColor(type: string): string {
  const role = EVENT_COLOR_ROLES[type];
  return role ? roleColor(role) : "#8e8e93";
}
