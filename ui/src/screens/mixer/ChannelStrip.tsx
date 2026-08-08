import { Knob, LevelMeterBar } from "../../components/daw";
import { useChannelClipHold } from "../../hooks/useChannelClipHold";
import { useLiveValue } from "../../lib/optimistic";
import type { BusRow, ClickSendRow, SettingsState } from "../../lib/types";
import { GainFader } from "./GainFader";
import { GainPeakReadout } from "./GainPeakReadout";
import { SendKnobs } from "./SendKnobs";
import { TrackOutputRouting } from "./TrackOutputRouting";

/** Stable identity so useLiveValue's commit ref doesn't churn. */
const noop = () => {};

function StripButton({
  active,
  color,
  flashingMute,
  children,
  onClick,
}: {
  active: boolean;
  color: "danger" | "warning";
  flashingMute?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  const activeCls =
    color === "danger"
      ? "bg-danger text-white border-danger"
      : "bg-warning text-black border-warning";
  return (
    <button
      onClick={onClick}
      className={`flex h-5 w-full items-center justify-center rounded border text-[10px] font-bold transition-colors ${
        active
          ? activeCls
          : "border-default/50 bg-default/10 text-foreground/50 hover:bg-default/25"
      }`}
    >
      <span
        className={
          flashingMute ? "animate-pulse text-amber-400 font-extrabold" : ""
        }
      >
        {children}
      </span>
    </button>
  );
}

export function ChannelStrip({
  name,
  subtitle,
  color,
  busses,
  busId,
  onBusSelect,
  directOutput,
  sends,
  busDestination,
  gainDb,
  pan,
  peakDb,
  peakDbL,
  peakDbR,
  getLiveDb,
  getLiveDbL,
  getLiveDbR,
  mute,
  solo,
  anySoloInGroup,
  onGain,
  onPan,
  onMute,
  onSolo,
}: {
  name: string;
  subtitle?: string;
  color: string;
  busses?: BusRow[];
  busId?: string;
  onBusSelect?: (id: string) => void;
  directOutput?: {
    settings: SettingsState;
    allBusses: BusRow[];
    mono?: boolean;
    onMonoChange?: (mono: boolean) => void;
    onDirectOutput: (
      mono: boolean,
      startChannel: number,
      pair: boolean,
    ) => void;
  };
  sends?: {
    auxBusses: BusRow[];
    values: ClickSendRow[];
    trackIndex: number;
    /** Overrides the default per-track write. `level` is 0-100 percent. */
    onSendChange?: (busId: string, level: number, enabled?: boolean) => void;
    onSendEnabledChange?: (busId: string, enabled: boolean) => void;
  };
  busDestination?: React.ReactNode;
  gainDb: number;
  pan: number | null;
  peakDb: number | undefined;
  peakDbL?: number;
  peakDbR?: number;
  getLiveDb?: () => number;
  getLiveDbL?: () => number;
  getLiveDbR?: () => number;
  mute: boolean;
  solo: boolean;
  anySoloInGroup?: boolean;
  onGain: (v: number) => void;
  onPan: ((v: number) => void) | null;
  onMute: () => void;
  onSolo: () => void;
}) {
  const formatPan = (p: number) => {
    if (Math.abs(p) < 0.05) return "C";
    if (p < 0) return `L${Math.round(-p * 100)}`;
    return `R${Math.round(p * 100)}`;
  };

  // ── What this strip currently SHOWS, as opposed to what the engine has
  // last confirmed ────────────────────────────────────────────────────────
  //
  // Both live here rather than inside the fader and the knob, because a
  // control and its numeric readout have to agree. When the fader kept its
  // optimistic copy to itself, dragging it moved the handle instantly while
  // the dB box directly above it stayed on the last echoed server value --
  // measurably a couple of frames behind, and it read as the mixer waiting on
  // the backend. Pan had the same split between the knob and its L/C/R label.
  //
  // useLiveValue publishes the new value locally AND commits it, then ignores
  // server echoes for a short window so a stale in-flight frame can't yank the
  // control back mid-gesture. The engine remains the authority the moment that
  // window closes -- this changes when the UI believes itself, not who wins.
  const [displayGainDb, commitGain] = useLiveValue(gainDb, onGain);
  // Hooks cannot be conditional, and a strip without pan (metronome routed to
  // sends only) passes null for both. The value is then never rendered.
  const [displayPan, commitPan] = useLiveValue(pan ?? 0, onPan ?? noop);

  const isDimmed = !!anySoloInGroup && !solo;
  const stripLeftDb = peakDbL ?? peakDb ?? -100;
  const stripRightDb = peakDbR ?? peakDb ?? -100;
  const stripClip = useChannelClipHold(Math.max(stripLeftDb, stripRightDb));

  return (
    <div
      className={`flex h-full min-h-0 w-24 shrink-0 flex-col items-center justify-between rounded-lg border border-default/30 bg-background-secondary p-2 select-none transition-opacity duration-300 ${
        isDimmed ? "opacity-35" : "opacity-100"
      }`}
    >
      <div className="flex flex-col items-center gap-0.5 w-full min-w-0 text-center">
        <div
          className="h-1 w-full rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <div
          className="truncate text-xs font-semibold text-foreground w-full min-w-0"
          title={name}
        >
          {name}
        </div>
        {subtitle && (
          <div
            className="text-[9px] text-foreground/40 font-mono truncate w-full min-w-0"
            title={subtitle}
          >
            {subtitle}
          </div>
        )}
      </div>

      {busses && onBusSelect && directOutput ? (
        <TrackOutputRouting
          busId={busId || ""}
          busses={busses}
          allBusses={directOutput.allBusses}
          settings={directOutput.settings}
          mono={directOutput.mono}
          onMonoChange={directOutput.onMonoChange}
          onBusSelect={onBusSelect}
          onDirectOutput={directOutput.onDirectOutput}
        />
      ) : (
        busses &&
        onBusSelect && (
          <div className="w-full my-1">
            <select
              value={busId || ""}
              onChange={(e) => onBusSelect(e.target.value)}
              className="w-full box-border rounded border border-default/40 bg-default/20 px-1 py-0.5 text-[9px] font-medium text-foreground focus:outline-none h-[22px]"
            >
              {busses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name || b.id}
                </option>
              ))}
            </select>
          </div>
        )
      )}

      {busDestination}

      {onPan && pan !== null ? (
        <div className="flex flex-col items-center gap-0.5 my-1">
          <Knob
            value={displayPan}
            min={-1}
            max={1}
            defaultValue={0}
            accent="rgba(255,255,255,0.9)"
            onCommit={commitPan}
            size={24}
            title="Pan"
          />
          <div className="text-[9px] font-mono text-foreground/50">
            {formatPan(displayPan)}
          </div>
        </div>
      ) : (
        <div className="h-2" />
      )}

      <GainPeakReadout
        gainDb={displayGainDb}
        liveAvgDb={(stripLeftDb + stripRightDb) / 2}
        clipped={stripClip.clipped}
        heldPeakDb={stripClip.heldPeakDb}
        onClear={stripClip.clear}
      />

      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 py-2">
        <GainFader
          value={displayGainDb}
          accent={color}
          onChange={commitGain}
        />
        <LevelMeterBar
          db={peakDb ?? -100}
          dbL={stripLeftDb}
          dbR={stripRightDb}
          getLiveDb={getLiveDb}
          getLiveDbL={getLiveDbL}
          getLiveDbR={getLiveDbR}
          accent={color}
          vertical={true}
          showValue={false}
          barClassName="h-full w-1.5"
          clipLatched={stripClip.clipped}
          onClearClip={stripClip.clear}
        />
      </div>

      {sends && (
        <SendKnobs
          auxBusses={sends.auxBusses}
          sends={sends.values}
          trackIndex={sends.trackIndex}
          onSendChange={sends.onSendChange}
          onSendEnabledChange={sends.onSendEnabledChange}
        />
      )}

      {/* Always last so M/S line up at the bottom of every strip. */}
      <div className="flex w-full gap-1 shrink-0 mt-auto">
        <StripButton
          active={mute}
          color="danger"
          flashingMute={isDimmed}
          onClick={onMute}
        >
          M
        </StripButton>
        <StripButton active={solo} color="warning" onClick={onSolo}>
          S
        </StripButton>
      </div>
    </div>
  );
}
