/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { chooseAudioRenderDirectory } from "@/audioRenderDirectory.js";

const localSession = { remote: false, backend: "http://127.0.0.1:2899" };
const folder = path.resolve("fixture", "Audio exports – Київ");

describe("Audio render directory selection", () => {
  it("returns the native absolute folder and preserves spaces and Unicode", async () => {
    const picker = vi.fn(async () => ({ canceled: false, filePaths: [folder] }));
    await expect(chooseAudioRenderDirectory(folder, () => localSession, picker))
      .resolves.toBe(folder);
    expect(picker).toHaveBeenCalledWith(folder);
  });

  it("leaves the destination unchanged when the user cancels", async () => {
    await expect(chooseAudioRenderDirectory(undefined, () => localSession,
      async () => ({ canceled: true, filePaths: [] }))).resolves.toBeNull();
  });

  it("never opens a controller folder picker in a remote session", async () => {
    const picker = vi.fn();
    await expect(chooseAudioRenderDirectory(undefined,
      () => ({ remote: true, backend: "http://192.0.2.3:2899" }), picker))
      .rejects.toThrow("remote Core");
    expect(picker).not.toHaveBeenCalled();
  });

  it("rejects a local folder when the session switches to remote while the dialog is open", async () => {
    let session = localSession;
    await expect(chooseAudioRenderDirectory(undefined, () => session, async () => {
      session = { remote: true, backend: "http://192.0.2.3:2899" };
      return { canceled: false, filePaths: [folder] };
    })).rejects.toThrow("active Core changed");
  });

  it("rejects a destination selected for another local Core", async () => {
    let session = localSession;
    await expect(chooseAudioRenderDirectory(undefined, () => session, async () => {
      session = { remote: false, backend: "http://127.0.0.1:2900" };
      return { canceled: false, filePaths: [folder] };
    })).rejects.toThrow("active Core changed");
  });

  it("rejects malformed initial paths before opening the dialog", async () => {
    for (const invalid of [42, "relative/folder", `${folder}\0suffix`]) {
      const picker = vi.fn();
      await expect(chooseAudioRenderDirectory(invalid, () => localSession, picker))
        .rejects.toThrow();
      expect(picker).not.toHaveBeenCalled();
    }
  });
});
