/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import {
  createVirtualKeyboardLayout,
  MUSICAL_TYPING_KEY_MAP,
} from "@/midi/logic/keyboardLayout";

describe("virtual MIDI keyboard layout", () => {
  it("preserves the musical-typing keyboard mapping", () => {
    expect(MUSICAL_TYPING_KEY_MAP.KeyZ).toEqual({ offset: 0, label: "Z" });
    expect(MUSICAL_TYPING_KEY_MAP.KeyQ).toEqual({ offset: 12, label: "Q" });
    expect(MUSICAL_TYPING_KEY_MAP.Digit2).toEqual({ offset: 13, label: "2" });
  });

  it("builds a chromatic 32-key strip with correct piano-key geometry", () => {
    const layout = createVirtualKeyboardLayout(60);
    expect(layout.keys).toHaveLength(32);
    expect(layout.totalWhiteKeys).toBe(19);
    expect(layout.keys[0]).toMatchObject({
      offset: 0,
      note: 60,
      name: "C4",
      isBlack: false,
      badge: "Z",
      whiteIndex: 0,
    });
    expect(layout.keys[1]).toMatchObject({
      offset: 1,
      note: 61,
      name: "C#4",
      isBlack: true,
      badge: "S",
      whiteIndex: 0,
    });
    expect(layout.keys[31]).toMatchObject({
      offset: 31,
      note: 91,
      name: "G6",
      isBlack: false,
      badge: "]",
      whiteIndex: 18,
    });
  });
});
