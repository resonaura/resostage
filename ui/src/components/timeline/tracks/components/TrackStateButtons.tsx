import { mixer } from "../../../../lib/state/api";
import type { TrackRow } from "../../../../lib/state/types";

/** The four authoritative Core track switches, shared by compact editor surfaces. */
export function TrackStateButtons({
  track,
  index,
  focused = false,
  compact = false,
}: {
  track: TrackRow;
  index: number;
  focused?: boolean;
  compact?: boolean;
}) {
  const canRecord = track.kind === "instrument" || track.kind === "midi" ||
    track.kind === "externalMidi" ||
    (track.kind === "audio" && Boolean(track.inputSource && track.inputSource !== "none"));
  const base = `flex shrink-0 items-center justify-center rounded border font-bold transition-colors ${compact ? "h-4.5 w-4.5 text-[9px]" : "h-6 w-6 text-[11px]"}`;
  const inactive = "border-default/30 bg-surface/60 text-foreground/70 hover:bg-surface";

  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={`${track.name || track.id} track controls`}>
      <button
        type="button"
        className={`${base} ${track.mute ? "border-(--rs-mute) bg-(--rs-mute) text-white" : inactive}`}
        aria-label="Mute"
        aria-pressed={track.mute}
        onClick={() => void mixer.setTrackMute(index, !track.mute)}
      >M</button>
      <button
        type="button"
        className={`${base} ${track.solo ? "border-(--rs-solo) bg-(--rs-solo) text-black" : inactive} ${track.soloSafe ? "ring-1 ring-danger ring-inset" : ""}`}
        aria-label="Solo"
        aria-pressed={track.solo}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey) void mixer.setTrackSoloSafe(index, !track.soloSafe);
          else void mixer.setTrackSolo(index, !track.solo);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          void mixer.setTrackSoloSafe(index, !track.soloSafe);
        }}
      >S</button>
      <span className="mx-0.5 h-4 w-px bg-default/30" aria-hidden="true" />
      <button
        type="button"
        disabled={!canRecord}
        className={`${base} ${track.recordArmed ? "border-(--rs-record) bg-(--rs-record) text-white" : inactive} disabled:opacity-30`}
        style={focused && !track.recordArmed ? { color: "var(--rs-record)" } : undefined}
        aria-label="Record arm"
        aria-pressed={Boolean(track.recordArmed)}
        onClick={() => void mixer.setTrackRecordArm(index, !track.recordArmed)}
      >R</button>
      <button
        type="button"
        disabled={!canRecord}
        className={`${base} ${track.inputMonitoring ? "border-(--rs-monitor) bg-(--rs-monitor) text-black" : inactive} disabled:opacity-30`}
        style={focused && !track.inputMonitoring ? { color: "var(--rs-monitor)" } : undefined}
        aria-label="Input monitoring"
        aria-pressed={Boolean(track.inputMonitoring)}
        onClick={() => void mixer.setTrackInputMonitor(index, !track.inputMonitoring)}
      >I</button>
    </div>
  );
}
