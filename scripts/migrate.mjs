/**
 * One-shot project converter: any older ResoStage project.json -> format v3.
 *
 * This is the ONLY migration path that exists. The engine deliberately has
 * none: ProjectLoader refuses to open anything below kCurrentFormatVersion and
 * points here. The product is pre-public-beta, so carrying a migration chain
 * inside the audio engine would be permanent weight for a problem that only
 * exists on this developer's own machines. When the format freezes, delete
 * this file plus the version gate in ProjectLoader::reparseProject().
 *
 * Accepts BOTH historical shapes as input:
 *   v1  flat legacy      -- busses[], builtInClick..., track.bus "direct:N",
 *                          top-level lightTracks
 *   v2  half-migrated    -- nested output objects, but legacy ids (bar_1, lt_1,
 *                          reg_song_1_trk_4, sec_1), camelCase enum values and
 *                          "" where null belongs
 * and always emits the same v3 canon:
 *
 *   ids            "<ns>::<kind>:<n>"  audio::track:1, audio::send:2,
 *                                      audio::out:11, light::bar:1,
 *                                      light::track:3, meta::song:1
 *   singletons     "<ns>::<kind>"      audio::main
 *   enum values    "<ns>::<value>"     resolight::bar, dmx::generic
 *   churn rows     UUIDv7              regions, light cues, sections
 *   optionals      null, never ""
 *   lighting       fixtures + tracks nested under one `lighting` key
 *   song end       onEnded: "next" | "stop"  (was playbackMode)
 *   dropped        keybindings (now rig-wide AppSettings, not project data)
 *
 * Usage:
 *   pnpm migrate <path-to-.rsnraset-dir-or-project.json>
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const TARGET_FORMAT_VERSION = 3;

// ── primitives ───────────────────────────────────────────────────────────────

/**
 * UUIDv7 (RFC 9562), byte-identical in layout to core/engine/project/Uuid.h so
 * ids minted here and ids minted by the running engine interleave in sort
 * order instead of forming two disjoint clusters.
 */
