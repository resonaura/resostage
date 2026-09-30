import type { AutomationLaneRow, MidiNoteRow, MidiRegionRow } from "@/lib/state/types";
import { resolveCssVar } from "@/lib/theme/cssColor";
import { RULER_HEIGHT } from "@/screens/editor/timeline/ruler/logic/constants";
import {
  midiRegionContainsLoopSourceBeat,
  midiRegionLoopOccurrence,
  midiRegionNotePlaybackDuration,
} from "@/lib/midi/midiRegionTiming";
import { isBlackKey, isPitchInScale, pitchToName } from "@/screens/editor/pianoroll/logic/scales";
import type { DraggingState, PianoRollBottomLane, PianoRollViewport, ScaleMode } from "@/screens/editor/pianoroll/logic/types";
import type { SpatialNoteIndex } from "@/screens/editor/pianoroll/logic/spatialIndex";

export interface PianoRollRenderParams {
  canvasElement: HTMLCanvasElement | null;
  viewport: PianoRollViewport;
  bottomLane: PianoRollBottomLane;
  region: MidiRegionRow;
  localAutomationLanes: AutomationLaneRow[] | null;
  rootNote: number;
  scaleMode: ScaleMode;
  showGhostNotes: boolean;
  companionRegions: MidiRegionRow[];
  selectedNoteIds: Set<number>;
  activeMidiPitches: Set<number>;
  timeSignatureNumerator: number;
  hoveredPitch: number | null;
  trackColor?: string;
  beatToX: (beat: number) => number;
  xToBeat: (x: number) => number;
  pitchToY: (pitch: number, height: number) => number;
  spatialIndex: SpatialNoteIndex;
  draggingState: DraggingState | null;
  noteTextColor: (fill: string, background: string, opacity: number) => string;
  isControllerLane: (lane: AutomationLaneRow, selected: PianoRollBottomLane) => boolean;
  controllerYFromValue: (value: number, gridBottom: number, height: number, pitchBend: boolean) => number;
}

