import { Knob, LevelMeterBar } from "../../components/daw";
import {
  Select,
  TOGGLE_BLINK_ACCENT,
  ToggleButton,
} from "../../components/ui";
import { useChannelClipHold } from "../../hooks/useChannelClipHold";
import { useLiveValue } from "../../lib/optimistic";
import type { BusRow, ClickSendRow, SettingsState } from "../../lib/types";
import { ROUTING_SELECT_SIZE } from "./constants";
import { GainFader } from "./GainFader";
import { GainPeakReadout } from "./GainPeakReadout";
import { SendKnobs } from "./SendKnobs";
import { TrackOutputRouting } from "./TrackOutputRouting";

/** Stable identity so useLiveValue's commit ref doesn't churn. */
const noop = () => {};

/**
 * Mute / Solo.
 *
 * Soft tones rather than a saturated fill: a console is a wall of these, and
 * twelve solid red blocks read as an error state rather than as twelve
 * controls. The soft tones still carry full-strength foreground colour (see
 * styles/tones.css), so an engaged mute is unmistakable from across a stage
 * without shouting when it is off.
 */
function StripButton({
  active,
  tone,
  blink,
  children,
  onPress,
}: {
  active: boolean;
  tone: "danger-soft" | "warning-soft";
  /** Silenced by another strip's solo -- see TOGGLE_BLINK_ACCENT. */
  blink?: boolean;
  children: React.ReactNode;
  onPress: () => void;
}) {
  return (
    <ToggleButton
      size="xs"
      tone={tone}
      isSelected={active}
      onChange={onPress}
      className={blink ? `w-full ${TOGGLE_BLINK_ACCENT}` : "w-full"}
    >
      {children}
    </ToggleButton>
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
  // First-paint fallbacks only. Everything that has to FOLLOW the signal --
  // the meter bars, the dB box, the clip latch -- samples the live getters
  // during its own paint, which is what lets the strip stop re-rendering at
  // telemetry rate (see lib/levelFields).
  const stripLeftDb = peakDbL ?? peakDb ?? -100;
  const stripRightDb = peakDbR ?? peakDb ?? -100;
  const liveLeft = () => getLiveDbL?.() ?? getLiveDb?.() ?? stripLeftDb;
  const liveRight = () => getLiveDbR?.() ?? getLiveDb?.() ?? stripRightDb;
  const stripClip = useChannelClipHold(() =>
    Math.max(liveLeft(), liveRight()),
  );

  return (
    <div
      className={`flex h-full min-h-0 w-24 shrink-0 select-none flex-col items-center justify-between rounded-xl border border-default/25 bg-background-secondary p-2 transition-opacity duration-300 ${
        isDimmed ? "opacity-35" : "opacity-100"
      }`}
    >
      <div className="flex w-full min-w-0 flex-col items-center gap-1 text-center">
        <div
          className="h-[3px] w-full shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <div
          className="w-full min-w-0 truncate text-xs font-semibold text-foreground"
          title={name}
        >
          {name}
        </div>
        {subtitle && (
          <div
            className="w-full min-w-0 truncate font-mono text-[9px] uppercase tracking-wide text-foreground/35"
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
          <div className="my-1 w-full">
            <Select
              aria-label="Output bus"
              size={ROUTING_SELECT_SIZE}
              options={busses.map((b) => ({ id: b.id, label: b.name || b.id }))}
              value={busId || ""}
              onChange={onBusSelect}
            />
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
            accent="color-mix(in oklab, var(--foreground) 90%, transparent)"
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
        getLiveDb={() => (liveLeft() + liveRight()) / 2}
        clipped={stripClip.clipped}
        heldPeakDb={stripClip.heldPeakDb}
        onClear={stripClip.clear}
      />

      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 py-2">
        <GainFader value={displayGainDb} onChange={commitGain} />
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
      <div className="mt-auto flex w-full shrink-0 gap-1">
        <StripButton
          active={mute}
          tone="danger-soft"
          blink={isDimmed && !mute}
          onPress={onMute}
        >
          M
        </StripButton>
        <StripButton active={solo} tone="warning-soft" onPress={onSolo}>
          S
        </StripButton>
      </div>
    </div>
  );
}