function uuidV7() {
  const bytes = crypto.randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Already a UUID? Then it was minted by a previous run -- keep it stable. */
function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Preserve an existing UUID, mint one for any legacy hand-built id. */
function stableUuid(existingId) {
  return isUuid(existingId) ? existingId : uuidV7();
}

/** The format has no empty strings: an absent optional is null. */
function orNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** Legacy sends carried dB; the schema stores 0-100 linear percent. */
function sendDbToLevel(db) {
  if (!Number.isFinite(db)) return 0;
  return Math.min(100, Math.max(0, Math.pow(10, db / 20) * 100));
}

/** 0-based physical start channel + width -> canonical ext-out target. */
function extOutTarget(startChannel0Based, channels) {
  const first = Math.max(0, startChannel0Based) + 1; // ids are 1-based
  return channels >= 2
    ? `audio::out:${first},audio::out:${first + 1}`
    : `audio::out:${first}`;
}

// ── id remapping ─────────────────────────────────────────────────────────────

/**
 * Builds old-id -> new-id lookups up front, because ids are referenced from
 * far away in the tree: a region's trackId, a light cue's trackId AND its
 * effect.sourceId, a light track's fixtureIds, every send's `bus`. Renumbering
 * in place (what the previous pass did) left every one of those references
 * dangling at an id that no longer existed.
 */
function buildIdMaps(old) {
  const busIds = new Map(); // "bus_1" | "audio::send:1" -> "audio::send:N"
  const trackIds = new Map();
  const fixtureIds = new Map();
  const lightTrackIds = new Map();

  const legacyBusses = Array.isArray(old.busses) ? old.busses : null;
  const sourceSends = legacyBusses
    ? legacyBusses.filter((b) => b.id !== "main")
    : Array.isArray(old.sends)
      ? old.sends
      : [];
  sourceSends.forEach((b, i) => {
    if (b && typeof b.id === "string") busIds.set(b.id, `audio::send:${i + 1}`);
  });
  // Every historical spelling of the master bus resolves to one canonical id.
  busIds.set("main", "audio::main");
  busIds.set("audio::main", "audio::main");

  (Array.isArray(old.tracks) ? old.tracks : []).forEach((t, i) => {
    if (t && typeof t.id === "string") trackIds.set(t.id, `audio::track:${i + 1}`);
  });

  // One counter across all fixtures, prefix chosen per kind: a ResoLight bar
  // reads light::bar:1, anything else light::fixture:2. Numbers stay unique
  // across kinds so an id alone identifies the fixture.
  const fixtures = Array.isArray(old.lighting?.fixtures) ? old.lighting.fixtures : [];
  fixtures.forEach((f, i) => {
    const isBar = normalizeFixtureKind(f?.kind) === "resolight::bar";
    const id = `${isBar ? "light::bar" : "light::fixture"}:${i + 1}`;
    if (f && typeof f.id === "string") fixtureIds.set(f.id, id);
  });

  const lightTracks = readLightTracks(old);
  lightTracks.forEach((lt, i) => {
    if (lt && typeof lt.id === "string") lightTrackIds.set(lt.id, `light::track:${i + 1}`);
  });

  return { busIds, trackIds, fixtureIds, lightTrackIds };
}

/** Light tracks moved from a top-level list into `lighting.tracks`. */
function readLightTracks(old) {
  if (Array.isArray(old.lighting?.tracks)) return old.lighting.tracks;
  if (Array.isArray(old.lightTracks)) return old.lightTracks;
  return [];
}

// ── enum value normalization ─────────────────────────────────────────────────

function normalizeFixtureKind(kind) {
  if (kind === "dmxGeneric" || kind === "dmx::generic") return "dmx::generic";
  return "resolight::bar";
}

function normalizeLightingKind(kind) {
  if (kind === "resoLight" || kind === "resolight") return "resolight";
  if (kind === "dmxGeneric" || kind === "dmx::generic") return "dmx::generic";
  return "none";
}

function normalizeIdleBehavior(behavior) {
  switch (behavior) {
    case "blackout":
      return "blackout";
    case "staticColor":
    case "static":
      return "static";
    case "effect":
      return "effect";
    default:
      return "hold";
  }
}

function normalizeShape(shape) {
  if (shape === "movingHead" || shape === "moving-head") return "moving-head";
  return typeof shape === "string" && shape !== "" ? shape : "bar";
}

/** Old `playbackMode` (and the even older `mode`) collapse to `onEnded`. */
function normalizeOnEnded(song) {
  const raw = song.onEnded ?? song.playbackMode ?? song.mode;
  return raw === "next" || raw === "autoplayNext" || raw === "auto" ? "next" : "stop";
}

// ── routing ──────────────────────────────────────────────────────────────────

/**
 * A route target in any historical spelling -> the canonical one.
 * "direct:3,direct:4" and "audio::out:3,audio::out:4" are the same pair of
 * mono physical lanes; "" / "sends-only" means no main route at all.
 */
function normalizeRouteTarget(raw, busIds) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "" || value === "sends-only") return { type: "sends-only", target: null };
  if (value === "main" || value === "audio::main") return { type: "main", target: "audio::main" };
  if (value.includes("direct:") || value.includes("audio::out:")) {
    const lanes = value
      .split(",")
      .map((tok) => tok.trim().replace(/^direct:/, "audio::out:"))
      .filter((tok) => tok.startsWith("audio::out:"));
    if (lanes.length > 0) return { type: "ext-out", target: lanes.join(",") };
    return { type: "sends-only", target: null };
  }
  // A bare send-bus id as a main destination (only reachable from very old
  // files). The schema has no "route straight into an aux" output type, so the
  // caller turns this into sends-only + a unity send row -- same audible
  // result, expressible in the current format.
  const mapped = busIds.get(value);
  if (mapped) return { type: "sends-only", target: null, foldIntoSend: mapped };
  return { type: "sends-only", target: null };
}

