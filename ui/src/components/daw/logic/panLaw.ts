export interface TrackPanLawOption {
  id: number;
  value: string;
  label: string;
}

export const TRACK_PAN_LAWS = [
  { id: 0, value: "0dB", label: "0 dB · Legacy balance" },
  { id: 1, value: "-3dB", label: "−3 dB · Constant power" },
  { id: 2, value: "-4.5dB", label: "−4.5 dB · Broadcast" },
  { id: 3, value: "-6dB", label: "−6 dB · Constant voltage" },
] as const satisfies readonly TrackPanLawOption[];

export type TrackPanLawValue = (typeof TRACK_PAN_LAWS)[number]["value"];

export function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.05) return "C";
  if (pan < 0) return `L${Math.round(-pan * 100)}`;
  return `R${Math.round(pan * 100)}`;
}
