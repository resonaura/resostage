import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, PointerEvent, SetStateAction } from "react";
import { sendLiveMidi } from "@/lib/state/api";
import { MUSICAL_TYPING_KEY_MAP } from "@/midi/logic/keyboardLayout";

/** Owns live MIDI note, sustain, and musical-typing keyboard input lifecycles. */
export function useVirtualKeyboardInput({
  activeTrackIndex,
  isOpen,
  standalone,
  onClose,
  octave,
  setOctave,
  velocity,
}: {
  activeTrackIndex: number;
  isOpen: boolean;
  standalone: boolean;
  onClose: () => void;
  octave: number;
  setOctave: Dispatch<SetStateAction<number>>;
  velocity: number;
}) {
  const [activeNotes, setActiveNotes] = useState<Set<number>>(new Set());
  const [isSustainDown, setIsSustainDown] = useState(false);
  const isSustainDownRef = useRef(false);
  const activeKeysRef = useRef<Map<string, { note: number; trackIndex?: number }>>(
    new Map(),
  );
  const mouseDownNotesRef = useRef<Map<number, number | undefined>>(new Map());

  // Keep latest refs for all dynamic values so keyboard listeners remain stable.
  const activeTrackIndexRef = useRef(activeTrackIndex);
  activeTrackIndexRef.current = activeTrackIndex;
  const previousTrackIndexRef = useRef(activeTrackIndex);
  const baseNoteRef = useRef((octave + 1) * 12);
  baseNoteRef.current = (octave + 1) * 12;
  const velocityRef = useRef(velocity);
  velocityRef.current = velocity;
  const octaveRef = useRef(octave);
  octaveRef.current = octave;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Release notes against the track they were started on before focus changes.
  useEffect(() => {
    const previousIndex = previousTrackIndexRef.current;
    if (previousIndex === activeTrackIndex) return;

    const previousTarget = previousIndex >= 0 ? previousIndex : undefined;
    activeKeysRef.current.forEach(({ note, trackIndex }) => {
      sendLiveMidi(0x80, note, 0, trackIndex ?? previousTarget);
    });
    mouseDownNotesRef.current.forEach((trackIndex, note) => {
      sendLiveMidi(0x80, note, 0, trackIndex ?? previousTarget);
    });
    if (isSustainDownRef.current) sendLiveMidi(0xb0, 64, 0, previousTarget);

    activeKeysRef.current.clear();
    mouseDownNotesRef.current.clear();
    isSustainDownRef.current = false;
    setIsSustainDown(false);
    setActiveNotes(new Set());
    previousTrackIndexRef.current = activeTrackIndex;
  }, [activeTrackIndex]);

  // Helper to trigger Note On.
  const triggerNoteOn = useCallback(
    (
      note: number,
      noteVelocity: number,
      trackIndex = activeTrackIndexRef.current >= 0
        ? activeTrackIndexRef.current
        : undefined,
    ) => {
      sendLiveMidi(0x90, note, noteVelocity, trackIndex);
      setActiveNotes((previous) => {
        const next = new Set(previous);
        next.add(note);
        return next;
      });
    },
    [],
  );

  // Helper to trigger Note Off.
  const triggerNoteOff = useCallback(
    (
      note: number,
      trackIndex = activeTrackIndexRef.current >= 0
        ? activeTrackIndexRef.current
        : undefined,
    ) => {
      sendLiveMidi(0x80, note, 0, trackIndex);
      const remainsHeld =
        mouseDownNotesRef.current.has(note) ||
        [...activeKeysRef.current.values()].some((held) => held.note === note);
      if (remainsHeld) return;
      setActiveNotes((previous) => {
        const next = new Set(previous);
        next.delete(note);
        return next;
      });
    },
    [],
  );

  // Release all active notes cleanly.
  const releaseAllNotes = useCallback(() => {
    const targetIndex =
      activeTrackIndexRef.current >= 0
        ? activeTrackIndexRef.current
        : undefined;
    if (activeKeysRef.current.size > 0) {
      activeKeysRef.current.forEach(({ note, trackIndex }) => {
        sendLiveMidi(0x80, note, 0, trackIndex ?? targetIndex);
      });
      activeKeysRef.current.clear();
    }

    if (mouseDownNotesRef.current.size > 0) {
      mouseDownNotesRef.current.forEach((trackIndex, note) => {
        sendLiveMidi(0x80, note, 0, trackIndex ?? targetIndex);
      });
      mouseDownNotesRef.current.clear();
    }

    if (isSustainDownRef.current) {
      isSustainDownRef.current = false;
      setIsSustainDown(false);
      sendLiveMidi(0xb0, 64, 0, targetIndex);
    }

    setActiveNotes(new Set());
  }, []);

  // When changing octave, release active notes so none stay stuck.
  const changeOctave = useCallback(
    (newOctave: number) => {
      const clamped = Math.max(1, Math.min(7, newOctave));
      if (clamped === octaveRef.current) return;
      releaseAllNotes();
      setOctave(clamped);
    },
    [releaseAllNotes, setOctave],
  );
  const changeOctaveRef = useRef(changeOctave);
  changeOctaveRef.current = changeOctave;

  // Physical keyboard listeners - registered when isOpen === true or standalone === true.
  useEffect(() => {
    if (!isOpen && !standalone) {
      releaseAllNotes();
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Close window on Escape or Cmd+W / Cmd+K.
      if (
        event.key === "Escape" ||
        (event.metaKey &&
          (event.key === "k" || event.key === "K" ||
            event.key === "w" || event.key === "W"))
      ) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }

      // Do not hijack typing if focused inside an input or editable field.
      const activeElement = document.activeElement as HTMLElement | null;
      if (
        activeElement &&
        (activeElement.tagName === "INPUT" ||
          activeElement.tagName === "TEXTAREA" ||
          activeElement.tagName === "SELECT" ||
          activeElement.isContentEditable)
      ) {
        return;
      }

      // Tab key functions as Sustain Pedal (damper CC 64: 127 = down, 0 = up).
      if (event.code === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (!isSustainDownRef.current) {
          isSustainDownRef.current = true;
          setIsSustainDown(true);
          const targetIndex =
            activeTrackIndexRef.current >= 0
              ? activeTrackIndexRef.current
              : undefined;
          sendLiveMidi(0xb0, 64, 127, targetIndex);
        }
        return;
      }

      // Ignore OS key repeats to prevent re-triggering note on.
      if (event.repeat) return;

      // Allow other shortcuts with modifiers to pass through.
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Octave controls via physical keyboard: Minus / NumpadSubtract, Plus / NumpadAdd.
      if (event.code === "Minus" || event.code === "NumpadSubtract") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        changeOctaveRef.current(octaveRef.current - 1);
        return;
      }
      if (event.code === "NumpadAdd") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        changeOctaveRef.current(octaveRef.current + 1);
        return;
      }

      const mapping = MUSICAL_TYPING_KEY_MAP[event.code];
      if (mapping) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const note = baseNoteRef.current + mapping.offset;
        if (note >= 0 && note <= 127 && !activeKeysRef.current.has(event.code)) {
          const trackIndex = activeTrackIndexRef.current >= 0
            ? activeTrackIndexRef.current
            : undefined;
          activeKeysRef.current.set(event.code, { note, trackIndex });
          triggerNoteOn(note, velocityRef.current, trackIndex);
        }
        return;
      }

      // Suppress un-modified bare shortcuts (song jumping digits 1-9, space, etc.)
      // from firing while musical typing is active.
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      // Release sustain pedal when Tab key is released.
      if (event.code === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (isSustainDownRef.current) {
          isSustainDownRef.current = false;
          setIsSustainDown(false);
          const targetIndex =
            activeTrackIndexRef.current >= 0
              ? activeTrackIndexRef.current
              : undefined;
          sendLiveMidi(0xb0, 64, 0, targetIndex);
        }
        return;
      }

      if (activeKeysRef.current.has(event.code)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const held = activeKeysRef.current.get(event.code)!;
        activeKeysRef.current.delete(event.code);
        triggerNoteOff(held.note, held.trackIndex);
      }
    };

    const handleBlur = () => releaseAllNotes();
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

  // Browsers and embedded webviews may omit keyup when the document becomes
  // hidden (for example, switching apps while a typing key is held).
  useEffect(() => {
    const releaseOnHide = () => {
      if (document.visibilityState === "hidden") releaseAllNotes();
    };
    document.addEventListener("visibilitychange", releaseOnHide);
    return () => document.removeEventListener("visibilitychange", releaseOnHide);
  }, [releaseAllNotes]);

  // Mouse handlers for on-screen piano keys.
  const handleKeyMouseDown = useCallback((note: number) => {
    if (mouseDownNotesRef.current.has(note)) return;
    const trackIndex = activeTrackIndexRef.current >= 0
      ? activeTrackIndexRef.current
      : undefined;
    mouseDownNotesRef.current.set(note, trackIndex);
    triggerNoteOn(note, velocityRef.current, trackIndex);
  }, [triggerNoteOn]);

  const handleKeyMouseUp = useCallback((note: number) => {
    if (!mouseDownNotesRef.current.has(note)) return;
    const trackIndex = mouseDownNotesRef.current.get(note);
    mouseDownNotesRef.current.delete(note);
    triggerNoteOff(note, trackIndex);
  }, [triggerNoteOff]);

  const handleKeyMouseEnter = useCallback((
    note: number,
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    if (event.buttons === 1 && !mouseDownNotesRef.current.has(note)) {
      const trackIndex = activeTrackIndexRef.current >= 0
        ? activeTrackIndexRef.current
        : undefined;
      mouseDownNotesRef.current.set(note, trackIndex);
      triggerNoteOn(note, velocityRef.current, trackIndex);
    }
  }, [triggerNoteOn]);

  const handleKeyMouseLeave = useCallback((note: number) => {
    if (mouseDownNotesRef.current.has(note)) {
      const trackIndex = mouseDownNotesRef.current.get(note);
      mouseDownNotesRef.current.delete(note);
      triggerNoteOff(note, trackIndex);
    }
  }, [triggerNoteOff]);

  const releaseMouseNotes = useCallback(() => {
    const held = [...mouseDownNotesRef.current.entries()];
    mouseDownNotesRef.current.clear();
    held.forEach(([note, trackIndex]) => triggerNoteOff(note, trackIndex));
  }, [triggerNoteOff]);

  // Do not capture the pointer on each key: that would break glissando. This
  // window-level release handles mouse/touch lifts that happen off the keys.
  useEffect(() => {
    const releaseIfHidden = () => {
      if (document.visibilityState === "hidden") releaseMouseNotes();
    };
    window.addEventListener("pointerup", releaseMouseNotes, true);
    window.addEventListener("pointercancel", releaseMouseNotes, true);
    window.addEventListener("blur", releaseMouseNotes);
    document.addEventListener("visibilitychange", releaseIfHidden);
    return () => {
      window.removeEventListener("pointerup", releaseMouseNotes, true);
      window.removeEventListener("pointercancel", releaseMouseNotes, true);
      window.removeEventListener("blur", releaseMouseNotes);
      document.removeEventListener("visibilitychange", releaseIfHidden);
      releaseMouseNotes();
    };
  }, [releaseMouseNotes]);

  return {
    activeNotes,
    isSustainDown,
    releaseAllNotes,
    changeOctave,
    handleKeyMouseDown,
    handleKeyMouseUp,
    handleKeyMouseEnter,
    handleKeyMouseLeave,
  };
}
