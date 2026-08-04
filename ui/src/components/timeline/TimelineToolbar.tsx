import { Button, Slider } from "@heroui/react";
import {
  AudioLines,
  Copy,
  Lightbulb,
  Locate,
  LocateFixed,
  LocateOff,
  Magnet,
  MoveHorizontalIcon,
  MoveVerticalIcon,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
} from "lucide-react";
import { timelineHistory } from "../../lib/api";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC } from "./constants";
import { formatTimeShort } from "./geometry";

export type TimelineFollowMode = "off" | "snap" | "smooth";
export type TimelineViewMode = "audio" | "light";

export function TimelineToolbar({
  songCount,
  totalLength,
  readOnly,
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  effectiveViewMode,
  setViewMode,
  snapToGrid,
  setSnapToGrid,
  followMode,
  cycleFollowMode,
  hasCueSelection,
  hasRegionSelection,
  onCopy,
  onDelete,
  onSplit,
  pxPerSec,
  applyZoomAt,
  markGestureActive,
  markZoomActive,
  verticalZoom,
  setVerticalZoom,
}: {
  songCount: number;
  totalLength: number;
  readOnly: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string | null;
  redoLabel?: string | null;
  effectiveViewMode: TimelineViewMode;
  setViewMode: (m: TimelineViewMode) => void;
  snapToGrid: boolean;
  setSnapToGrid: React.Dispatch<React.SetStateAction<boolean>>;
  followMode: TimelineFollowMode;
  cycleFollowMode: () => void;
  hasCueSelection: boolean;
  hasRegionSelection: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onSplit: () => void;
  pxPerSec: number;
  applyZoomAt: (next: number) => void;
  markGestureActive: () => void;
  markZoomActive: () => void;
  verticalZoom: number;
  setVerticalZoom: React.Dispatch<React.SetStateAction<number>>;
}) {
  const light = effectiveViewMode === "light";
  const selectionEmpty = light ? !hasCueSelection : !hasRegionSelection;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-default/30 px-3 py-1.5 bg-background-secondary z-20">
      <span className="text-xs font-semibold uppercase tracking-wide text-foreground/40 shrink-0">
        Timeline
        <span className="ml-2 font-normal lowercase text-foreground/25">
          {songCount} song{songCount === 1 ? "" : "s"} &middot;{" "}
          {formatTimeShort(totalLength)}
        </span>
      </span>

      <div className="flex items-center gap-1 ml-auto h-7">
        {!readOnly && (
          <>
            <Button
              size="sm"
              variant="outline"
              isIconOnly
              aria-label={undoLabel ? `Undo: ${undoLabel} (⌘Z)` : "Undo (⌘Z)"}
              isDisabled={!canUndo}
              onPress={() => void timelineHistory.undo()}
            >
              <Undo2 size={13} />
            </Button>
            <Button
              size="sm"
              variant="outline"
              isIconOnly
              aria-label={redoLabel ? `Redo: ${redoLabel} (⌘⇧Z)` : "Redo (⌘⇧Z)"}
              isDisabled={!canRedo}
              onPress={() => void timelineHistory.redo()}
            >
              <Redo2 size={13} />
            </Button>
            <div className="w-px h-4 bg-default/30 mx-0.5" />
            <Button
              size="sm"
              variant="outline"
              isIconOnly
              aria-label={
                light ? "Copy selected cue (⌘C)" : "Copy selected regions (⌘C)"
              }
              isDisabled={selectionEmpty}
              onPress={onCopy}
            >
              <Copy size={13} />
            </Button>
            <Button
              size="sm"
              variant="outline"
              isIconOnly
              aria-label={
                light
                  ? "Delete selected cue (⌫)"
                  : "Delete selected regions (⌫)"
              }
              isDisabled={selectionEmpty}
              onPress={onDelete}
            >
              <Trash2 size={13} />
            </Button>
            <Button
              size="sm"
              variant="outline"
              isIconOnly
              aria-label={
                light
                  ? "Split selected cue at playhead (⌘T)"
                  : "Trim/split selected regions at playhead (⌘T)"
              }
              isDisabled={selectionEmpty}
              onPress={onSplit}
            >
              <Scissors size={13} />
            </Button>
            <div className="w-px h-4 bg-default/30 mx-0.5" />
            <Button
              size="sm"
              variant={snapToGrid ? "primary" : "outline"}
              isIconOnly
              aria-label={snapToGrid ? "Snap to grid: ON" : "Snap to grid: OFF"}
              onPress={() => setSnapToGrid((v) => !v)}
            >
              <Magnet size={13} />
            </Button>
          </>
        )}

        {!readOnly && (
          <>
            <div className="w-px h-4 bg-default/30 mx-0.5" />
            <div className="flex items-center rounded-lg border border-default/40 bg-default/10 p-0.5">
              <button
                type="button"
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition-colors ${
                  effectiveViewMode === "audio"
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground/50 hover:text-foreground"
                }`}
                aria-pressed={effectiveViewMode === "audio"}
                onClick={() => setViewMode("audio")}
              >
                <AudioLines size={11} /> Audio
              </button>
              <button
                type="button"
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition-colors ${
                  effectiveViewMode === "light"
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground/50 hover:text-foreground"
                }`}
                aria-pressed={effectiveViewMode === "light"}
                onClick={() => setViewMode("light")}
              >
                <Lightbulb size={11} /> Light
              </button>
            </div>
          </>
        )}

        <div className="w-px h-4 bg-default/30 mx-0.5" />
        <Button
          size="sm"
          variant={followMode === "off" ? "outline" : "primary"}
          isIconOnly
          aria-label={
            followMode === "off"
              ? "Playhead autofollow: off (click for standard)"
              : followMode === "snap"
                ? "Playhead autofollow: standard (click for smooth)"
                : "Playhead autofollow: smooth (click to turn off)"
          }
          onPress={cycleFollowMode}
        >
          {followMode === "off" ? (
            <LocateOff size={13} />
          ) : followMode === "snap" ? (
            <Locate size={13} />
          ) : (
            <LocateFixed size={13} />
          )}
        </Button>

        <div className="flex items-center gap-1.5 ml-1 w-[17.5rem] shrink-0">
          <MoveHorizontalIcon
            style={{ opacity: 0.2, width: "16px", height: "16px" }}
          />
          <Slider
            aria-label="Horizontal zoom"
            minValue={0}
            maxValue={1}
            step={0.001}
            value={Math.max(
              0,
              Math.min(
                1,
                Math.log(pxPerSec / MIN_PX_PER_SEC) /
                  Math.log(MAX_PX_PER_SEC / MIN_PX_PER_SEC),
              ),
            )}
            onChange={(v) => {
              const t = Array.isArray(v) ? v[0] : v;
              const next =
                MIN_PX_PER_SEC * Math.pow(MAX_PX_PER_SEC / MIN_PX_PER_SEC, t);
              markGestureActive();
              markZoomActive();
              applyZoomAt(next);
            }}
            className="flex-1 min-w-0 -mt-1"
          >
            <Slider.Track
              style={{
                borderLeftColor: "var(--default)",
                background: "var(--background)",
              }}
            >
              <Slider.Fill style={{ background: "var(--default)" }} />
              <Slider.Thumb
                style={
                  {
                    boxSizing: "border-box",
                    background: "var(--default)",
                  } as React.CSSProperties
                }
              />
            </Slider.Track>
          </Slider>
          <MoveVerticalIcon
            style={{ opacity: 0.2, width: "16px", height: "16px" }}
          />
          <Slider
            aria-label="Vertical zoom"
            minValue={0.3}
            maxValue={4}
            step={0.01}
            value={verticalZoom}
            onChange={(v) => {
              const z = Array.isArray(v) ? v[0] : v;
              setVerticalZoom(z);
            }}
            className="flex-1 min-w-0 -mt-1"
          >
            <Slider.Track
              style={{
                borderLeftColor: "var(--default)",
                background: "var(--background)",
              }}
            >
              <Slider.Fill style={{ background: "var(--default)" }} />
              <Slider.Thumb
                style={
                  {
                    boxSizing: "border-box",
                    background: "var(--default)",
                  } as React.CSSProperties
                }
              />
            </Slider.Track>
          </Slider>
        </div>
      </div>
    </div>
  );
}