/** A source's output block, reading either the flat v1 or nested v2 shape. */
function migrateSourceOutput(node, busIds) {
  const legacyRaw = node.bus ?? node.clickBusId;
  const nested = node.output;
  const resolved =
    nested && typeof nested === "object" && typeof nested.type === "string"
      ? normalizeRouteTarget(
          nested.type === "main"
            ? "audio::main"
            : nested.type === "sends-only"
              ? ""
              : (nested.target ?? ""),
          busIds,
        )
      : normalizeRouteTarget(legacyRaw, busIds);
  const { type, target, foldIntoSend } = resolved;

  const rawSends = Array.isArray(nested?.sends)
    ? nested.sends
    : Array.isArray(node.sends)
      ? node.sends
      : [];

  const sends = rawSends
    .map((s) => {
      const bus = busIds.get(s.bus) ?? s.bus;
      // v1 stored send strength in dB, v2+ in 0-100 linear percent.
      const level = s.level !== undefined ? num(s.level, 100) : sendDbToLevel(num(s.gainDb, 0));
      return {
        bus,
        level: Math.min(100, Math.max(0, level)),
        preFader: Boolean(s.preFader),
        enabled: s.enabled ?? true,
      };
    })
    // A send pointing at a bus that no longer exists is dropped rather than
    // silently retargeted at whatever now occupies that slot.
    .filter((s) => typeof s.bus === "string" && s.bus.startsWith("audio::send:"));

  if (foldIntoSend && !sends.some((s) => s.bus === foldIntoSend)) {
    sends.unshift({ bus: foldIntoSend, level: 100, preFader: false, enabled: true });
  }

  return { type, target, sends };
}

/** Master / send-bus destination: never has its own sends. */
function migrateBusRoute(bus, busIds) {
  const nested = bus.output;
  if (nested && typeof nested === "object" && typeof nested.type === "string") {
    if (nested.type === "main") return { type: "main", target: "audio::main" };
    const resolved = normalizeRouteTarget(nested.target ?? "", busIds);
    return resolved.type === "ext-out"
      ? resolved
      : { type: "ext-out", target: extOutTarget(0, num(bus.channels, 2)) };
  }
  // v1: output was { startChannel } and the width came from `channels`.
  const startChannel = num(nested?.startChannel, 0);
  return { type: "ext-out", target: extOutTarget(startChannel, num(bus.channels, 2)) };
}

// ── section migrations ───────────────────────────────────────────────────────

function migrateClick(old, busIds) {
  const legacy = old.builtInClickEnabled !== undefined || old.builtInClickName !== undefined;
  const src = legacy
    ? {
        enabled: old.builtInClickEnabled ?? true,
        name: old.builtInClickName,
        channels: old.builtInClickMono ? 1 : 2,
        gainDb: old.builtInClickGainDb,
        pan: old.builtInClickPan,
        mute: false,
        solo: old.builtInClickSolo,
        bus: old.builtInClickBusId,
        sends: old.builtInClickSends,
      }
    : (old.click ?? {});

  return {
    enabled: src.enabled ?? true,
    name: orNull(src.name) ?? "Click",
    channels: src.channels === 1 ? 1 : 2,
    gainDb: num(src.gainDb, 0),
    pan: num(src.pan, 0),
    mute: Boolean(src.mute),
    solo: Boolean(src.solo),
    output: migrateSourceOutput(src, busIds),
  };
}

function migrateMain(old, busIds) {
  const legacyMaster = Array.isArray(old.busses)
    ? old.busses.find((b) => b.id === "main")
    : undefined;
  const src = legacyMaster ?? old.main ?? {};
  const channels = src.channels === 1 ? 1 : 2;
  const route = migrateBusRoute({ ...src, channels }, busIds);
  return {
    enabled: src.enabled ?? true,
    name: orNull(src.name) ?? "Main",
    channels,
    gainDb: num(src.gainDb, 0),
    pan: num(src.pan, 0),
    mute: Boolean(src.mute),
    solo: Boolean(src.solo),
    // Master always owns its physical channels; it can never fold elsewhere.
    output: route.type === "ext-out" ? route : { type: "ext-out", target: extOutTarget(0, channels) },
  };
}

function migrateSends(old, busIds, mainRoute) {
  const legacyBusses = Array.isArray(old.busses) ? old.busses : null;
  const source = legacyBusses
    ? legacyBusses.filter((b) => b.id !== "main")
    : Array.isArray(old.sends)
      ? old.sends
      : [];
  return source.map((b, i) => {
    const channels = b.channels === 1 ? 1 : 2;
    let output = migrateBusRoute({ ...b, channels }, busIds);
    // A send that happened to be pointed at Main's own physical channels was
    // the old way of saying "same outs as Main". Express it as what it means
    // -- fold into Main -- so it inherits Main's fader/pan/mute instead of
    // racing Main for the same pair of lanes.
    if (output.type === "ext-out" && output.target === mainRoute.target) {
      output = { type: "main", target: "audio::main" };
    }
    return {
      id: busIds.get(b.id) ?? `audio::send:${i + 1}`,
      name: orNull(b.name) ?? `Send ${i + 1}`,
      channels,
      gainDb: num(b.gainDb, 0),
      pan: num(b.pan, 0),
      mute: Boolean(b.mute),
      solo: Boolean(b.solo),
      output,
    };
  });
}

