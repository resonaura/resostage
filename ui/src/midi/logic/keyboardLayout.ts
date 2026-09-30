// FL Studio / Logic Pro QWERTY musical-typing keyboard mappings.
// Lower row (base octave).
export const LOWER_ROW_KEYS: Record<string, { offset: number; label: string }> = {
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

// Upper row (+1 octave above lower row).
export const UPPER_ROW_KEYS: Record<string, { offset: number; label: string }> = {
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

export const MUSICAL_TYPING_KEY_MAP = { ...LOWER_ROW_KEYS, ...UPPER_ROW_KEYS };

// Pitch names within an octave.
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

/** Key metadata shared by the physical typing map and the rendered piano. */
export interface VirtualKeyboardKey {
  offset: number;
  note: number;
  name: string;
  isBlack: boolean;
  badge: string | null;
  whiteIndex: number;
}

export interface VirtualKeyboardLayout {
  keys: VirtualKeyboardKey[];
  totalWhiteKeys: number;
}

// Map offset to key label for piano key display.
export function getKeyBadge(offset: number): string | null {
  // Check lower row first, then upper row.
  for (const item of Object.values(LOWER_ROW_KEYS)) {
    if (item.offset === offset) return item.label;
  }
  for (const item of Object.values(UPPER_ROW_KEYS)) {
    if (item.offset === offset) return item.label;
  }
  return null;
}

/** Build the two-octave-plus piano key strip for the selected base note. */
export function createVirtualKeyboardLayout(baseNote: number): VirtualKeyboardLayout {
  const keys: VirtualKeyboardKey[] = [];
  let whiteCount = 0;
  for (let offset = 0; offset <= 31; offset++) {
    const note = baseNote + offset;
    const semitone = note % 12;
    const isBlack = IS_BLACK_KEY[semitone];
    const octave = Math.floor(note / 12) - 1;
    keys.push({
      offset,
      note,
      name: `${NOTE_NAMES[semitone]}${octave}`,
      isBlack,
      badge: getKeyBadge(offset),
      whiteIndex: isBlack ? whiteCount - 1 : whiteCount++,
    });
  }
  return { keys, totalWhiteKeys: whiteCount };
}