export function drawPianoRollCanvas({
  canvasElement,
  viewport,
  bottomLane,
  region,
  localAutomationLanes,
  rootNote,
  scaleMode,
  showGhostNotes,
  companionRegions,
  selectedNoteIds,
  activeMidiPitches,
  timeSignatureNumerator,
  hoveredPitch,
  trackColor,
  beatToX,
  xToBeat,
  pitchToY,
  spatialIndex,
  draggingState,
  noteTextColor,
  isControllerLane,
  controllerYFromValue,
}: PianoRollRenderParams): void {
    const canvas = canvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const gridTop = RULER_HEIGHT;
    const gridBottom = height - viewport.velocityLaneHeight;
    const gridHeight = gridBottom - gridTop;
    const theme = {
      background: resolveCssVar("--background", "#1f1f1f"),
      backgroundSecondary: resolveCssVar("--background-secondary", "#282828"),
      backgroundTertiary: resolveCssVar("--background-tertiary", "#303030"),
      surface: resolveCssVar("--surface", "#eeeeee"),
      border: resolveCssVar("--border", "#666666"),
      foreground: resolveCssVar("--foreground", "#ffffff"),
      muted: resolveCssVar("--muted", "#a0a0a0"),
      accent: resolveCssVar("--accent", "#0485f7"),
      accentForeground: resolveCssVar("--accent-foreground", "#ffffff"),
    };

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // ── 1. Background Grid & Semitones (Clipped to Note Grid) ──────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(viewport.keyWidth, gridTop, width - viewport.keyWidth, gridHeight);
    ctx.clip();

    const minPitch = Math.max(0, Math.floor(viewport.scrollPitch));
    const maxPitch = Math.min(
      127,
      Math.ceil(viewport.scrollPitch + gridHeight / viewport.pixelsPerPitch),
    );
    for (let p = minPitch; p <= maxPitch; ++p) {
      const y = pitchToY(p, height);
      const isBlack = isBlackKey(p);
      const inScale = isPitchInScale(p, rootNote, scaleMode);
      // The editor grid deliberately uses only the dark theme field tokens.
      // `surface*` is reserved for the physical piano keys below: using it in
      // the grid made the whole editor read as a light panel in otherwise dark
      // themes. Keep the scale hint, but make it a restrained dark contrast.
      if (isBlack) {
        ctx.fillStyle = inScale ? theme.backgroundSecondary : theme.background;
      } else {
        ctx.fillStyle = inScale ? theme.backgroundTertiary : theme.backgroundSecondary;
      }
      ctx.fillRect(
        viewport.keyWidth,
        y,
        width - viewport.keyWidth,
        viewport.pixelsPerPitch,
      );

      // Pitch horizontal divider line
      ctx.strokeStyle = theme.backgroundTertiary;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(viewport.keyWidth, y + viewport.pixelsPerPitch);
      ctx.lineTo(width, y + viewport.pixelsPerPitch);
      ctx.stroke();
    }

    // ── 2. Vertical Beat & Bar Dividers ──────────────────────────────────
    const minBeat = Math.max(0, xToBeat(viewport.keyWidth));
    const maxBeat = xToBeat(width);
    const beatsPerBar = Math.max(1, Math.round(timeSignatureNumerator));
    const startBar = Math.floor((region.startBeats + minBeat) / beatsPerBar);
    const endBar = Math.ceil((region.startBeats + maxBeat) / beatsPerBar);

    for (let bar = startBar; bar <= endBar; ++bar) {
      for (let b = 0; b < beatsPerBar; ++b) {
        const beatNum = bar * beatsPerBar + b;
        const x = beatToX(beatNum - region.startBeats);
        if (x < viewport.keyWidth || x > width) continue;

        const isBarLine = b === 0;
        ctx.beginPath();
        ctx.moveTo(x, gridTop);
        ctx.lineTo(x, gridBottom);
        ctx.strokeStyle = isBarLine ? theme.border : theme.backgroundTertiary;
        ctx.lineWidth = isBarLine ? 1.5 : 1;
        ctx.stroke();
      }
    }

    // A looping MIDI region repeats its source pattern up to its arrangement
    // duration. Draw repeat ticks from the live region values so changing the
    // loop length immediately updates the ruler/grid instead of leaving stale
    // decorative marks behind.
    if (region.loop && region.loopLengthBeats > 0 && region.durationBeats > region.loopLengthBeats) {
      const firstRepeat = Math.max(1, Math.floor(minBeat / region.loopLengthBeats));
      const lastRepeat = Math.ceil(Math.min(maxBeat, region.durationBeats) / region.loopLengthBeats);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1;
      for (let repeat = firstRepeat; repeat <= lastRepeat; repeat += 1) {
        const x = beatToX(repeat * region.loopLengthBeats);
        if (x < viewport.keyWidth || x > width) continue;
        ctx.beginPath();
        ctx.moveTo(x, gridTop);
        ctx.lineTo(x, gridBottom);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── 3. Ghost Notes (from companion tracks) ────────────────────────────
    if (showGhostNotes && companionRegions.length > 0) {
      // Ghost notes are a solid, subdued theme field—not a translucent or
      // light surface—so they stay subordinate to editable track-colour notes.
      ctx.fillStyle = theme.backgroundTertiary;
      ctx.strokeStyle = theme.border;
      ctx.lineWidth = 1;

      for (const comp of companionRegions) {
        for (const note of comp.notes) {
          if (note.pitch < minPitch || note.pitch > maxPitch) continue;
          const relativeBeat =
            comp.startBeats - region.startBeats + note.startBeats;
          const x = beatToX(relativeBeat);
          const y = pitchToY(note.pitch, height);
          const w = Math.max(2, note.durationBeats * viewport.pixelsPerBeat);
          const h = viewport.pixelsPerPitch - 1;

          if (x + w < viewport.keyWidth || x > width) continue;

          ctx.fillRect(x, y + 1, w, h);
          ctx.strokeRect(x, y + 1, w, h);
        }
      }
    }

    // ── 4. Active MIDI Notes (from notesToRender) ──────────────────────────
    const loopStart = region.loopStartBeats ?? 0;
    const loopEnd = loopStart + region.loopLengthBeats;
    const sourceVisibleNotes = spatialIndex.queryRange(
      region.loop && region.loopLengthBeats > 0 ? loopStart : minBeat + region.clipOffsetBeats,
      region.loop && region.loopLengthBeats > 0 ? loopEnd : maxBeat + region.clipOffsetBeats,
      minPitch,
      maxPitch,
    );
    // Velocity is a time-domain lane. It must not inherit the pitch window
    // used to virtualize note bodies, otherwise its stalks disappear as soon
    // as the user scrolls those notes out of the vertical viewport.
    const sourceTimeVisibleNotes = spatialIndex.queryRange(
      region.loop && region.loopLengthBeats > 0 ? loopStart : minBeat + region.clipOffsetBeats,
      region.loop && region.loopLengthBeats > 0 ? loopEnd : maxBeat + region.clipOffsetBeats,
      0,
      127,
    );
    const expandLoopViews = (notes: MidiNoteRow[]) => {
      const views: Array<{ note: MidiNoteRow; beat: number }> = [];
      const length = region.loopLengthBeats;
      const repeats = region.loop && length > 0
        ? Math.max(1, Math.ceil(region.durationBeats / length) + 1)
        : 1;
      for (let repeat = 0; repeat < repeats && views.length < 20_000; repeat += 1) {
        for (const note of notes) {
          if (region.loop && !midiRegionContainsLoopSourceBeat(region, note.startBeats))
            continue;
          const beat = region.loop && length > 0
            ? midiRegionLoopOccurrence(region, note.startBeats) + repeat * length
            : note.startBeats - region.clipOffsetBeats;
          const visibleDuration = midiRegionNotePlaybackDuration(
            region, note.startBeats, note.durationBeats,
          );
          if (
            beat + visibleDuration > minBeat &&
            beat < maxBeat &&
            beat < region.durationBeats &&
            views.length < 20_000
          ) {
            views.push({ note: { ...note, durationBeats: visibleDuration }, beat });
          }
        }
      }
      return views;
    };
    const visibleNotes = expandLoopViews(sourceVisibleNotes);
    const timeVisibleNotes = expandLoopViews(sourceTimeVisibleNotes);
    for (const { note, beat: noteBeat } of visibleNotes) {
      const isSelected = selectedNoteIds.has(note.id);
      const noteOpacity = isSelected ? 1 : 0.3 + 0.7 * Math.max(0, Math.min(1, note.velocity));
      const noteFill = isSelected ? theme.accent : (trackColor || theme.accent);
      const x = beatToX(noteBeat);
      const y = pitchToY(note.pitch, height);
      const w = Math.max(4, note.durationBeats * viewport.pixelsPerBeat);
      const h = Math.max(4, viewport.pixelsPerPitch - 2);

      ctx.save();
      ctx.fillStyle = noteFill;
      ctx.globalAlpha = noteOpacity;

      // Rounded rect note body
      ctx.beginPath();
      ctx.roundRect(x, y + 1, w, h, 3);
      ctx.fill();

      // Border styling
      ctx.strokeStyle = isSelected ? theme.accentForeground : theme.border;
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Dynamic LOD: note pitch name and velocity
      if (w >= 24 && viewport.pixelsPerPitch >= 12) {
        ctx.fillStyle = noteTextColor(noteFill, theme.background, noteOpacity);
        ctx.font = "bold 9px sans-serif";
        const name = pitchToName(note.pitch);
        if (w >= 54 && viewport.pixelsPerPitch >= 15) {
          const velVal = Math.round(note.velocity * 127);
          ctx.fillText(`${name} · ${velVal}`, x + 4, y + h - 2);
        } else {
          ctx.fillText(name, x + 4, y + h - 2);
        }
      }
      ctx.restore();
    }

    // ── 5. Marquee Selection Box ─────────────────────────────────────────
    if (
      draggingState?.type === "marquee" &&
      draggingState.marqueeBox
    ) {
      const { startBeat, startPitch, currentBeat, currentPitch } =
        draggingState.marqueeBox;
      const x1 = beatToX(Math.min(startBeat, currentBeat));
      const x2 = beatToX(Math.max(startBeat, currentBeat));
      const y1 = pitchToY(Math.max(startPitch, currentPitch), height);
      const y2 =
        pitchToY(Math.min(startPitch, currentPitch), height) +
        viewport.pixelsPerPitch;

      ctx.fillStyle = theme.backgroundTertiary;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1;
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }

    ctx.restore(); // Restore grid clipping

    // ── 6. Piano Keyboard Margin (Left, Clipped to Keys) ─────────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, gridTop, viewport.keyWidth, gridHeight);
    ctx.clip();

    ctx.fillStyle = theme.backgroundSecondary;
    ctx.fillRect(0, gridTop, viewport.keyWidth, gridHeight);

    for (let p = minPitch; p <= maxPitch; ++p) {
      const y = pitchToY(p, height);
      const isBlack = isBlackKey(p);
      const isC = p % 12 === 0;

      if (p === hoveredPitch) {
        ctx.fillStyle = theme.accent;
      } else if (activeMidiPitches.has(p)) {
        ctx.fillStyle = trackColor || theme.accent;
      } else {
        // The left keyboard is deliberately physical-key coloured rather
        // than themed like the editor field: white naturals and black
        // accidentals remain immediately legible in every application theme.
        ctx.fillStyle = isBlack ? "#171717" : "#f7f7f5";
      }
      ctx.fillRect(0, y, viewport.keyWidth - 1, viewport.pixelsPerPitch);

      ctx.strokeStyle = "#393939";
      ctx.lineWidth = 1;
      ctx.strokeRect(0, y, viewport.keyWidth - 1, viewport.pixelsPerPitch);

      if (isC) {
        ctx.fillStyle = isBlack ? "#f7f7f5" : "#171717";
        ctx.font = "bold 9px sans-serif";
        ctx.fillText(pitchToName(p), 4, y + viewport.pixelsPerPitch - 4);
      }
    }

    ctx.restore(); // Restore keyboard clipping

    // Key / Grid vertical separator
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(viewport.keyWidth - 0.5, 0);
    ctx.lineTo(viewport.keyWidth - 0.5, gridBottom);
    ctx.stroke();

    // ── 7. Timeline Ruler Header (Top Bar: 0 .. RULER_HEIGHT) ─────────────
    ctx.fillStyle = theme.backgroundTertiary;
    ctx.fillRect(viewport.keyWidth, 0, width - viewport.keyWidth, RULER_HEIGHT);

    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(viewport.keyWidth, RULER_HEIGHT - 0.5);
    ctx.lineTo(width, RULER_HEIGHT - 0.5);
    ctx.stroke();

    // Top-left corner cell (above piano keys)
    ctx.fillStyle = theme.backgroundSecondary;
    ctx.fillRect(0, 0, viewport.keyWidth, RULER_HEIGHT);
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT - 0.5);
    ctx.lineTo(viewport.keyWidth, RULER_HEIGHT - 0.5);
    ctx.stroke();

    ctx.fillStyle = theme.muted;
    ctx.font = "bold 9px sans-serif";
    ctx.fillText("KEYS", 8, 16);

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
    } else {
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

    ctx.restore();
}