function migrateTracks(old, busIds, trackIds) {
  return (Array.isArray(old.tracks) ? old.tracks : []).map((t, i) => ({
    id: trackIds.get(t.id) ?? `audio::track:${i + 1}`,
    name: orNull(t.name) ?? `Track ${i + 1}`,
    // v1 carried a `mono` flag; the schema carries a channel count.
    channels: t.channels === 1 || t.mono === true ? 1 : 2,
    gainDb: num(t.gainDb, 0),
    pan: num(t.pan, 0),
    mute: Boolean(t.mute),
    solo: Boolean(t.solo),
    output: migrateSourceOutput(t, busIds),
  }));
}

function migrateRegions(song, trackIds) {
  return (Array.isArray(song.regions) ? song.regions : []).map((r) => ({
    id: stableUuid(r.id),
    trackId: trackIds.get(r.trackId) ?? r.trackId,
    startSeconds: num(r.startSeconds, 0),
    durationSeconds: num(r.durationSeconds, 0),
    gainDb: num(r.gainDb, 0),
    source: {
      file: r.source?.file ?? r.file ?? "",
      offsetSeconds: num(r.source?.offsetSeconds ?? r.sourceOffsetSeconds, 0),
    },
    fade: {
      inSeconds: num(r.fade?.inSeconds ?? r.fadeInSeconds, 0),
      outSeconds: num(r.fade?.outSeconds ?? r.fadeOutSeconds, 0),
      inCurve: num(r.fade?.inCurve ?? r.fadeInCurve, 0),
      outCurve: num(r.fade?.outCurve ?? r.fadeOutCurve, 0),
    },
    loop: {
      enabled: Boolean(r.loop?.enabled ?? r.loop),
      lengthSeconds: num(r.loop?.lengthSeconds, 0),
    },
  }));
}

/**
 * A cue's effect can be metered off a track or a bus, so its sourceId has to
 * follow the same remap the tracks/busses themselves did -- this is exactly
 * what the previous pass missed, leaving cues pointed at "trk_6".
 */
function migrateEffectSource(effect, busIds, trackIds) {
  const sourceType = effect.sourceType === "track" ? "track" : "bus";
  const rawId = orNull(effect.sourceId);
  if (rawId === null) return { sourceType, sourceId: null };
  const mapped = sourceType === "track" ? trackIds.get(rawId) : busIds.get(rawId);
  return { sourceType, sourceId: mapped ?? rawId };
}

function migrateLightCues(song, busIds, trackIds, lightTrackIds) {
  return (Array.isArray(song.lightCues) ? song.lightCues : []).map((lc) => {
    const effect = lc.effect ?? {};
    const { sourceType, sourceId } = migrateEffectSource(
      {
        sourceType: effect.sourceType ?? lc.effectSourceType,
        sourceId: effect.sourceId ?? lc.effectSourceId,
      },
      busIds,
      trackIds,
    );
    return {
      id: stableUuid(lc.id),
      trackId: lightTrackIds.get(lc.trackId) ?? lc.trackId,
      startSeconds: num(lc.startSeconds, 0),
      durationSeconds: num(lc.durationSeconds, 1),
      label: orNull(lc.label),
      color: {
        r: num(lc.color?.r ?? lc.colorR, 255),
        g: num(lc.color?.g ?? lc.colorG, 255),
        b: num(lc.color?.b ?? lc.colorB, 255),
      },
      intensity: num(lc.intensity, 1),
      fade: {
        inSeconds: num(lc.fade?.inSeconds ?? lc.fadeInSeconds, 0),
        outSeconds: num(lc.fade?.outSeconds ?? lc.fadeOutSeconds, 0),
      },
      effect: {
        type: orNull(effect.type ?? lc.effectType),
        sourceType,
        sourceId,
        intensity: num(effect.intensity ?? lc.effectIntensity, 0.8),
        tempoSync: Boolean(effect.tempoSync ?? lc.tempoSync),
        tempoSubdivision: orNull(effect.tempoSubdivision ?? lc.tempoSubdiv) ?? "1/4",
        rateHz: num(effect.rateHz ?? lc.effectRateHz, 2),
      },
      gradient: {
        preset: orNull(lc.gradient?.preset ?? lc.gradientPreset) ?? "solid",
        colors: orNull(lc.gradient?.colors ?? lc.gradientColors),
      },
      blendMode: orNull(lc.blendMode) ?? "normal",
    };
  });
}

