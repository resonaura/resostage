import { useMemo, useRef, useState } from "react";
import { builder } from "../../lib/state/api";
import { createEditGesture } from "../../lib/interaction/editGesture";
import { songBeatsAtSeconds } from "../../lib/midi/standardMidiFile";
import type { AutomationLaneRow, SongRow } from "../../lib/state/types";

const WIDTH = 360;
const HEIGHT = 88;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function projectEndBeat(song: SongRow): number {
  const audioEnd = Math.max(0, ...(song.regions ?? []).map(
    (region) => region.startSeconds + Math.max(0, region.durationSeconds),
  ), song.endSeconds ?? 0);
  const midiEnd = Math.max(0, ...(song.midiRegions ?? []).map(
    (region) => region.startBeats + Math.max(0, region.durationBeats),
  ));
  return Math.max(4, midiEnd, songBeatsAtSeconds(song, audioEnd));
}

export function AutomationMiniGraph({
  lane,
  song,
  songIndex,
  parameterSteps = 0,
}: {
  lane: AutomationLaneRow;
  song: SongRow;
  songIndex: number;
  parameterSteps?: number;
}) {
  const [gesturePoints, setGesturePoints] = useState<AutomationLaneRow["points"] | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    originalTime: number | null;
    time: number;
    value: number;
    curve: number;
    gestureId: string;
  } | null>(null);
  const editGesture = useRef(createEditGesture()).current;
  const endBeat = useMemo(() => projectEndBeat(song), [song]);
  const points = gesturePoints ?? lane.points;

  const coordinates = useMemo(() => points
    .slice()
    .sort((a, b) => a.timeBeats - b.timeBeats)
    .map((point) => ({
      x: clamp01(point.timeBeats / endBeat) * WIDTH,
      y: (1 - clamp01(point.value)) * HEIGHT,
      point,
    })), [endBeat, points]);

  const pointAt = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = clamp01((event.clientX - bounds.left) / Math.max(1, bounds.width));
    const y = clamp01((event.clientY - bounds.top) / Math.max(1, bounds.height));
    return { time: x * endBeat, value: 1 - y, x: x * WIDTH, y: y * HEIGHT };
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const position = pointAt(event);
    const nearest = coordinates.reduce<typeof coordinates[number] | null>((best, item) => {
      const distance = Math.hypot(item.x - position.x, item.y - position.y);
      if (distance > 12 || (best && Math.hypot(best.x - position.x, best.y - position.y) <= distance))
        return best;
      return item;
    }, null);

    if (event.altKey && nearest) {
      event.preventDefault();
      void builder.automationPointRemove(
        songIndex, lane.id, nearest.point.timeBeats, editGesture.id(),
      );
      setGesturePoints(null);
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const value = parameterSteps > 1
      ? Math.round(position.value * (parameterSteps - 1)) / (parameterSteps - 1)
      : position.value;
    const next = {
      pointerId: event.pointerId,
      originalTime: nearest?.point.timeBeats ?? null,
      time: nearest ? nearest.point.timeBeats : position.time,
      value: nearest ? nearest.point.value : value,
      curve: nearest?.point.curve ?? 0,
      gestureId: editGesture.id(),
    };
    dragRef.current = next;
    setGesturePoints([...points.filter((point) => point.timeBeats !== next.originalTime), {
      timeBeats: next.time, value: next.value, curve: next.curve,
    }]);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = pointAt(event);
    const value = parameterSteps > 1
      ? Math.round(position.value * (parameterSteps - 1)) / (parameterSteps - 1)
      : position.value;
    drag.time = position.time;
    drag.value = value;
    setGesturePoints([
      ...points.filter((point) => point.timeBeats !== drag.originalTime),
      { timeBeats: drag.time, value: drag.value, curve: drag.curve },
    ]);
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.originalTime !== null && Math.abs(drag.originalTime - drag.time) > 1e-5) {
      void builder.automationPointRemove(
        songIndex, lane.id, drag.originalTime, drag.gestureId,
      );
    }
    void builder.automationPointAdd({
      songIndex,
      laneId: lane.id,
      timeBeats: drag.time,
      value: drag.value,
      curve: drag.curve,
      gestureId: drag.gestureId,
    });
    setGesturePoints(null);
  };

  return (
    <div className="rounded-md border border-default/25 bg-background/70 p-1.5">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-20 w-full touch-none cursor-crosshair"
        aria-label="Plug-in automation curve. Click to add or drag a point; Alt-click or Option-click a point to remove it."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { dragRef.current = null; setGesturePoints(null); }}
      >
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line key={fraction} x1="0" x2={WIDTH} y1={HEIGHT * fraction} y2={HEIGHT * fraction}
            stroke="currentColor" strokeOpacity="0.12" strokeDasharray="3 4" />
        ))}
        <line x1="0" x2={WIDTH} y1={HEIGHT} y2={HEIGHT} stroke="currentColor" strokeOpacity="0.2" />
        {coordinates.length > 1 && (
          <polyline
            points={coordinates.map(({ x, y }) => `${x},${y}`).join(" ")}
            fill="none" stroke="var(--accent)" strokeWidth="2.5" vectorEffect="non-scaling-stroke"
          />
        )}
        {coordinates.map(({ x, y, point }) => (
          <circle key={`${point.timeBeats}`} cx={x} cy={y} r="5" fill="var(--accent)"
            stroke="var(--background)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="mt-1 text-[9px] text-foreground/45">
        0 → {endBeat.toFixed(1)} beats · click to add, drag to edit, Alt/Option-click to delete
      </div>
    </div>
  );
}
