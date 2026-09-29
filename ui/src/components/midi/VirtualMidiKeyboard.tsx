import {
  GripVertical,
  Keyboard,
  Minus,
  Plus,
  RotateCcw,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mixer, sendLiveMidi } from "../../lib/state/api";
import type { WebUiState } from "../../lib/state/types";
import { useThemeVersion } from "../../hooks/useThemeVersion";
import { getTrackColor } from "../timeline/constants";
import { getActiveMidiPitches } from "./activeMidiPitches";
import { TrackStateButtons } from "../timeline/TrackStateButtons";
import { Slider } from "../ui";

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
const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];
const IS_BLACK_KEY = [
  false,
  true,
  false,
  true,
  false,
  false,
  true,
  false,
  true,
  false,
  true,
  false,
];

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
  isOpen = true,
  onClose,
  state,
  standalone = false,
}: {
  isOpen?: boolean;
  onClose: () => void;
  state: WebUiState;
  standalone?: boolean;
}) {
  useThemeVersion();
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
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    () => {
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
    },
  );

  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{
    startX: number;
    startY: number;
    initX: number;
    initY: number;
  }>({
    startX: 0,
    startY: 0,
    initX: 0,
    initY: 0,
  });
  const currentPosRef = useRef<{ x: number; y: number } | null>(position);
  const rafIdRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Initialize centered bottom position on mount if none saved
  useEffect(() => {
    if (position === null && typeof window !== "undefined") {
      const defaultWidth = Math.min(680, window.innerWidth * 0.96);
      const defaultHeight = 180;
      const x = Math.max(
        10,
        Math.round((window.innerWidth - defaultWidth) / 2),
      );
      const y = Math.max(
        10,
        Math.round(window.innerHeight - defaultHeight - 36),
      );
      setPosition({ x, y });
      currentPosRef.current = { x, y };
    }
  }, [position]);

  const handlePointerDownHeader = (e: React.PointerEvent) => {
    if (
      (e.target as HTMLElement).closest(
        "button, input, [role='slider'], .rs-slider",
      )
    )
      return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startX = Math.round(rect.left);
    const startY = Math.round(rect.top);

    isDraggingRef.current = true;
    setIsDragging(true);
    setPosition({ x: startX, y: startY });
    currentPosRef.current = { x: startX, y: startY };

    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initX: startX,
      initY: startY,
    };

    el.style.left = `${startX}px`;
    el.style.top = `${startY}px`;
    el.style.bottom = "auto";
    el.style.transform = "none";

    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
  };

  const handlePointerMoveHeader = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const el = containerRef.current;
    const width = el?.offsetWidth || 680;
    const height = el?.offsetHeight || 180;
    const minX = 8;
    const maxX = Math.max(8, window.innerWidth - width - 8);
    const minY = 8;
    const maxY = Math.max(8, window.innerHeight - height - 8);

    const dx = e.clientX - dragStartRef.current.startX;
    const dy = e.clientY - dragStartRef.current.startY;
    const newX = Math.max(
      minX,
      Math.min(maxX, dragStartRef.current.initX + dx),
    );
    const newY = Math.max(
      minY,
      Math.min(maxY, dragStartRef.current.initY + dy),
    );
    const roundX = Math.round(newX);
    const roundY = Math.round(newY);
    currentPosRef.current = { x: roundX, y: roundY };

    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (containerRef.current && currentPosRef.current) {
          containerRef.current.style.left = `${currentPosRef.current.x}px`;
          containerRef.current.style.top = `${currentPosRef.current.y}px`;
        }
      });
    }
  };

  const handlePointerUpHeader = (e: React.PointerEvent) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      setIsDragging(false);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (currentPosRef.current) {
        setPosition(currentPosRef.current);
        localStorage.setItem(
          "resostage:virtual-keyboard-pos",
          JSON.stringify(currentPosRef.current),
        );
      }
    }
  };

  const handleResetPosition = () => {
    localStorage.removeItem("resostage:virtual-keyboard-pos");
    const defaultWidth = Math.min(680, window.innerWidth * 0.96);
    const defaultHeight = 180;
    const x = Math.max(10, Math.round((window.innerWidth - defaultWidth) / 2));
    const y = Math.max(10, Math.round(window.innerHeight - defaultHeight - 36));
    setPosition({ x, y });
    currentPosRef.current = { x, y };
    if (containerRef.current) {
      containerRef.current.style.left = `${x}px`;
      containerRef.current.style.top = `${y}px`;
      containerRef.current.style.transform = "none";
      containerRef.current.style.bottom = "auto";
    }
  };

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // Base MIDI note for current octave (C4 = 60)
  const baseNote = (octave + 1) * 12;

  // Persist settings
  useEffect(() => {
    localStorage.setItem("resostage:virtual-keyboard-octave", String(octave));
  }, [octave]);

  useEffect(() => {
    localStorage.setItem(
      "resostage:virtual-keyboard-velocity",
      String(velocity),
    );
  }, [velocity]);

  // Musical Typing follows Core's focused track. This keeps the floating and
  // standalone keyboards on the same target as the timeline and Piano Roll.
  const instrumentTracks = useMemo(() => {
    return state.tracks.filter(
      (t) =>
        t.kind === "instrument" ||
        t.kind === "midi" ||
        t.kind === "externalMidi",
    );
  }, [state.tracks]);

  const activeInstrument = useMemo(() => {
    const focused = instrumentTracks.find((t) => t.id === state.activeTrackId);
    if (focused) return focused;
    // Never silently play a different instrument while an audio/non-MIDI
    // track is the actual focused track.
    if (state.activeTrackId) return null;
    return (
      instrumentTracks.find((t) => t.recordArmed || t.inputMonitoring) ??
      instrumentTracks[0] ??
      null
    );
  }, [instrumentTracks, state.activeTrackId]);

  const activeInstrumentIndex = useMemo(() => {
    if (!activeInstrument) return -1;
    return state.tracks.findIndex((t) => t.id === activeInstrument.id);
  }, [state.tracks, activeInstrument]);
  const activeTrackColor =
    activeInstrumentIndex >= 0 ? getTrackColor(activeInstrumentIndex) : "#0485f7";
  const visibleActiveNotes = useMemo(
    () =>
      new Set([
        ...activeNotes,
        ...(activeInstrument
          ? getActiveMidiPitches(state, activeInstrument.id)
          : []),
      ]),
    [activeNotes, state, activeInstrument],
  );

  // Track has instrument plugin loaded
  const hasInstrumentPlugin = useMemo(() => {
    if (!activeInstrument) return false;
    return (
      activeInstrument.plugins?.some((p) => p.instrument && !p.bypassed) ??
      false
    );
  }, [activeInstrument]);

  const [isSustainDown, setIsSustainDown] = useState(false);
  const isSustainDownRef = useRef(false);

  // Keep latest refs for all dynamic values so keyboard listeners remain stable
  const activeInstrumentIndexRef = useRef(activeInstrumentIndex);
  activeInstrumentIndexRef.current = activeInstrumentIndex;
  const previousInstrumentIndexRef = useRef(activeInstrumentIndex);

  useEffect(() => {
    const previousIndex = previousInstrumentIndexRef.current;
    if (previousIndex === activeInstrumentIndex) return;

    const previousTarget = previousIndex >= 0 ? previousIndex : undefined;
    activeKeysRef.current.forEach((note) => {
      sendLiveMidi(0x80, note, 0, previousTarget);
    });
    mouseDownNotesRef.current.forEach((note) => {
      sendLiveMidi(0x80, note, 0, previousTarget);
    });
    if (isSustainDownRef.current) sendLiveMidi(0xb0, 64, 0, previousTarget);

    activeKeysRef.current.clear();
    mouseDownNotesRef.current.clear();
    isSustainDownRef.current = false;
    setIsSustainDown(false);
    setActiveNotes(new Set());
    previousInstrumentIndexRef.current = activeInstrumentIndex;
  }, [activeInstrumentIndex]);

  const baseNoteRef = useRef(baseNote);
  baseNoteRef.current = baseNote;

  const velocityRef = useRef(velocity);
  velocityRef.current = velocity;

  const octaveRef = useRef(octave);
  octaveRef.current = octave;

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Helper to trigger Note On
  const triggerNoteOn = useCallback((note: number, vel: number) => {
    const targetIdx =
      activeInstrumentIndexRef.current >= 0
        ? activeInstrumentIndexRef.current
        : undefined;
    sendLiveMidi(0x90, note, vel, targetIdx);
    setActiveNotes((prev) => {
      const next = new Set(prev);
      next.add(note);
      return next;
    });
  }, []);

  // Helper to trigger Note Off
  const triggerNoteOff = useCallback((note: number) => {
    const targetIdx =
      activeInstrumentIndexRef.current >= 0
        ? activeInstrumentIndexRef.current
        : undefined;
    sendLiveMidi(0x80, note, 0, targetIdx);
    setActiveNotes((prev) => {
      const next = new Set(prev);
      next.delete(note);
      return next;
    });
  }, []);

  // Release all active notes cleanly
  const releaseAllNotes = useCallback(() => {
    let hadNotes = false;
    const targetIdx =
      activeInstrumentIndexRef.current >= 0
        ? activeInstrumentIndexRef.current
        : undefined;
    if (activeKeysRef.current.size > 0) {
      activeKeysRef.current.forEach((note) => {
        sendLiveMidi(0x80, note, 0, targetIdx);
      });
      activeKeysRef.current.clear();
      hadNotes = true;
    }

    if (mouseDownNotesRef.current.size > 0) {
      mouseDownNotesRef.current.forEach((note) => {
        sendLiveMidi(0x80, note, 0, targetIdx);
      });
      mouseDownNotesRef.current.clear();
      hadNotes = true;
    }

    if (isSustainDownRef.current) {
      isSustainDownRef.current = false;
      setIsSustainDown(false);
      sendLiveMidi(0xB0, 64, 0, targetIdx);
    }

    if (hadNotes) {
      setActiveNotes(new Set());
    }
  }, []);

  // When changing octave, release active notes so none stay stuck
  const changeOctave = useCallback(
    (newOctave: number) => {
      const clamped = Math.max(1, Math.min(7, newOctave));
      if (clamped === octaveRef.current) return;
      releaseAllNotes();
      setOctave(clamped);
    },
    [releaseAllNotes],
  );

  const changeOctaveRef = useRef(changeOctave);
  changeOctaveRef.current = changeOctave;

  // Physical keyboard listeners - registered when isOpen === true or standalone === true
  useEffect(() => {
    if (!isOpen && !standalone) {
      releaseAllNotes();
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Close window on Escape or Cmd+W / Cmd+K
      if (
        e.key === "Escape" ||
        (e.metaKey &&
          (e.key === "k" || e.key === "K" || e.key === "w" || e.key === "W"))
      ) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }

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

      // Tab key functions as Sustain Pedal (damper CC 64: 127 = down, 0 = up)
      if (e.code === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (!isSustainDownRef.current) {
          isSustainDownRef.current = true;
          setIsSustainDown(true);
          const targetIdx =
            activeInstrumentIndexRef.current >= 0
              ? activeInstrumentIndexRef.current
              : undefined;
          sendLiveMidi(0xB0, 64, 127, targetIdx);
        }
        return;
      }

      // Ignore OS key repeats to prevent re-triggering note on
      if (e.repeat) return;

      // Allow other shortcuts with modifiers to pass through
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      // Octave controls via physical keyboard: Minus / NumpadSubtract, Plus / NumpadAdd
      if (e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        changeOctaveRef.current(octaveRef.current - 1);
        return;
      }
      if (e.code === "NumpadAdd") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        changeOctaveRef.current(octaveRef.current + 1);
        return;
      }

      const mapping = COMBINED_KEY_MAP[e.code];
      if (mapping) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const note = baseNoteRef.current + mapping.offset;
        if (note >= 0 && note <= 127) {
          activeKeysRef.current.set(e.code, note);
          triggerNoteOn(note, velocityRef.current);
        }
        return;
      }

      // Suppress un-modified bare shortcuts (song jumping digits 1-9, space, etc.)
      // from firing while musical typing is active
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Release sustain pedal when Tab key is released
      if (e.code === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (isSustainDownRef.current) {
          isSustainDownRef.current = false;
          setIsSustainDown(false);
          const targetIdx =
            activeInstrumentIndexRef.current >= 0
              ? activeInstrumentIndexRef.current
              : undefined;
          sendLiveMidi(0xB0, 64, 0, targetIdx);
        }
        return;
      }

      if (activeKeysRef.current.has(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const note = activeKeysRef.current.get(e.code)!;
        activeKeysRef.current.delete(e.code);
        triggerNoteOff(note);
      }
    };

    const handleBlur = () => {
      releaseAllNotes();
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
      window.removeEventListener("blur", handleBlur);
      releaseAllNotes();
    };
  }, [isOpen, standalone, releaseAllNotes, triggerNoteOn, triggerNoteOff]);

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
      const semitone = note % 12;
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
    if (mouseDownNotesRef.current.has(note)) return;
    mouseDownNotesRef.current.add(note);
    triggerNoteOn(note, velocity);
  };

  const handleKeyMouseUp = (note: number) => {
    if (!mouseDownNotesRef.current.delete(note)) return;
    triggerNoteOff(note);
  };

  const handleKeyMouseEnter = (note: number, e: React.PointerEvent) => {
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

  const releaseMouseNotes = useCallback(() => {
    const held = [...mouseDownNotesRef.current];
    mouseDownNotesRef.current.clear();
    held.forEach((note) => triggerNoteOff(note));
  }, [triggerNoteOff]);

  // Do not capture the pointer on each key: that would break glissando. This
  // window-level release handles mouse/touch lifts that happen off the keys.
  useEffect(() => {
    window.addEventListener("pointerup", releaseMouseNotes, true);
    window.addEventListener("pointercancel", releaseMouseNotes, true);
    return () => {
      window.removeEventListener("pointerup", releaseMouseNotes, true);
      window.removeEventListener("pointercancel", releaseMouseNotes, true);
      releaseMouseNotes();
    };
  }, [releaseMouseNotes]);

  if (!isOpen && !standalone) return null;

  const whiteKeys = keysData.keys.filter((k) => !k.isBlack);
  const blackKeys = keysData.keys.filter((k) => k.isBlack);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Virtual MIDI Keyboard"
      style={
        standalone
          ? undefined
          : position
            ? {
                left: `${position.x}px`,
                top: `${position.y}px`,
              }
            : undefined
      }
      className={
        standalone
          ? "w-full h-full flex flex-col bg-background text-xs select-none p-3 overflow-hidden justify-between border-t border-white/5"
          : `fixed ${
              position ? "" : "bottom-9 left-1/2 -translate-x-1/2"
            } z-40 flex flex-col w-[96vw] max-w-170 rounded-2xl border border-white/10 bg-background-secondary/80 backdrop-blur-2xl p-2.5 text-xs select-none shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_2px_6px_rgba(0,0,0,0.35),0_12px_28px_-4px_rgba(0,0,0,0.55),0_36px_84px_-10px_rgba(0,0,0,0.7)] ${
              isDragging ? "cursor-grabbing select-none" : ""
            }`
      }
    >
      {/* Header bar */}
      <div
        onPointerDown={standalone ? undefined : handlePointerDownHeader}
        onPointerMove={standalone ? undefined : handlePointerMoveHeader}
        onPointerUp={standalone ? undefined : handlePointerUpHeader}
        onDoubleClick={standalone ? undefined : handleResetPosition}
        title={
          standalone
            ? "Musical Typing"
            : "Drag to reposition · Double-click to reset"
        }
        style={
          standalone
            ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
            : undefined
        }
        className={`flex flex-wrap items-center justify-between gap-2 border-b border-default/20 pb-2 mb-2 select-none ${
          standalone ? "" : "cursor-grab active:cursor-grabbing"
        }`}
      >
        <div
          className="flex items-center gap-1.5"
          style={
            standalone
              ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
              : undefined
          }
        >
          {!standalone && (
            <GripVertical
              size={14}
              className="text-foreground/30 hover:text-foreground/60 shrink-0"
            />
          )}
          <div className="flex items-center gap-1.5 font-semibold text-foreground">
            <Keyboard size={16} className="text-accent" />
            <span>Musical Typing</span>
          </div>

          {/* Active target track info & quick arm */}
          {activeInstrument && activeInstrumentIndex >= 0 ? (
            <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-lg bg-default/20 border border-default/30">
              <span className="text-[10px] text-foreground/50 uppercase font-mono">
                Track:
              </span>
              {instrumentTracks.length > 1 ? (
                <select
                  value={activeInstrument.id}
                  onChange={(e) => {
                    const id = e.target.value;
                    releaseAllNotes();
                    const index = state.tracks.findIndex((t) => t.id === id);
                    if (index >= 0) void mixer.setFocusedTrack(index);
                  }}
                  className="bg-transparent text-xs font-semibold max-w-30 truncate outline-none cursor-pointer"
                  style={{ color: activeTrackColor }}
                  title="Switch Target Instrument Track"
                >
                  {instrumentTracks.map((tr) => (
                    <option
                      key={tr.id}
                      value={tr.id}
                      className="bg-background-secondary text-foreground"
                    >
                      {tr.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span
                  className="text-xs font-semibold max-w-27.5 truncate"
                  style={{ color: activeTrackColor }}
                >
                  {activeInstrument.name}
                </span>
              )}
              <TrackStateButtons
                track={activeInstrument}
                index={activeInstrumentIndex}
                focused
                compact
              />
              {!hasInstrumentPlugin && (
                <span
                  className="text-[9px] text-warning/80 font-mono hidden sm:inline ml-1"
                  title="No instrument synth inserted on this track. Add one in the Mixer or Track Header."
                >
                  (No synth)
                </span>
              )}
            </div>
          ) : (
            <span className="ml-2 text-[10px] text-foreground/50 font-mono">
              (No instrument track)
            </span>
          )}
        </div>

        {/* Controls: Octave & Velocity & Close */}
        <div
          className="flex items-center gap-3"
          style={
            standalone
              ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
              : undefined
          }
        >
          {/* Octave Controls */}
          <div className="flex items-center gap-1 bg-default/20 border border-default/30 rounded-lg px-1.5 py-0.5">
            <span className="text-[10px] font-mono text-foreground/50 uppercase mr-1">
              Oct
            </span>
            <button
              type="button"
              disabled={octave <= 1}
              onClick={() => changeOctave(octave - 1)}
              title="Octave Down (Minus key)"
              className="flex h-5 w-5 items-center justify-center rounded bg-default/30 hover:bg-default/60 disabled:opacity-30 disabled:cursor-default text-foreground"
            >
              <Minus size={12} />
            </button>
            <span className="font-mono text-xs font-bold text-accent px-1 min-w-7 text-center">
              C{octave}
            </span>
            <button
              type="button"
              disabled={octave >= 7}
              onClick={() => changeOctave(octave + 1)}
              title="Octave Up (Numpad +)"
              className="flex h-5 w-5 items-center justify-center rounded bg-default/30 hover:bg-default/60 disabled:opacity-30 disabled:cursor-default text-foreground"
            >
              <Plus size={12} />
            </button>
          </div>

          {/* Velocity slider */}
          <div
            className="flex items-center gap-1.5 bg-default/20 border border-default/30 rounded-lg px-2 py-0.5 cursor-pointer"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setVelocity(100);
            }}
            title="Double-click to reset velocity (100)"
          >
            <Zap size={12} className="text-foreground/50 shrink-0" />
            <div className="w-16 sm:w-20 flex items-center">
              <Slider
                aria-label="Note Velocity"
                minValue={1}
                maxValue={127}
                step={1}
                value={velocity}
                onChange={(v) => {
                  const val = Array.isArray(v) ? v[0] : v;
                  if (typeof val === "number") setVelocity(Math.round(val));
                }}
                className="w-full"
              >
                <Slider.Track>
                  <Slider.Fill />
                  <Slider.Thumb />
                </Slider.Track>
              </Slider>
            </div>
            <span className="font-mono text-[10px] text-foreground/70 w-6 text-right tabular-nums">
              {velocity}
            </span>
          </div>

          {/* Sustain pedal (Tab) indicator */}
          <div
            className={`flex items-center gap-1.5 border rounded-lg px-2 py-0.5 text-[10px] font-mono transition-all select-none ${
              isSustainDown
                ? "bg-accent/25 border-accent text-accent font-semibold shadow-[0_0_10px_rgba(255,214,10,0.35)]"
                : "bg-default/20 border-default/30 text-foreground/50"
            }`}
            title="Sustain Pedal (Hold Tab key to sustain notes · CC 64)"
          >
            <span className="font-bold border border-default/30 rounded px-1 text-[9px] bg-default/20 text-foreground/70">
              Tab
            </span>
            <span>Sustain</span>
          </div>

          {/* Dock reset button (visible only when dragged and not in standalone window) */}
          {position && !standalone && (
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
      <div
        className={`relative w-full ${standalone ? "flex-1 min-h-27.5" : "h-28 sm:h-32"} bg-background/90 rounded-xl p-1 overflow-hidden select-none touch-none shadow-inner border border-default/30`}
      >
        {/* White keys container */}
        <div className="flex h-full w-full">
          {whiteKeys.map((k) => {
            const isPressed = visibleActiveNotes.has(k.note);
            const isC = k.offset % 12 === 0;
            return (
              <button
                key={k.note}
                type="button"
                onPointerDown={(e) => {
                  if (e.button === 0) handleKeyMouseDown(k.note);
                }}
                onPointerUp={() => handleKeyMouseUp(k.note)}
                onPointerEnter={(e) => handleKeyMouseEnter(k.note, e)}
                onPointerLeave={() => handleKeyMouseLeave(k.note)}
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
                {k.badge && <span className={`text-[8px] font-mono leading-none ${isPressed ? "text-white/80" : "text-[#171717]/45"}`}>{k.badge}</span>}

                {/* Bottom note name */}
                {isC && <span
                  className={`text-[9px] font-mono font-semibold ${
                    isPressed
                      ? "text-white font-bold"
                      : "text-[#171717]"
                  }`}
                >
                  {k.name}
                </span>}
              </button>
            );
          })}
        </div>

        {/* Black keys overlaid on top */}
        {blackKeys.map((k) => {
          const isPressed = visibleActiveNotes.has(k.note);
          const totalWhites = keysData.totalWhiteKeys;
          // Black key is positioned between whiteIndex and whiteIndex + 1
          const leftPercent = ((k.whiteIndex + 1) / totalWhites) * 100;

          return (
            <button
              key={k.note}
              type="button"
              onPointerDown={(e) => {
                if (e.button === 0) handleKeyMouseDown(k.note);
              }}
              onPointerUp={() => handleKeyMouseUp(k.note)}
              onPointerEnter={(e) => handleKeyMouseEnter(k.note, e)}
              onPointerLeave={() => handleKeyMouseLeave(k.note)}
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
              {k.badge && <span className={`text-[7px] font-mono leading-none ${isPressed ? "text-white/80" : "text-[#f7f7f5]/45"}`}>{k.badge}</span>}
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
