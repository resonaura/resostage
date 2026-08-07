/**
 * CLI Migration Tool for ResoStage Project Files (.rsnraset / project.json)
 * Converts legacy format v1 project files to the current format v2 schema.
 *
 * Usage:
 *   pnpm migrate <path-to-project.json-or-rsnraset>
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

function sendDbToLevel(db) {
  if (!Number.isFinite(db)) return 0;
  return Math.min(100, Math.max(0, Math.pow(10, db / 20) * 100));
}

function extOutTarget(startChannel0Based, channels) {
  const ch1 = startChannel0Based + 1;
  if (channels >= 2) {
    return `audio::out:${ch1},audio::out:${ch1 + 1}`;
  }
  return `audio::out:${ch1}`;
}

export function migrateProjectObject(old) {
  if (old.format && old.format.version >= 2) {
    console.log("Project is already format version 2 or newer.");
    return old;
  }

  const sendsList = [];
  const oldBusses = Array.isArray(old.busses) ? old.busses : [];

  let oldMaster = oldBusses.find((b) => b.id === "main") || {
    name: "Main",
    channels: 2,
    gainDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    output: { startChannel: 0 },
  };

  const busIdMap = new Map();
  let sendIdx = 1;

  for (const b of oldBusses) {
    if (b.id === "main") continue;
    const newSendId = `audio::send:${sendIdx++}`;
    busIdMap.set(b.id, newSendId);

    const startCh = b.output?.startChannel ?? 0;
    const ch = b.channels ?? 1;

    let outputObj = {
      type: "ext-out",
      target: extOutTarget(startCh, ch),
    };

    sendsList.push({
      id: newSendId,
      name: b.name || `Send ${sendIdx - 1}`,
      channels: ch,
      gainDb: b.gainDb ?? 0,
      pan: b.pan ?? 0,
      mute: b.mute ?? false,
      solo: b.solo ?? false,
      output: outputObj,
    });
  }

  const clickSends = Array.isArray(old.builtInClickSends)
    ? old.builtInClickSends.map((s) => ({
        bus: busIdMap.get(s.bus) || s.bus,
        level: sendDbToLevel(s.gainDb ?? 0),
        preFader: Boolean(s.preFader),
        enabled: s.enabled ?? true,
      }))
    : [];

  const click = {
    enabled: old.builtInClickEnabled ?? true,
    name: old.builtInClickName || "Click",
    channels: old.builtInClickMono ? 1 : 2,
    gainDb: old.builtInClickGainDb ?? 0,
    pan: old.builtInClickPan ?? 0,
    mute: false,
    solo: old.builtInClickSolo ?? false,
    output: {
      type: "sends-only",
      target: null,
      sends: clickSends,
    },
  };

  const mainStartCh = oldMaster.output?.startChannel ?? 0;
  const mainCh = oldMaster.channels ?? 2;
  const main = {
    enabled: true,
    name: oldMaster.name || "Main",
    channels: mainCh,
    gainDb: oldMaster.gainDb ?? 0,
    pan: oldMaster.pan ?? 0,
    mute: oldMaster.mute ?? false,
    solo: oldMaster.solo ?? false,
    output: {
      type: "ext-out",
      target: extOutTarget(mainStartCh, mainCh),
    },
  };

  const trackIdMap = new Map();
  const oldTracks = Array.isArray(old.tracks) ? old.tracks : [];
  const tracksList = oldTracks.map((tr, idx) => {
    const newTrackId = `audio::track:${idx + 1}`;
    trackIdMap.set(tr.id, newTrackId);

    const sends = Array.isArray(tr.sends)
      ? tr.sends.map((s) => ({
          bus: busIdMap.get(s.bus) || s.bus,
          level: sendDbToLevel(s.gainDb ?? 0),
          preFader: Boolean(s.preFader),
          enabled: s.enabled ?? true,
        }))
      : [];

    let outputType = "main";
    let outputTarget = "audio::main";

    const oldBus = tr.bus || "";
    if (oldBus === "" || oldBus === "sends-only") {
      outputType = "sends-only";
      outputTarget = null;
    } else if (oldBus.startsWith("direct:")) {
      outputType = "ext-out";
      outputTarget = oldBus.replace(/direct:/g, "audio::out:");
    } else if (oldBus === "main") {
      outputType = "main";
      outputTarget = "audio::main";
    }

    return {
      id: newTrackId,
      name: tr.name || `Track ${idx + 1}`,
      channels: tr.mono ? 1 : 2,
      gainDb: tr.gainDb ?? 0,
      pan: tr.pan ?? 0,
      mute: Boolean(tr.mute),
      solo: Boolean(tr.solo),
      output: {
        type: outputType,
        target: outputTarget,
        sends,
      },
    };
  });

  const oldSongs = Array.isArray(old.songs) ? old.songs : [];
  const songIdMap = new Map();
  const songsList = oldSongs.map((s, sIdx) => {
    const newSongId = `meta::song:${sIdx + 1}`;
    songIdMap.set(s.id, newSongId);

    const regions = Array.isArray(s.regions)
      ? s.regions.map((r) => {
          const newTrkId = trackIdMap.get(r.trackId) || r.trackId;
          return {
            id: r.id,
            trackId: newTrkId,
            startSeconds: r.startSeconds ?? 0,
            durationSeconds: r.durationSeconds ?? 0,
            gainDb: r.gainDb ?? 0,
            source: {
              file: r.file || (r.source ? r.source.file : ""),
              offsetSeconds: r.sourceOffsetSeconds ?? (r.source ? r.source.offsetSeconds : 0),
            },
            fade: {
              inSeconds: r.fadeInSeconds ?? (r.fade ? r.fade.inSeconds : 0),
              outSeconds: r.fadeOutSeconds ?? (r.fade ? r.fade.outSeconds : 0),
              inCurve: r.fadeInCurve ?? (r.fade ? r.fade.inCurve : 0),
              outCurve: r.fadeOutCurve ?? (r.fade ? r.fade.outCurve : 0),
            },
            loop: {
              enabled: Boolean(r.loop?.enabled ?? r.loop),
              lengthSeconds: r.loop?.lengthSeconds ?? 0,
            },
          };
        })
      : [];

    const events = Array.isArray(s.events) ? s.events : [];
    const sections = Array.isArray(s.sections) ? s.sections : [];

    const lightCues = Array.isArray(s.lightCues)
      ? s.lightCues.map((lc) => ({
          id: lc.id,
          trackId: lc.trackId,
          startSeconds: lc.startSeconds ?? 0,
          durationSeconds: lc.durationSeconds ?? 1,
          color: {
            r: lc.colorR ?? (lc.color ? lc.color.r : 255),
            g: lc.colorG ?? (lc.color ? lc.color.g : 255),
            b: lc.colorB ?? (lc.color ? lc.color.b : 255),
          },
          intensity: lc.intensity ?? 1,
          fade: {
            inSeconds: lc.fadeInSeconds ?? (lc.fade ? lc.fade.inSeconds : 0),
            outSeconds: lc.fadeOutSeconds ?? (lc.fade ? lc.fade.outSeconds : 0),
          },
          label: lc.label || null,
          effect: {
            type: lc.effectType || lc.effect?.type || null,
            sourceType: lc.effectSourceType || lc.effect?.sourceType || "bus",
            sourceId: lc.effectSourceId || lc.effect?.sourceId || null,
            intensity: lc.effectIntensity ?? lc.effect?.intensity ?? 0.8,
            tempoSync: Boolean(lc.tempoSync ?? lc.effect?.tempoSync),
            tempoSubdivision: lc.tempoSubdiv || lc.effect?.tempoSubdivision || "1/4",
            rateHz: lc.effectRateHz ?? lc.effect?.rateHz ?? 2,
          },
          gradient: {
            preset: lc.gradientPreset || lc.gradient?.preset || "solid",
            colors: lc.gradientColors || lc.gradient?.colors || null,
          },
          blendMode: lc.blendMode || "normal",
        }))
      : [];

    return {
      id: newSongId,
      name: s.name || `Song ${sIdx + 1}`,
      bpm: s.bpm ?? 120,
      timeSignature: {
        numerator: s.timeSignature?.numerator ?? 4,
        denominator: s.timeSignature?.denominator ?? 4,
      },
      playbackMode: s.playbackMode || "autoplayNext",
      regions,
      events,
      sections,
      lightCues,
    };
  });

  let lighting = {
    enabled: old.lighting?.enabled ?? false,
    kind: old.lighting?.kind || "none",
    resoLight: {
      columns: old.lighting?.resoLightColumns ?? old.lighting?.resoLight?.columns ?? 2,
      rows: old.lighting?.resoLightRows ?? old.lighting?.resoLight?.rows ?? 1,
    },
    idle: {
      behavior: old.lighting?.idleBehavior || old.lighting?.idle?.behavior || "holdLast",
      color: {
        r: old.lighting?.idleColorR ?? old.lighting?.idle?.color?.r ?? 0,
        g: old.lighting?.idleColorG ?? old.lighting?.idle?.color?.g ?? 0,
        b: old.lighting?.idleColorB ?? old.lighting?.idle?.color?.b ?? 0,
      },
      intensity: old.lighting?.idleIntensity ?? old.lighting?.idle?.intensity ?? 1,
      effect: {
        type: old.lighting?.idleEffectType || old.lighting?.idle?.effect?.type || "none",
        rateHz: old.lighting?.idleEffectRateHz ?? old.lighting?.idle?.effect?.rateHz ?? 2,
      },
      gradient: {
        preset: old.lighting?.idleGradientPreset || old.lighting?.idle?.gradient?.preset || "solid",
        colors: old.lighting?.idleGradientColors || old.lighting?.idle?.gradient?.colors || null,
      },
    },
    defaultRefreshRateHz: old.lighting?.defaultRefreshRateHz ?? 44,
    artNetTargetHost: old.lighting?.artNetTargetHost || "",
    fixtures: Array.isArray(old.lighting?.fixtures)
      ? old.lighting.fixtures.map((fx) => ({
          id: fx.id,
          name: fx.name,
          kind: fx.kind,
          grid: {
            column: fx.gridColumn ?? fx.grid?.column ?? 0,
            row: fx.gridRow ?? fx.grid?.row ?? 0,
          },
          ledCount: fx.ledCount ?? 0,
          addressable: Boolean(fx.addressable),
          position: {
            x: fx.posX ?? fx.position?.x ?? 0,
            y: fx.posY ?? fx.position?.y ?? 0,
            z: fx.posZ ?? fx.position?.z ?? 0,
          },
          rotation: {
            y: fx.rotationYDeg ?? fx.rotation?.y ?? 0,
          },
          mountedHorizontally: Boolean(fx.mountedHorizontally),
          dmx: {
            universe: fx.dmxUniverse ?? fx.dmx?.universe ?? 0,
            startChannel: fx.dmxStartChannel ?? fx.dmx?.startChannel ?? 1,
            channelCount: fx.dmxChannelCount ?? fx.dmx?.channelCount ?? 3,
          },
          shape: fx.shape || "bar",
          matrixColumns: fx.matrixCols ?? fx.matrixColumns ?? 0,
          channelProfile: fx.channelProfile || "rgb",
          tiltDegrees: fx.tiltDeg ?? fx.tiltDegrees ?? 0,
          refreshRateHz: fx.refreshRateHz ?? 0,
          networkHost: fx.networkHost || "",
        }))
      : [],
  };

  const lightTracks = Array.isArray(old.lightTracks) ? old.lightTracks : [];

  const midiMappings = Array.isArray(old.midiMappings) ? old.midiMappings : [];
  const midi = {
    mappings: midiMappings,
  };

  const cycle = {
    active: old.cycle?.active ?? false,
    skip: old.cycle?.skip ?? false,
    startSeconds: old.cycle?.leftSec ?? old.cycle?.startSeconds ?? 0,
    endSeconds: old.cycle?.rightSec ?? old.cycle?.endSeconds ?? 4,
    songIndex: old.cycle?.songIndex ?? -1,
  };

  return {
    format: {
      version: 2,
    },
    name: old.name || "Untitled",
    sampleRate: old.sampleRate || 48000,
    click,
    main,
    sends: sendsList,
    tracks: tracksList,
    songs: songsList,
    lighting,
    lightTracks,
    cycle,
    midi,
  };
}

// CLI runner
if (process.argv[1] && process.argv[1].endsWith("migrate.mjs")) {
  const targetPath = process.argv[2];
  if (!targetPath) {
    console.error("Usage: pnpm migrate <path-to-project.json-or-rsnraset>");
    process.exit(1);
  }

  const absPath = path.resolve(targetPath);
  if (!fs.existsSync(absPath)) {
    console.error(`Error: File or directory not found: ${absPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(absPath);

  if (stat.isDirectory()) {
    const jsonPath = path.join(absPath, "project.json");
    if (!fs.existsSync(jsonPath)) {
      console.error(`Error: project.json not found in directory ${absPath}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const oldObj = JSON.parse(raw);
    const newObj = migrateProjectObject(oldObj);
    fs.writeFileSync(jsonPath, JSON.stringify(newObj, null, 2) + "\n", "utf-8");
    console.log(`✓ Migrated ${jsonPath} to format v2 successfully!`);
  } else if (stat.isFile()) {
    if (absPath.endsWith(".json")) {
      const raw = fs.readFileSync(absPath, "utf-8");
      const oldObj = JSON.parse(raw);
      const newObj = migrateProjectObject(oldObj);
      fs.writeFileSync(absPath, JSON.stringify(newObj, null, 2) + "\n", "utf-8");
      console.log(`✓ Migrated ${absPath} to format v2 successfully!`);
    } else {
      console.error(`Error: Not a valid project directory container or project.json file: ${absPath}`);
      process.exit(1);
    }
  }
}
