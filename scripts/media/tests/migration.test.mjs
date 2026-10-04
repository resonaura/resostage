/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TARGET_FORMAT_VERSION,
  upgradeFormat9ClickSoloSafe,
  upgradeFormat10AutomationCurveCache,
  upgradeFormat11PluginSidechains,
  upgradeFormat12MidiClipHeaders,
  upgradeFormat13Midi2ReleaseAttributes,
} from "../../migrate.mjs";

test("format 9 upgrade preserves canonical IDs, media and plug-in state", () => {
  const original = {
    format: { version: 9 }, click: { soloSafe: false },
    tracks: [{ id: "audio::track:17", plugins: [{ id: "slot", stateResource: "Plugins/slot.state" }] }],
    songs: [{ regions: [{ source: { file: "Audio/audio.wav", videoFile: "Video/video.mp4" } }] }],
  };
  const upgraded = upgradeFormat9ClickSoloSafe(original);
  assert.equal(TARGET_FORMAT_VERSION, 14);
  assert.equal(upgraded.format.version, 14);
  assert.equal(upgraded.click.soloSafe, true);
  assert.deepEqual(upgraded.tracks, original.tracks);
  assert.deepEqual(upgraded.songs, original.songs);
  assert.equal(original.click.soloSafe, false);
});

test("format 10 upgrade adds an empty automation cache without changing lanes", () => {
  const original = {
    format: { version: 10 },
    songs: [{
      automationLanes: [{ id: "lane", target: { parameterId: "pan" }, points: [] }],
      automationCurveCache: [{ target: { parameterId: "obsolete" }, points: [] }],
    }],
  };
  const upgraded = upgradeFormat10AutomationCurveCache(original);
  assert.equal(upgraded.format.version, 14);
  assert.deepEqual(upgraded.songs[0].automationLanes, original.songs[0].automationLanes);
  assert.deepEqual(upgraded.songs[0].automationCurveCache, original.songs[0].automationCurveCache);
  assert.deepEqual(upgradeFormat10AutomationCurveCache({ songs: [{}] }).songs[0].automationCurveCache, []);
  assert.equal(original.format.version, 10);
});

test("format 11 upgrade defaults plugin sidechains to disconnected", () => {
  const original = {
    format: { version: 11 },
    main: { plugins: [{ id: "main-slot" }] },
    click: { plugins: [{ id: "click-slot", sidechain: null }] },
    sends: [{ plugins: [{ id: "send-slot" }] }],
    tracks: [{ plugins: [{ id: "track-slot", sidechain: {
      sourceStripId: "audio::track:2", inputBusIndex: 2, channelMode: "left",
    } }] }],
  };
  const upgraded = upgradeFormat11PluginSidechains(original);
  assert.equal(upgraded.format.version, 14);
  assert.equal(upgraded.main.plugins[0].sidechain, null);
  assert.equal(upgraded.click.plugins[0].sidechain, null);
  assert.equal(upgraded.sends[0].plugins[0].sidechain, null);
  assert.deepEqual(upgraded.tracks[0].plugins[0].sidechain,
    original.tracks[0].plugins[0].sidechain);
  assert.equal(original.format.version, 11);
});

test("format 12 upgrade defaults UMP rows to musical sequence and preserves header flags", () => {
  const original = {
    format: { version: 12 },
    songs: [{ midiRegions: [{ umpEvents: [
      { beat: 0.5, words: [0x20c00000], wordCount: 1 },
      { beat: 0, words: [0x3000f07e], wordCount: 2,
        configurationHeader: true, profileConfigurationHeader: true },
      { beat: 0, words: [0x20b00000], wordCount: 1, configurationHeader: true },
    ] }] }],
  };
  const upgraded = upgradeFormat12MidiClipHeaders(original);
  const [sequence, profile, config] = upgraded.songs[0].midiRegions[0].umpEvents;
  assert.equal(upgraded.format.version, 13);
  assert.equal(sequence.configurationHeader, false);
  assert.equal(sequence.profileConfigurationHeader, false);
  assert.equal(profile.configurationHeader, true);
  assert.equal(profile.profileConfigurationHeader, true);
  assert.equal(config.configurationHeader, true);
  assert.equal(config.profileConfigurationHeader, false);
  assert.equal(original.format.version, 12);
  assert.equal(original.songs[0].midiRegions[0].umpEvents[0].configurationHeader, undefined);
});

test("format 13 upgrade defaults separate MIDI 2.0 Note-Off attributes from Note-On data", () => {
  const original = {
    format: { version: 13 },
    songs: [{ midiRegions: [{ notes: [
      { midi2: { group: 2, attributeType: 1, attributeData: 0x1234 } },
      { midi2: { group: 3, attributeType: 2, attributeData: 0x5678,
        releaseAttributeType: 3, releaseAttributeData: 0x9abc } },
      { pitch: 64 },
    ] }] }],
  };
  const upgraded = upgradeFormat13Midi2ReleaseAttributes(original);
  const [legacy, explicit, midi1] = upgraded.songs[0].midiRegions[0].notes;
  assert.equal(upgraded.format.version, TARGET_FORMAT_VERSION);
  assert.equal(legacy.midi2.releaseAttributeType, 1);
  assert.equal(legacy.midi2.releaseAttributeData, 0x1234);
  assert.equal(explicit.midi2.releaseAttributeType, 3);
  assert.equal(explicit.midi2.releaseAttributeData, 0x9abc);
  assert.equal(midi1.midi2, undefined);
  assert.equal(original.format.version, 13);
});

test("the migration CLI upgrades a v13 project without losing MIDI 2.0 note data", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resostage-midi2-migration-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectPath = path.join(directory, "project.rsnrasetmeta");
  fs.writeFileSync(projectPath, `${JSON.stringify({
    format: { version: 13 },
    songs: [{ midiRegions: [{ notes: [{ pitch: 60, midi2: {
      group: 4, velocity: 0x9234, releaseVelocity: 0x4567,
      attributeType: 2, attributeData: 0xabcd,
    } }] }] }],
  })}\n`);

  const migration = spawnSync(process.execPath, [
    new URL("../../migrate.mjs", import.meta.url).pathname,
    projectPath,
  ], { encoding: "utf8" });
  assert.equal(migration.status, 0, migration.stderr);
  const migrated = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  const note = migrated.songs[0].midiRegions[0].notes[0];
  assert.equal(migrated.format.version, TARGET_FORMAT_VERSION);
  assert.equal(note.midi2.velocity, 0x9234);
  assert.equal(note.midi2.releaseVelocity, 0x4567);
  assert.equal(note.midi2.releaseAttributeType, note.midi2.attributeType);
  assert.equal(note.midi2.releaseAttributeData, note.midi2.attributeData);
  assert.ok(fs.existsSync(`${projectPath}.bak`));
});

test("the migration CLI refuses unknown future formats without touching the source", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resostage-future-migration-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectPath = path.join(directory, "project.rsnrasetmeta");
  const source = `${JSON.stringify({ format: { version: TARGET_FORMAT_VERSION + 1 }, payload: "keep" })}\n`;
  fs.writeFileSync(projectPath, source);

  const migration = spawnSync(process.execPath, [
    new URL("../../migrate.mjs", import.meta.url).pathname,
    projectPath,
  ], { encoding: "utf8" });
  assert.equal(migration.status, 1);
  assert.match(migration.stderr, /newer than supported/);
  assert.equal(fs.readFileSync(projectPath, "utf8"), source);
  assert.equal(fs.existsSync(`${projectPath}.bak`), false);
});
