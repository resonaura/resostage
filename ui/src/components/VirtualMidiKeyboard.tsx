import {
  GripVertical,
  Keyboard,
  Minus,
  Plus,
  RotateCcw,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mixer, sendLiveMidi } from "../lib/api";
import type { WebUiState } from "../lib/types";

// FL Studio / Logic Pro QWERTY typing keyboard mappings
// Lower row (base octave)
const LOWER_ROW_KEYS: Record<string, { offset: number; label: string }> = {
  KeyZ: { offset: 0, label: "Z" }, // C
  KeyS: { offset: 1, label: "S" }, // C#
  KeyX: { offset: 2, label: "X" }, // D
  KeyD: { offset: 3, label: "D" }, // D#
  KeyC: { offset: 4, label: "C" }, // E
  KeyV: { offset: 5, label: "V" }, // F
  KeyG: { offset: 6, label: "G" }, // F#
  KeyB: { offset: 7, label: "B" }, // G
  KeyH: { offset: 8, label: "H" }, // G#
  KeyN: { offset: 9, label: "N" }, // A
  KeyJ: { offset: 10, label: "J" }, // A#
  KeyM: { offset: 11, label: "M" }, // B
  Comma: { offset: 12, label: "," }, // C (+1)
  KeyL: { offset: 13, label: "L" }, // C# (+1)
  Period: { offset: 14, label: "." }, // D (+1)
  Semicolon: { offset: 15, label: ";" }, // D# (+1)
  Slash: { offset: 16, label: "/" }, // E (+1)
};

// Upper row (+1 octave above lower row)
const UPPER_ROW_KEYS: Record<string, { offset: number; label: string }> = {
  KeyQ: { offset: 12, label: "Q" }, // C (+1)
  Digit2: { offset: 13, label: "2" }, // C# (+1)
  KeyW: { offset: 14, label: "W" }, // D (+1)
  Digit3: { offset: 15, label: "3" }, // D# (+1)
  KeyE: { offset: 16, label: "E" }, // E (+1)
  KeyR: { offset: 17, label: "R" }, // F (+1)
  Digit5: { offset: 18, label: "5" }, // F# (+1)
  KeyT: { offset: 19, label: "T" }, // G (+1)
  Digit6: { offset: 20, label: "6" }, // G# (+1)
  KeyY: { offset: 21, label: "Y" }, // A (+1)
  Digit7: { offset: 22, label: "7" }, // A# (+1)
  KeyU: { offset: 23, label: "U" }, // B (+1)
  KeyI: { offset: 24, label: "I" }, // C (+2)
  Digit9: { offset: 25, label: "9" }, // C# (+2)
  KeyO: { offset: 26, label: "O" }, // D (+2)
  Digit0: { offset: 27, label: "0" }, // D# (+2)
  KeyP: { offset: 28, label: "P" }, // E (+2)
  BracketLeft: { offset: 29, label: "[" }, // F (+2)
  Equal: { offset: 30, label: "=" }, // F# (+2)
  BracketRight: { offset: 31, label: "]" }, // G (+2)
};

const COMBINED_KEY_MAP = { ...LOWER_ROW_KEYS, ...UPPER_ROW_KEYS };

// Pitch names within an octave
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const IS_BLACK_KEY = [false, true, false, true, false, false, true, false, true, false, true, false];

// Map offset to key label for piano key display
function getKeyBadge(offset: number): string | null {
  // Check lower row first, then upper row
  for (const [_, item] of Object.entries(LOWER_ROW_KEYS)) {
    if (item.offset === offset) return item.label;
  }
  for (const [_, item] of Object.entries(UPPER_ROW_KEYS)) {
    if (item.offset === offset) return item.label;
  }
  return null;
}

