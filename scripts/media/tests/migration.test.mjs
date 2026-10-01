/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { TARGET_FORMAT_VERSION, upgradeFormat9ClickSoloSafe } from "../../migrate.mjs";

test("format 9 upgrade preserves canonical IDs, media and plug-in state", () => {
  const original = {
    format: { version: 9 }, click: { soloSafe: false },
    tracks: [{ id: "audio::track:17", plugins: [{ id: "slot", stateResource: "Plugins/slot.state" }] }],
    songs: [{ regions: [{ source: { file: "Audio/audio.wav", videoFile: "Video/video.mp4" } }] }],
  };
  const upgraded = upgradeFormat9ClickSoloSafe(original);
  assert.equal(TARGET_FORMAT_VERSION, 10);
  assert.equal(upgraded.format.version, 10);
  assert.equal(upgraded.click.soloSafe, true);
  assert.deepEqual(upgraded.tracks, original.tracks);
  assert.deepEqual(upgraded.songs, original.songs);
  assert.equal(original.click.soloSafe, false);
});
