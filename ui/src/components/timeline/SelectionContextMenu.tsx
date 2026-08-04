import {
  ContextMenu,
  ContextMenuDivider,
  ContextMenuItem,
} from "../ContextMenu";

/** Shared multi-selection context menu (regions or cues). */
export function SelectionContextMenu({
  x,
  y,
  count,
  kind,
  onCopy,
  onDelete,
  onMuteToggle,
  muteLabel,
  onClose,
}: {
  x: number;
  y: number;
  count: number;
  kind: "region" | "cue";
  onCopy: () => void;
  onDelete: () => void;
  onMuteToggle?: () => void;
  muteLabel?: string;
  onClose: () => void;
}) {
  const noun =
    kind === "region"
      ? count === 1
        ? "Region"
        : "Regions"
      : count === 1
        ? "Cue"
        : "Cues";

  return (
    <ContextMenu x={x} y={y} width={200} onClose={onClose}>
      <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/40">
        {count} {noun} selected
      </div>
      <ContextMenuItem
        onClick={() => {
          onCopy();
          onClose();
        }}
      >
        Copy {count > 1 ? `(${count})` : ""}
      </ContextMenuItem>
      {onMuteToggle && muteLabel && (
        <ContextMenuItem
          onClick={() => {
            onMuteToggle();
            onClose();
          }}
        >
          {muteLabel}
        </ContextMenuItem>
      )}
      <ContextMenuDivider />
      <ContextMenuItem
        danger
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        Delete {count > 1 ? `(${count})` : ""}
      </ContextMenuItem>
    </ContextMenu>
  );
}
