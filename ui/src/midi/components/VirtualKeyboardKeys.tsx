import type { PointerEvent } from "react";
import type { VirtualKeyboardKey } from "@/midi/logic/keyboardLayout";

export function VirtualKeyboardKeys({
  keys,
  totalWhiteKeys,
  activeNotes,
  activeTrackColor,
  standalone,
  onKeyDown,
  onKeyUp,
  onKeyEnter,
  onKeyLeave,
}: {
  keys: VirtualKeyboardKey[];
  totalWhiteKeys: number;
  activeNotes: ReadonlySet<number>;
  activeTrackColor: string;
  standalone: boolean;
  onKeyDown: (note: number) => void;
  onKeyUp: (note: number) => void;
  onKeyEnter: (note: number, event: PointerEvent<HTMLButtonElement>) => void;
  onKeyLeave: (note: number) => void;
}) {
  const whiteKeys = keys.filter((key) => !key.isBlack);
  const blackKeys = keys.filter((key) => key.isBlack);

  return (
    <div
      className={`relative w-full ${standalone ? "flex-1 min-h-27.5" : "h-28 sm:h-32"} bg-background/90 rounded-xl p-1 overflow-hidden select-none touch-none shadow-inner border border-default/30`}
    >
      {/* White keys container */}
      <div className="flex h-full w-full">
        {whiteKeys.map((key) => {
          const isPressed = activeNotes.has(key.note);
          const isC = key.offset % 12 === 0;
          return (
            <button
              key={key.note}
              type="button"
              onPointerDown={(event) => {
                if (event.button === 0) onKeyDown(key.note);
              }}
              onPointerUp={() => onKeyUp(key.note)}
              onPointerEnter={(event) => onKeyEnter(key.note, event)}
              onPointerLeave={() => onKeyLeave(key.note)}
              style={
                isPressed
                  ? {
                      backgroundColor: activeTrackColor,
                      borderColor: activeTrackColor,
                    }
                  : undefined
              }
              className={`relative flex-1 h-full mx-px rounded-b-[2px] border transition-colors duration-75 flex flex-col justify-between items-center pb-1 pt-1 cursor-pointer select-none ${
                isPressed
                  ? "text-white! z-0"
                  : "bg-[#f7f7f5] text-[#171717] border-[#393939] hover:bg-white"
              }`}
            >
              {/* Upper key badge */}
              {key.badge && (
                <span
                  className={`text-[8px] font-mono leading-none ${isPressed ? "text-white/80" : "text-[#171717]/45"}`}
                >
                  {key.badge}
                </span>
              )}

              {/* Bottom note name */}
              {isC && (
                <span
                  className={`text-[9px] font-mono font-semibold ${
                    isPressed ? "text-white font-bold" : "text-[#171717]"
                  }`}
                >
                  {key.name}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Black keys overlaid on top */}
      {blackKeys.map((key) => {
        const isPressed = activeNotes.has(key.note);
        // Black key is positioned between whiteIndex and whiteIndex + 1.
        const leftPercent = ((key.whiteIndex + 1) / totalWhiteKeys) * 100;
        return (
          <button
            key={key.note}
            type="button"
            onPointerDown={(event) => {
              if (event.button === 0) onKeyDown(key.note);
            }}
            onPointerUp={() => onKeyUp(key.note)}
            onPointerEnter={(event) => onKeyEnter(key.note, event)}
            onPointerLeave={() => onKeyLeave(key.note)}
            style={{
              left: `calc(${leftPercent}% - 0.75rem)`,
              width: "1.5rem",
              ...(isPressed
                ? {
                    backgroundColor: activeTrackColor,
                    borderColor: activeTrackColor,
                  }
                : {}),
            }}
            className={`absolute top-1 h-[60%] rounded-b-[2px] border transition-colors duration-75 flex flex-col justify-between items-center pb-1 pt-1 cursor-pointer select-none z-10 ${
              isPressed
                ? "text-white!"
                : "bg-[#171717] text-[#f7f7f5]/85 border-[#393939] hover:bg-[#242424]"
            }`}
          >
            {key.badge && (
              <span
                className={`text-[7px] font-mono leading-none ${isPressed ? "text-white/80" : "text-[#f7f7f5]/45"}`}
              >
                {key.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