function migrateSongs(old, busIds, trackIds, lightTrackIds) {
  return (Array.isArray(old.songs) ? old.songs : []).map((s, i) => ({
    id: `meta::song:${i + 1}`,
    name: orNull(s.name) ?? `Song ${i + 1}`,
    bpm: num(s.bpm, 120),
    timeSignature: {
      numerator: num(s.timeSignature?.numerator, 4),
      denominator: num(s.timeSignature?.denominator, 4),
    },
    onEnded: normalizeOnEnded(s),
    regions: migrateRegions(s, trackIds),
    events: Array.isArray(s.events) ? s.events : [],
    sections: (Array.isArray(s.sections) ? s.sections : []).map((sec) => ({
      id: stableUuid(sec.id),
      name: orNull(sec.name) ?? "Section",
      startSeconds: num(sec.startSeconds, 0),
      colorIndex: num(sec.colorIndex, 0),
    })),
    lightCues: migrateLightCues(s, busIds, trackIds, lightTrackIds),
  }));
}

function migrateLighting(old, fixtureIds, lightTrackIds) {
  const li = old.lighting ?? {};
  const fixtures = (Array.isArray(li.fixtures) ? li.fixtures : []).map((fx, i) => ({
    id: fixtureIds.get(fx.id) ?? `light::fixture:${i + 1}`,
    name: orNull(fx.name) ?? `Fixture ${i + 1}`,
    kind: normalizeFixtureKind(fx.kind),
    grid: {
      column: num(fx.grid?.column ?? fx.gridColumn, 0),
      row: num(fx.grid?.row ?? fx.gridRow, 0),
    },
    ledCount: num(fx.ledCount, 120),
    addressable: Boolean(fx.addressable),
    position: {
      x: num(fx.position?.x ?? fx.posX, 0),
      y: num(fx.position?.y ?? fx.posY, 0),
      z: num(fx.position?.z ?? fx.posZ, 0),
    },
    rotation: { y: num(fx.rotation?.y ?? fx.rotationYDeg, 0) },
    mountedHorizontally: Boolean(fx.mountedHorizontally),
    dmx: {
      universe: num(fx.dmx?.universe ?? fx.dmxUniverse, 0),
      startChannel: num(fx.dmx?.startChannel ?? fx.dmxStartChannel, 1),
      channelCount: num(fx.dmx?.channelCount ?? fx.dmxChannelCount, 3),
    },
    shape: normalizeShape(fx.shape),
    matrixColumns: num(fx.matrixColumns ?? fx.matrixCols, 0),
    channelProfile: orNull(fx.channelProfile) ?? "rgb",
    tiltDegrees: num(fx.tiltDegrees ?? fx.tiltDeg, 0),
    refreshRateHz: num(fx.refreshRateHz, 0),
    networkHost: orNull(fx.networkHost),
  }));

  const tracks = readLightTracks(old).map((lt, i) => ({
    id: lightTrackIds.get(lt.id) ?? `light::track:${i + 1}`,
    name: orNull(lt.name) ?? `Light ${i + 1}`,
    // Fixture references have to follow the fixture renumbering too.
    fixtureIds: (Array.isArray(lt.fixtureIds) ? lt.fixtureIds : [])
      .map((id) => fixtureIds.get(id) ?? id)
      .filter((id) => typeof id === "string" && id.startsWith("light::")),
  }));

  return {
    enabled: Boolean(li.enabled),
    kind: normalizeLightingKind(li.kind),
    resolight: {
      columns: num(li.resolight?.columns ?? li.resoLight?.columns ?? li.resoLightColumns, 2),
      rows: num(li.resolight?.rows ?? li.resoLight?.rows ?? li.resoLightRows, 1),
    },
    idle: {
      behavior: normalizeIdleBehavior(li.idle?.behavior ?? li.idleBehavior),
      color: {
        r: num(li.idle?.color?.r ?? li.idleColorR, 0),
        g: num(li.idle?.color?.g ?? li.idleColorG, 0),
        b: num(li.idle?.color?.b ?? li.idleColorB, 0),
      },
      intensity: num(li.idle?.intensity ?? li.idleIntensity, 1),
      effect: {
        type: orNull(li.idle?.effect?.type ?? li.idleEffectType) ?? "none",
        rateHz: num(li.idle?.effect?.rateHz ?? li.idleEffectRateHz, 2),
      },
      gradient: {
        preset: orNull(li.idle?.gradient?.preset ?? li.idleGradientPreset) ?? "solid",
        colors: orNull(li.idle?.gradient?.colors ?? li.idleGradientColors),
      },
    },
    defaultRefreshRateHz: num(li.defaultRefreshRateHz, 44),
    artNetTargetHost: orNull(li.artNetTargetHost),
    fixtures,
    tracks,
  };
}