export function VirtualMidiKeyboard({
  isOpen,
  onClose,
  state,
}: {
  isOpen: boolean;
  onClose: () => void;
  state: WebUiState;
}) {
  const [octave, setOctave] = useState<number>(() => {
    const saved = localStorage.getItem("resostage:virtual-keyboard-octave");
    return saved ? Math.max(1, Math.min(7, parseInt(saved, 10))) : 4;
  });

  const [velocity, setVelocity] = useState<number>(() => {
    const saved = localStorage.getItem("resostage:virtual-keyboard-velocity");
    return saved ? Math.max(1, Math.min(127, parseInt(saved, 10))) : 100;
  });

  const [activeNotes, setActiveNotes] = useState<Set<number>>(new Set());
  const activeKeysRef = useRef<Map<string, number>>(new Map()); // code -> midiNote
  const mouseDownNotesRef = useRef<Set<number>>(new Set());

  // Window position & drag capability
  const [position, setPosition] = useState<{ x: number; y: number } | null>(() => {
    try {
      const saved = localStorage.getItem("resostage:virtual-keyboard-pos");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.x === "number" && typeof parsed.y === "number") {
          return parsed;
        }
      }
    } catch {}
    return null;
  });

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ startX: number; startY: number; initX: number; initY: number }>({
    startX: 0,
    startY: 0,
    initX: 0,
    initY: 0,
  });
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerDownHeader = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input")) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    isDraggingRef.current = true;
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initX: rect.left,
      initY: rect.top,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMoveHeader = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.startX;
    const dy = e.clientY - dragStartRef.current.startY;
    const newX = Math.max(10, Math.min(window.innerWidth - 300, dragStartRef.current.initX + dx));
    const newY = Math.max(10, Math.min(window.innerHeight - 80, dragStartRef.current.initY + dy));
    const pos = { x: Math.round(newX), y: Math.round(newY) };
    setPosition(pos);
    localStorage.setItem("resostage:virtual-keyboard-pos", JSON.stringify(pos));
  };

  const handlePointerUpHeader = (e: React.PointerEvent) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
    }
  };

  const handleResetPosition = () => {
    setPosition(null);
    localStorage.removeItem("resostage:virtual-keyboard-pos");
  };

  // Base MIDI note for current octave (C4 = 60)
  const baseNote = (octave + 1) * 12;

  // Persist settings
  useEffect(() => {
    localStorage.setItem("resostage:virtual-keyboard-octave", String(octave));
  }, [octave]);

  useEffect(() => {
    localStorage.setItem("resostage:virtual-keyboard-velocity", String(velocity));
  }, [velocity]);

  // Target track: find instrument tracks
  const instrumentTracks = useMemo(() => {
    return state.tracks.filter((t) => t.kind === "instrument");
  }, [state.tracks]);

  // Selected or active instrument track
  const activeInstrument = useMemo(() => {
    return (
      instrumentTracks.find((t) => t.recordArmed || t.inputMonitoring) ??
      instrumentTracks[0] ??
      null
    );
  }, [instrumentTracks]);

  const activeInstrumentIndex = useMemo(() => {
    if (!activeInstrument) return -1;
    return state.tracks.findIndex((t) => t.id === activeInstrument.id);
  }, [state.tracks, activeInstrument]);

  // Helper to trigger Note On
  const triggerNoteOn = useCallback(
    (note: number, vel: number) => {
      sendLiveMidi(0x90, note, vel);
      setActiveNotes((prev) => {
        const next = new Set(prev);
        next.add(note);
        return next;
      });
    },
    [],
  );

  // Helper to trigger Note Off
  const triggerNoteOff = useCallback(
    (note: number) => {
      sendLiveMidi(0x80, note, 0);
      setActiveNotes((prev) => {
        const next = new Set(prev);
        next.delete(note);
        return next;
      });
    },
    [],
  );

  // Release all active notes cleanly
  const releaseAllNotes = useCallback(() => {
    activeKeysRef.current.forEach((note) => {
      sendLiveMidi(0x80, note, 0);
    });
    activeKeysRef.current.clear();

    mouseDownNotesRef.current.forEach((note) => {
      sendLiveMidi(0x80, note, 0);
    });
    mouseDownNotesRef.current.clear();

    setActiveNotes(new Set());
  }, []);

  // When changing octave, release active notes so none stay stuck
  const changeOctave = useCallback(
    (newOctave: number) => {
      const clamped = Math.max(1, Math.min(7, newOctave));
      if (clamped === octave) return;
      releaseAllNotes();
      setOctave(clamped);
    },
    [octave, releaseAllNotes],
  );

  // Physical keyboard listeners - ONLY registered when isOpen === true!
  useEffect(() => {
    if (!isOpen) {
      releaseAllNotes();
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Do not hijack typing if focused inside an input or editable field
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.tagName === "SELECT" ||
          activeEl.isContentEditable)
      ) {
        return;
      }

      // Ignore OS key repeats to prevent re-triggering note on
      if (e.repeat) return;

      // Octave controls via physical keyboard: Minus / NumpadSubtract, Plus / NumpadAdd
      if (e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        changeOctave(octave - 1);
        return;
      }
      if (e.code === "Equal" && !e.shiftKey) {
        // Equal without shift is often the same key as +
        // Note: Equal is also used for F# in upper row, so check if not mapped or use Numpad
      }
      if (e.code === "NumpadAdd") {
        e.preventDefault();
        changeOctave(octave + 1);
        return;
      }

      const mapping = COMBINED_KEY_MAP[e.code];
      if (!mapping) return;

      e.preventDefault();
      e.stopPropagation();

      const note = baseNote + mapping.offset;
      if (note < 0 || note > 127) return;

      activeKeysRef.current.set(e.code, note);
      triggerNoteOn(note, velocity);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (activeKeysRef.current.has(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        const note = activeKeysRef.current.get(e.code)!;
        activeKeysRef.current.delete(e.code);
        triggerNoteOff(note);
      }
    };

    const handleBlur = () => {
      releaseAllNotes();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      releaseAllNotes();
    };
  }, [isOpen, baseNote, velocity, octave, changeOctave, triggerNoteOn, triggerNoteOff, releaseAllNotes]);

  // Construct piano keys for 32 semitones (from offset 0 up to 31, ~2.6 octaves)
  const keysData = useMemo(() => {
    const keys: Array<{
      offset: number;
      note: number;
      name: string;
      isBlack: boolean;
      badge: string | null;
      whiteIndex: number;
    }> = [];

    let whiteCount = 0;
    for (let offset = 0; offset <= 31; offset++) {
      const note = baseNote + offset;
      const semitone = (note % 12);
      const isBlack = IS_BLACK_KEY[semitone];
      const octNum = Math.floor(note / 12) - 1;
      const name = `${NOTE_NAMES[semitone]}${octNum}`;
      const badge = getKeyBadge(offset);

      keys.push({
        offset,
        note,
        name,
        isBlack,
        badge,
        whiteIndex: isBlack ? whiteCount - 1 : whiteCount++,
      });
    }
    return { keys, totalWhiteKeys: whiteCount };
  }, [baseNote]);

  // Mouse handlers for on-screen piano keys
  const handleKeyMouseDown = (note: number) => {
    mouseDownNotesRef.current.add(note);
    triggerNoteOn(note, velocity);
  };

  const handleKeyMouseUp = (note: number) => {
    mouseDownNotesRef.current.delete(note);
    triggerNoteOff(note);
  };

  const handleKeyMouseEnter = (note: number, e: React.MouseEvent) => {
    if (e.buttons === 1 && !mouseDownNotesRef.current.has(note)) {
      mouseDownNotesRef.current.add(note);
      triggerNoteOn(note, velocity);
    }
  };

  const handleKeyMouseLeave = (note: number) => {
    if (mouseDownNotesRef.current.has(note)) {
      mouseDownNotesRef.current.delete(note);
      triggerNoteOff(note);
    }
  };

  if (!isOpen) return null;

  const whiteKeys = keysData.keys.filter((k) => !k.isBlack);
  const blackKeys = keysData.keys.filter((k) => k.isBlack);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Virtual MIDI Keyboard"
      style={
        position
          ? {
              left: `${position.x}px`,
              top: `${position.y}px`,
              transform: "none",
              bottom: "auto",
            }
          : undefined
      }
      className={`fixed ${
        position ? "" : "bottom-9 left-1/2 -translate-x-1/2"
      } z-40 flex flex-col w-[96vw] max-w-[680px] rounded-2xl border border-default/40 bg-surface/95 backdrop-blur-xl shadow-2xl p-2.5 text-xs select-none transition-all duration-75 animate-in fade-in`}
    >
      {/* Header bar */}
      <div
        onPointerDown={handlePointerDownHeader}
        onPointerMove={handlePointerMoveHeader}
        onPointerUp={handlePointerUpHeader}
        onDoubleClick={handleResetPosition}
        title="Drag to reposition · Double-click to reset"
        className="flex flex-wrap items-center justify-between gap-2 border-b border-default/20 pb-2 mb-2 cursor-grab active:cursor-grabbing"
      >
        <div className="flex items-center gap-1.5">
          <GripVertical size={14} className="text-foreground/30 hover:text-foreground/60 shrink-0" />
          <div className="flex items-center gap-1.5 font-semibold text-foreground">
            <Keyboard size={16} className="text-emerald-400" />
            <span>Musical Typing</span>
          </div>

          {/* Active target track info & quick arm */}
          {activeInstrument && activeInstrumentIndex >= 0 ? (
            <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-lg bg-default/20 border border-default/30">
              <span className="text-[10px] text-foreground/50 uppercase font-mono">Track:</span>
              <span className="text-xs font-semibold text-emerald-300 max-w-[110px] truncate">
                {activeInstrument.name}
              </span>
              <button
                type="button"
                onClick={() =>
                  void mixer.setTrackRecordArm(
                    activeInstrumentIndex,
                    !activeInstrument.recordArmed,
                  )
                }
                title={activeInstrument.recordArmed ? "Armed for record/input" : "Click to Record Arm"}
                className={`flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold transition-colors ${
                  activeInstrument.recordArmed
                    ? "bg-red-500 text-white shadow-[0_0_8px_rgba(239,68,68,0.7)]"
                    : "bg-default/30 text-foreground/50 hover:bg-default/50"
                }`}
              >
                R
              </button>
              <button
                type="button"
                onClick={() =>
                  void mixer.setTrackInputMonitor(
                    activeInstrumentIndex,
                    !activeInstrument.inputMonitoring,
                  )
                }
                title={activeInstrument.inputMonitoring ? "Input Monitoring Active" : "Click to Monitor Input"}
                className={`flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold transition-colors ${
                  activeInstrument.inputMonitoring
                    ? "bg-amber-500 text-neutral-950 shadow-[0_0_8px_rgba(245,158,11,0.7)]"
                    : "bg-default/30 text-foreground/50 hover:bg-default/50"
                }`}
              >
                I
              </button>
            </div>
          ) : (
            <span className="ml-2 text-[10px] text-amber-400/80 font-mono">
              (No instrument track armed)
            </span>
          )}
        </div>

        {/* Controls: Octave & Velocity & Close */}
        <div className="flex items-center gap-3">
          {/* Octave Controls */}
          <div className="flex items-center gap-1 bg-default/20 border border-default/30 rounded-lg px-1.5 py-0.5">
            <span className="text-[10px] font-mono text-foreground/50 uppercase mr-1">Oct</span>
            <button
              type="button"
              disabled={octave <= 1}
              onClick={() => changeOctave(octave - 1)}
              title="Octave Down (Minus key)"
              className="flex h-5 w-5 items-center justify-center rounded bg-default/30 hover:bg-default/60 disabled:opacity-30 disabled:cursor-default"
            >
              <Minus size={12} />
            </button>
            <span className="font-mono text-xs font-bold text-accent px-1 min-w-[28px] text-center">
              C{octave}
            </span>
            <button
              type="button"
              disabled={octave >= 7}
              onClick={() => changeOctave(octave + 1)}
              title="Octave Up (Numpad +)"
              className="flex h-5 w-5 items-center justify-center rounded bg-default/30 hover:bg-default/60 disabled:opacity-30 disabled:cursor-default"
            >
              <Plus size={12} />
            </button>
          </div>

          {/* Velocity slider */}
          <div className="flex items-center gap-1.5 bg-default/20 border border-default/30 rounded-lg px-2 py-0.5">
            <Volume2 size={12} className="text-foreground/50 shrink-0" />
            <input
              type="range"
              min="1"
              max="127"
              value={velocity}
              onChange={(e) => setVelocity(parseInt(e.target.value, 10))}
              title={`Velocity: ${velocity}`}
              className="w-16 h-1 accent-emerald-400 cursor-pointer"
            />
            <span className="font-mono text-[10px] text-foreground/70 w-6 text-right">
              {velocity}
            </span>
          </div>

          {/* Dock reset button (visible only when dragged) */}
          {position && (
            <button
              type="button"
              onClick={handleResetPosition}
              title="Reset position to bottom center"
              className="flex h-6 w-6 items-center justify-center rounded-lg hover:bg-default/30 text-foreground/40 hover:text-foreground transition-colors"
            >
              <RotateCcw size={13} />
            </button>
          )}

          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            title="Close Musical Typing (Esc / Cmd+K)"
            className="flex h-6 w-6 items-center justify-center rounded-lg hover:bg-default/30 text-foreground/60 hover:text-foreground transition-colors"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Piano Keyboard Canvas */}
      <div className="relative w-full h-28 sm:h-32 bg-neutral-950/80 rounded-xl p-1 overflow-hidden select-none touch-none shadow-inner border border-neutral-800">
        {/* White keys container */}
        <div className="flex h-full w-full">
          {whiteKeys.map((k) => {
            const isPressed = activeNotes.has(k.note);
            const isC = k.offset % 12 === 0;
            return (
              <button
                key={k.note}
                type="button"
                onMouseDown={() => handleKeyMouseDown(k.note)}
                onMouseUp={() => handleKeyMouseUp(k.note)}
                onMouseEnter={(e) => handleKeyMouseEnter(k.note, e)}
                onMouseLeave={() => handleKeyMouseLeave(k.note)}
                className={`relative flex-1 h-full mx-px rounded-b-md border transition-all duration-75 flex flex-col justify-between items-center pb-1.5 pt-1 cursor-pointer select-none ${
                  isPressed
                    ? "!bg-amber-400 !text-neutral-950 border-amber-500 shadow-[0_0_14px_rgba(251,191,36,0.8)] z-0"
                    : isC
                      ? "bg-neutral-100 text-neutral-800 border-neutral-300 hover:bg-neutral-200"
                      : "bg-neutral-200 text-neutral-700 border-neutral-300 hover:bg-neutral-100"
                }`}
              >
                {/* Upper key badge */}
                <span
                  className={`text-[9px] font-bold font-mono px-1 rounded ${
                    isPressed
                      ? "bg-neutral-950/20 text-neutral-950"
                      : "bg-neutral-300/60 text-neutral-600"
                  }`}
                >
                  {k.badge || ""}
                </span>

                {/* Bottom note name */}
                <span
                  className={`text-[9px] font-mono font-semibold ${
                    isPressed
                      ? "text-neutral-950 font-bold"
                      : isC
                        ? "text-blue-600 font-bold"
                        : "text-neutral-500"
                  }`}
                >
                  {k.name}
                </span>
              </button>
            );
          })}
        </div>

        {/* Black keys overlaid on top */}
        {blackKeys.map((k) => {
          const isPressed = activeNotes.has(k.note);
          const totalWhites = keysData.totalWhiteKeys;
          // Black key is positioned between whiteIndex and whiteIndex + 1
          const leftPercent = ((k.whiteIndex + 1) / totalWhites) * 100;

          return (
            <button
              key={k.note}
              type="button"
              onMouseDown={() => handleKeyMouseDown(k.note)}
              onMouseUp={() => handleKeyMouseUp(k.note)}
              onMouseEnter={(e) => handleKeyMouseEnter(k.note, e)}
              onMouseLeave={() => handleKeyMouseLeave(k.note)}
              style={{
                left: `calc(${leftPercent}% - 0.75rem)`,
                width: "1.5rem",
              }}
              className={`absolute top-1 h-[60%] rounded-b-sm border transition-all duration-75 flex flex-col justify-between items-center pb-1 pt-1 cursor-pointer select-none z-10 ${
                isPressed
                  ? "!bg-amber-500 !text-neutral-950 border-amber-600 shadow-[0_0_14px_rgba(245,158,11,0.9)]"
                  : "bg-neutral-900 text-neutral-200 border-neutral-700 hover:bg-neutral-800 shadow-md"
              }`}
            >
              <span
                className={`text-[8px] font-bold font-mono px-0.5 rounded ${
                  isPressed
                    ? "bg-neutral-950/20 text-neutral-950"
                    : "bg-neutral-800 text-neutral-300"
                }`}
              >
                {k.badge || ""}
              </span>
              <span
                className={`text-[8px] font-mono leading-none ${
                  isPressed ? "text-neutral-950 font-bold" : "text-neutral-400"
                }`}
              >
                {k.name.replace(/^[A-G]/, "")}
              </span>
            </button>
          );
        })}
      </div>

      {/* Footer hint */}
      <div className="flex items-center justify-between mt-1.5 px-1 text-[10px] text-foreground/45 font-mono">
        <span>Keys active only while open · Z-M (low) · Q-P (high)</span>
        <span>Octave: [ - / + ] · Chords supported</span>
      </div>
    </div>
  );
}
