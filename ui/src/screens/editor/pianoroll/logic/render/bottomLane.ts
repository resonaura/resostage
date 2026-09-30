import type { AutomationLaneRow, MidiRegionRow } from "@/lib/state/types";
import {
  midiRegionContainsLoopSourceBeat,
  midiRegionLoopOccurrence,
} from "@/lib/midi/midiRegionTiming";
import type { PianoRollBottomLane, PianoRollViewport } from "@/screens/editor/pianoroll/logic/types";
import type { PianoRollNoteView, PianoRollRenderTheme } from "@/screens/editor/pianoroll/logic/render/types";

interface PianoRollBottomLaneOptions {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  gridBottom: number;
  minBeat: number;
  maxBeat: number;
  viewport: PianoRollViewport;
  bottomLane: PianoRollBottomLane;
  timeVisibleNotes: PianoRollNoteView[];
  selectedNoteIds: Set<number>;
  trackColor?: string;
  localAutomationLanes: AutomationLaneRow[] | null;
  region: MidiRegionRow;
  theme: PianoRollRenderTheme;
  beatToX: (beat: number) => number;
  isControllerLane: (lane: AutomationLaneRow, selected: PianoRollBottomLane) => boolean;
  controllerYFromValue: (value: number, gridBottom: number, height: number, pitchBend: boolean) => number;
}