// ── entry point ──────────────────────────────────────────────────────────────

export function migrateProjectObject(old) {
  const { busIds, trackIds, fixtureIds, lightTrackIds } = buildIdMaps(old);
  const main = migrateMain(old, busIds);

  return {
    format: { version: TARGET_FORMAT_VERSION },
    name: orNull(old.name) ?? "Untitled",
    sampleRate: num(old.sampleRate, 48000),
    click: migrateClick(old, busIds),
    main,
    sends: migrateSends(old, busIds, main.output),
    tracks: migrateTracks(old, busIds, trackIds),
    lighting: migrateLighting(old, fixtureIds, lightTrackIds),
    songs: migrateSongs(old, busIds, trackIds, lightTrackIds),
    cycle: {
      active: Boolean(old.cycle?.active),
      skip: Boolean(old.cycle?.skip),
      startSeconds: num(old.cycle?.startSeconds ?? old.cycle?.leftSec, 0),
      endSeconds: num(old.cycle?.endSeconds ?? old.cycle?.rightSec, 4),
      songIndex: num(old.cycle?.songIndex, -1),
    },
    midi: {
      mappings: Array.isArray(old.midi?.mappings)
        ? old.midi.mappings
        : Array.isArray(old.midiMappings)
          ? old.midiMappings
          : [],
    },
    // `keybindings` is intentionally absent: it moved to rig-wide AppSettings.
  };
}

function resolveProjectJsonPath(target) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) {
    throw new Error(`File or directory not found: ${abs}`);
  }
  if (fs.statSync(abs).isDirectory()) {
    const jsonPath = path.join(abs, "project.json");
    if (!fs.existsSync(jsonPath)) {
      throw new Error(`project.json not found in ${abs}`);
    }
    return jsonPath;
  }
  if (!abs.endsWith(".json")) {
    throw new Error(`Not a project container or project.json: ${abs}`);
  }
  return abs;
}

if (process.argv[1] && process.argv[1].endsWith("migrate.mjs")) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: pnpm migrate <path-to-project.json-or-.rsnraset>");
    process.exit(1);
  }
  try {
    const jsonPath = resolveProjectJsonPath(target);
    const oldObj = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const fromVersion = oldObj.format?.version ?? oldObj.formatVersion ?? 1;
    if (fromVersion === TARGET_FORMAT_VERSION) {
      console.log(`Already at format v${TARGET_FORMAT_VERSION}: ${jsonPath}`);
      process.exit(0);
    }
    // The engine only ever reads project.json, so a .bak next to it is inert
    // and gives an undo for a conversion that renumbers every id in the file.
    fs.copyFileSync(jsonPath, `${jsonPath}.bak`);
    fs.writeFileSync(
      jsonPath,
      `${JSON.stringify(migrateProjectObject(oldObj), null, 2)}\n`,
      "utf-8",
    );
    console.log(
      `Migrated ${jsonPath}: format v${fromVersion} -> v${TARGET_FORMAT_VERSION}`
        + ` (backup: ${path.basename(jsonPath)}.bak)`,
    );
  } catch (err) {
    console.error(`Migration failed: ${err.message}`);
    process.exit(1);
  }
}