export function drawPianoRollBottomLane({
  context: ctx,
  width,
  height,
  gridBottom,
  minBeat,
  maxBeat,
  viewport,
  bottomLane,
  timeVisibleNotes,
  selectedNoteIds,
  trackColor,
  localAutomationLanes,
  region,
  theme,
  beatToX,
  isControllerLane,
  controllerYFromValue,
}: PianoRollBottomLaneOptions): void {
  // ── 8. Bottom Lane (Velocity or CC Automation) ─────────────────────────
  const laneY = gridBottom;
  ctx.fillStyle = theme.backgroundSecondary;
  ctx.fillRect(0, laneY, width, viewport.velocityLaneHeight);

  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, laneY);
  ctx.lineTo(width, laneY);
  ctx.stroke();

  if (bottomLane === "velocity") {
    ctx.fillStyle = theme.muted;
    ctx.font = "9px sans-serif";
    ctx.fillText("VELOCITY", 8, laneY + 14);

    for (const { note, beat: noteBeat } of timeVisibleNotes) {
      const isSelected = selectedNoteIds.has(note.id);
      const x = beatToX(noteBeat);
      const vel = Math.max(0.01, Math.min(1.0, note.velocity));
      const stalkHeight = vel * (viewport.velocityLaneHeight - 20);
      const stalkBottom = height - 4;
      const stalkTop = stalkBottom - stalkHeight;

      const velColor = trackColor || theme.accent;
      ctx.strokeStyle = isSelected ? theme.accent : velColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, stalkBottom);
      ctx.lineTo(x, stalkTop);
      ctx.stroke();

      ctx.fillStyle = isSelected ? theme.accent : velColor;
      ctx.beginPath();
      ctx.arc(x, stalkTop, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  const laneLabels: Record<string, string> = {
    cc1: "CC 1 · MODULATION",
    cc11: "CC 11 · EXPRESSION",
    cc64: "CC 64 · SUSTAIN",
    pitchBend: "CHANNEL PITCH BEND",
  };
  const title = laneLabels[bottomLane] || bottomLane.toUpperCase();

  ctx.fillStyle = theme.muted;
  ctx.font = "9px sans-serif";
  ctx.fillText(title, 8, laneY + 14);

  const isPB = bottomLane === "pitchBend";
  const topY = laneY + 18;
  const botY = height - 6;
  const midY = (topY + botY) / 2;

  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(viewport.keyWidth, topY);
  ctx.lineTo(width, topY);
  ctx.moveTo(viewport.keyWidth, botY);
  ctx.lineTo(width, botY);
  ctx.stroke();

  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(viewport.keyWidth, midY);
  ctx.lineTo(width, midY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = theme.muted;
  ctx.font = "8px sans-serif";
  ctx.fillText(isPB ? "+8191" : "127", 6, topY + 4);
  ctx.fillText(isPB ? "0" : "64", 6, midY + 3);
  ctx.fillText(isPB ? "-8192" : "0", 6, botY - 1);

  const lane = (localAutomationLanes ?? region.automationLanes)?.find(
    (candidate) => isControllerLane(candidate, bottomLane),
  );

  if (lane && lane.points && lane.points.length > 0) {
    const sorted = [...lane.points].sort(
      (a, b) => a.timeBeats - b.timeBeats,
    );
    const repeatLength = region.loop && region.loopLengthBeats > 0 ? region.loopLengthBeats : 0;
    const firstRepeat = repeatLength > 0
      ? Math.max(0, Math.floor(minBeat / repeatLength) - 1)
      : 0;
    const lastRepeat = repeatLength > 0
      ? Math.max(firstRepeat, Math.ceil(maxBeat / repeatLength))
      : 0;
    // Bound canvas work even when a tiny source loop is repeated thousands
    // of times across a zoomed-out region.
    const pointStride = Math.max(1, Math.ceil(
      sorted.length * (lastRepeat - firstRepeat + 1) / 12_000,
    ));
    ctx.save();
    ctx.beginPath();
    ctx.rect(viewport.keyWidth, laneY, width - viewport.keyWidth, height - laneY);
    ctx.clip();
    for (let repeat = firstRepeat; repeat <= lastRepeat; repeat += 1) {
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let drawn = false;
      for (let index = 0; index < sorted.length; index += pointStride) {
        const point = sorted[index];
        if (repeatLength > 0 && !midiRegionContainsLoopSourceBeat(region, point.timeBeats)) continue;
        const beat = repeatLength > 0
          ? midiRegionLoopOccurrence(region, point.timeBeats) + repeat * repeatLength
          : point.timeBeats - region.clipOffsetBeats;
        if (beat < minBeat - 1 || beat > maxBeat + 1 || beat >= region.durationBeats) continue;
        const px = beatToX(beat);
        const py = controllerYFromValue(point.value, gridBottom, height, isPB);
        if (!drawn) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        drawn = true;
      }
      if (drawn) ctx.stroke();
      for (let index = 0; index < sorted.length; index += pointStride) {
        const point = sorted[index];
        if (repeatLength > 0 && !midiRegionContainsLoopSourceBeat(region, point.timeBeats)) continue;
        const beat = repeatLength > 0
          ? midiRegionLoopOccurrence(region, point.timeBeats) + repeat * repeatLength
          : point.timeBeats - region.clipOffsetBeats;
        if (beat < minBeat || beat > maxBeat || beat >= region.durationBeats) continue;
        const px = beatToX(beat);
        const py = controllerYFromValue(point.value, gridBottom, height, isPB);
        ctx.fillStyle = theme.accent;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = theme.accentForeground;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Sustain is stored as ordinary MIDI CC64 events (not an automation
  // approximation). Show each down/up interval as a compact step trace.
  if (bottomLane === "cc64" && (region.events?.length ?? 0) > 0) {
    const sustainEvents = (region.events ?? [])
      .filter((event) => (event.status & 0xf0) === 0xb0 && event.data[0] === 64 && event.data.length > 1)
      .sort((left, right) => left.beat - right.beat);
    if (sustainEvents.length > 0) {
      const repeatLength = region.loop && region.loopLengthBeats > 0
        ? region.loopLengthBeats
        : 0;
      const firstRepeat = repeatLength > 0
        ? Math.max(0, Math.floor(minBeat / repeatLength) - 1)
        : 0;
      const lastRepeat = repeatLength > 0
        ? Math.min(
            Math.ceil(region.durationBeats / repeatLength),
            Math.ceil(maxBeat / repeatLength),
          )
        : 0;
      const baselineY = controllerYFromValue(0, gridBottom, height, false);
      const downY = controllerYFromValue(127, gridBottom, height, false);
      ctx.save();
      ctx.beginPath();
      ctx.rect(viewport.keyWidth, laneY, width - viewport.keyWidth, height - laneY);
      ctx.clip();
      ctx.strokeStyle = theme.accent;
      ctx.fillStyle = theme.accent;
      ctx.lineWidth = 2;
      for (let repeat = firstRepeat, work = 0; repeat <= lastRepeat && work < 12_000; repeat += 1) {
        const mapped = sustainEvents
          .filter((event) => repeatLength <= 0 || midiRegionContainsLoopSourceBeat(region, event.beat))
          .map((event) => ({
            beat: repeatLength > 0
              ? midiRegionLoopOccurrence(region, event.beat) + repeat * repeatLength
              : event.beat - region.clipOffsetBeats,
            down: event.data[1] >= 64,
          }))
          .filter((event) => event.beat >= 0 && event.beat < region.durationBeats
            && event.beat >= minBeat - 1 && event.beat <= maxBeat + 1);
        let down = false;
        let downStart = 0;
        for (const event of mapped) {
          work += 1;
          if (event.down === down) continue;
          const x = beatToX(event.beat);
          if (down) {
            ctx.beginPath();
            ctx.moveTo(beatToX(downStart), downY);
            ctx.lineTo(x, downY);
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.moveTo(x, baselineY);
          ctx.lineTo(x, downY);
          ctx.stroke();
          down = event.down;
          if (down) downStart = event.beat;
        }
        if (down) {
          const endBeat = repeatLength > 0
            ? Math.min(region.durationBeats, (repeat + 1) * repeatLength)
            : region.durationBeats;
          ctx.beginPath();
          ctx.moveTo(beatToX(downStart), downY);
          ctx.lineTo(beatToX(Math.min(endBeat, maxBeat + 1)), downY);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }
}
