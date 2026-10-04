/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { apiUrl, apiFetch, backendOrigin } from "@/lib/state/backend";
import { importMediaFile } from "@/transfer/audio/logic/importRequest";
import { cancelActiveDrags } from "@/lib/interaction/dragCancel";
import { flushPendingCommits } from "@/lib/state/optimistic";
import { createHistoryNavigator } from "@/lib/state/historyNavigation";
import {
  BoundedCommandQueue,
  coalescingTargetKey,
  utf8ByteLength,
} from "@/lib/state/commandQueue";
import type { MixGraphPayload } from "@/lib/audio/mixGraph";
import type {
  AllPeaksResponse,
  AutomationTargetRow,
  EventTypeWire,
  LightCueRow,
  LivePeakChunkResponse,
  PeaksResponse,
  PluginParameterList,
  PluginParameterValues,
  WebUiState,
} from "@/lib/state/types";

// ── Immediate-refetch hook ────────────────────────────────────────────────────
// In UDP/embedded mode the structural state arrives via a 1 s HTTP poll. Any
// user action (solo, mute, gain commit …) should be reflected without waiting
// for the next poll tick, so we ask the state layer to fetch immediately after
// the command lands. WS mode never registers a handler (server pushes state).
//
// The handler is debounced: rapid-fire actions (e.g. multiple mixer toggles in
// quick succession) coalesce into one fetch instead of stampeding the server.
let _refetchHandler: ((snapshot?: Partial<WebUiState>) => void) | null = null;
let _refetchTimer: ReturnType<typeof setTimeout> | null = null;
export const EDITOR_COMMAND_FAILURE_EVENT = "resostage:editor-command-failure";
export type EditorMutationOutcome = "not-sent" | "rejected" | "unknown" | "stored";

/**
 * Carries the strongest outcome a reliable editor command can prove. Gesture
 * owners may offer retry only for `not-sent` and exact `rejected` outcomes;
 * an unknown request or a stored edit whose live snapshot lagged must never be
 * blindly replayed.
 */
export class EditorMutationError extends Error {
  public readonly outcome: EditorMutationOutcome;
  public readonly path: string;
  public readonly requestId?: number;

  constructor(
    message: string,
    outcome: EditorMutationOutcome,
    path: string,
    requestId?: number,
  ) {
    super(message);
    this.name = "EditorMutationError";
    this.outcome = outcome;
    this.path = path;
    this.requestId = requestId;
  }
}

export interface ProjectCommandIdentity {
  origin: string;
  stateSessionId: string;
  projectEpoch: number;
}
export type ProjectCommandIdentityListener = (
  identity: ProjectCommandIdentity | null,
) => void;
let _projectCommandIdentity: ProjectCommandIdentity | null = null;
const _projectCommandIdentityListeners = new Set<ProjectCommandIdentityListener>();

function publishProjectCommandIdentity(identity: ProjectCommandIdentity | null): void {
  const previous = _projectCommandIdentity;
  if (
    previous?.origin === identity?.origin
    && previous?.stateSessionId === identity?.stateSessionId
    && previous?.projectEpoch === identity?.projectEpoch
  ) return;

  _projectCommandIdentity = identity;
  const snapshot = identity ? { ...identity } : null;
  for (const listener of [..._projectCommandIdentityListeners])
    listener(snapshot);
}

/** Subscribe to complete Core/project identity changes, not partial snapshots. */
export function subscribeProjectCommandIdentity(
  listener: ProjectCommandIdentityListener,
): () => void {
  _projectCommandIdentityListeners.add(listener);
  return () => _projectCommandIdentityListeners.delete(listener);
}

export function observeProjectCommandIdentity(snapshot: Partial<WebUiState>): void {
  const { stateSessionId, projectEpoch } = snapshot;
  // View-filtered WebSocket snapshots can omit project identity. An unrelated
  // partial frame must not clear the last full-state fence and let a queued
  // positional command fall back to an unfenced POST.
  if (stateSessionId === undefined || projectEpoch === undefined) return;
  if (!stateSessionId || !Number.isSafeInteger(projectEpoch) || projectEpoch < 0) {
    publishProjectCommandIdentity(null);
    return;
  }
  publishProjectCommandIdentity({
    origin: backendOrigin(),
    stateSessionId,
    projectEpoch,
  });
}

function captureProjectCommandIdentity(): ProjectCommandIdentity | null {
  const identity = _projectCommandIdentity;
  return identity ? { ...identity } : null;
}

export function currentProjectCommandIdentity(): ProjectCommandIdentity | null {
  return captureProjectCommandIdentity();
}

export function currentProjectCommandHeaders(): Record<string, string> {
  return projectCommandHeaders(captureProjectCommandIdentity());
}

function isProjectScopedPath(path: string): boolean {
  return path.startsWith("/api/v1/builder/")
    || path.startsWith("/api/v1/lighting/")
    || path.startsWith("/api/v1/track/")
    || path.startsWith("/api/v1/bus/")
    || path.startsWith("/api/v1/mixer/track/send")
    || path.startsWith("/api/v1/plugins/slot/")
    || (path.startsWith("/api/v1/transport/") && path !== "/api/v1/transport/stop")
    || path.startsWith("/api/v1/recording/auto-")
    || path === "/api/v1/recording/low-latency"
    || path === "/api/v1/timeline/undo"
    || path === "/api/v1/timeline/redo"
    || path === "/api/v1/project/name"
    || path === "/api/v1/project/new"
    || path === "/api/v1/project/load-dialog"
    || path === "/api/v1/project/save"
    || path === "/api/v1/project/save-as"
    || path === "/api/v1/project/open-recent"
    || path === "/api/v1/project/export";
}

function sameProjectCommandIdentity(
  expected: ProjectCommandIdentity,
  current: ProjectCommandIdentity | null,
): boolean {
  return current !== null
    && current.origin === expected.origin
    && current.stateSessionId === expected.stateSessionId
    && current.projectEpoch === expected.projectEpoch;
}

function projectCommandHeaders(identity: ProjectCommandIdentity | null): Record<string, string> {
  if (!identity) return {};
  return {
    "X-ResoStage-Session": identity.stateSessionId,
    "X-ResoStage-Project-Epoch": String(identity.projectEpoch),
  };
}

export function registerRefetchHandler(fn: (snapshot?: Partial<WebUiState>) => void): void {
  _refetchHandler = fn;
}
export function unregisterRefetchHandler(): void {
  _refetchHandler = null;
}

// ── Ultra-low latency MIDI transport ──────────────────────────────────────────
let _liveMidiSender: ((bytes: Uint8Array) => boolean) | null = null;

export function registerLiveMidiSender(
  sender: (bytes: Uint8Array) => boolean,
): void {
  _liveMidiSender = sender;
}

export function unregisterLiveMidiSender(): void {
  _liveMidiSender = null;
}

export function sendLiveMidi(
  status: number,
  data1: number,
  data2: number,
  trackIndex?: number,
): void {
  const bytes = new Uint8Array([status, data1, data2]);
  // The legacy binary WS packet contains only three MIDI bytes. It cannot
  // represent an explicit destination, so targeted audition must use HTTP.
  if (trackIndex === undefined && _liveMidiSender && _liveMidiSender(bytes)) {
    return;
  }
  void apiFetch("/api/v1/midi/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status,
      data1,
      data2,
      ...(trackIndex !== undefined && trackIndex >= 0 ? { trackIndex } : {}),
    }),
  }).catch(() => {});
}

function _triggerRefetch(): void {
  if (!_refetchHandler) return;
  if (_refetchTimer !== null) return; // already pending
  _refetchTimer = setTimeout(() => {
    _refetchTimer = null;
    _refetchHandler?.();
  }, 50);
}

// Mirrors WebServer::handleHttpApi().
// One reliable admission order across tabs/toolbars prevents concurrent
// multi-region edits or Undo overtaking their preceding POSTs. Continuous
// controls still coalesce their pending values before entering this queue.
const _commandQueue = new BoundedCommandQueue({
  maxPendingCommands: 256,
  maxRetainedPayloadBytes: 32 * 1024 * 1024,
});
function serializeCommand<T>(command: () => Promise<T>, payloadBytes: number): Promise<T> {
  const origin = backendOrigin();
  return _commandQueue.run(payloadBytes, () => {
    if (backendOrigin() !== origin) throw new Error("Core changed before the command was sent");
    return command();
  });
}

function serializeJsonBody(body: unknown, falsyIsEmpty = false): string {
  if (body === undefined || (falsyIsEmpty && !body)) return "{}";
  const serialized = JSON.stringify(body);
  if (typeof serialized !== "string")
    throw new Error("Core command body is not JSON-serializable");
  return serialized;
}
function post(path: string, body?: unknown): Promise<void> {
  try {
    const serializedBody = serializeJsonBody(body, true);
    return sendBestEffortSerialized(path, serializedBody,
      isProjectScopedPath(path) ? captureProjectCommandIdentity() : null)
      .then(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

function reportEditorCommandFailure(cause: unknown): void {
  if (typeof window === "undefined") return;
  const message = cause instanceof Error ? cause.message : String(cause);
  window.dispatchEvent(new CustomEvent(EDITOR_COMMAND_FAILURE_EVENT, {
    detail: { message: message.slice(0, 320) },
  }));
}

/** Project lifecycle operations report admission/transport failures to the shell. */
function postProjectCommand(path: string, body?: unknown): Promise<boolean> {
  try {
    const serializedBody = serializeJsonBody(body, true);
    return sendBestEffortSerialized(
      path,
      serializedBody,
      isProjectScopedPath(path) ? captureProjectCommandIdentity() : null,
      reportEditorCommandFailure,
    );
  } catch (cause) {
    reportEditorCommandFailure(cause);
    return Promise.resolve(false);
  }
}

async function sendBestEffortSerialized(
  path: string,
  serializedBody: string,
  identity: ProjectCommandIdentity | null,
  onFailure?: (cause: unknown) => void,
): Promise<boolean> {
  try {
    await serializeCommand(async () => {
      if (identity && (identity.origin !== backendOrigin()
        || !sameProjectCommandIdentity(identity, _projectCommandIdentity)))
        throw new Error("Core project changed before the command was sent");
      const response = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...projectCommandHeaders(identity) },
        body: serializedBody,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Core rejected ${path} (HTTP ${response.status})`);
      }
    }, utf8ByteLength(serializedBody));
    _triggerRefetch();
    return true;
  } catch (cause) {
    // Best-effort, matches the embedded reference client -- a dropped
    // command just means the next state frame won't reflect it and the
    // user can press again. Project lifecycle owners opt into surfacing this
    // admission/transport failure; ordinary high-rate controls remain quiet.
    onFailure?.(cause);
    return false;
  }
}

/** Transactional edits keep queue/network failures visible to their gesture owner. */
export function postReliable(path: string, body?: unknown): Promise<void> {
  return sendReliableSerialized(path, serializeJsonBody(body),
    isProjectScopedPath(path) ? captureProjectCommandIdentity() : null);
}

/**
 * Project-editor mutations are reliable transactions. Attach a rejection
 * observer for legacy fire-and-forget gesture call sites while preserving the
 * original promise for owners that await it and render a local recovery state.
 * Core also publishes failed transactions through statusMessage.
 */
function postEditorMutation(path: string, body?: unknown): Promise<void> {
  const pending = postReliable(path, body);
  void pending.catch((cause: unknown) => {
    _triggerRefetch();
    reportEditorCommandFailure(cause);
  });
  return pending;
}

async function sendReliableSerialized(
  path: string,
  serializedBody: string,
  identity: ProjectCommandIdentity | null,
): Promise<void> {
  let requestWasSent = false;
  try {
    await serializeCommand(async () => {
      if (identity && (identity.origin !== backendOrigin()
        || !sameProjectCommandIdentity(identity, _projectCommandIdentity)))
        throw new EditorMutationError("Core project changed before the edit was sent", "not-sent", path);
      let response: Awaited<ReturnType<typeof apiFetch>>;
      try {
        requestWasSent = true;
        response = await apiFetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...projectCommandHeaders(identity) },
          body: serializedBody,
        });
      } catch (cause) {
        throw new EditorMutationError(
          cause instanceof Error ? cause.message : String(cause), "unknown", path,
        );
      }
      if (!response.ok) {
        const detail = await response.text();
        // Core returns 503 only when its bounded command queue refused the
        // request before enqueueing it. Like 4xx validation/epoch failures,
        // that is a definitive rejection rather than an ambiguous timeout.
        const outcome = (response.status >= 400 && response.status < 500)
          || response.status === 503 ? "rejected" : "unknown";
        throw new EditorMutationError(
          detail || `Core rejected the edit (HTTP ${response.status})`, outcome, path,
        );
      }
      let acknowledgement: {
        accepted?: boolean;
        requestId?: number;
        stateSessionId?: string;
        projectEpoch?: number;
      };
      try {
        acknowledgement = await response.json() as typeof acknowledgement;
      } catch (cause) {
        throw new EditorMutationError(
          cause instanceof Error ? cause.message : "Core returned an unreadable admission response",
          "unknown", path,
        );
      }
      // Older Core versions may accept the command without publishing an exact
      // result ring. Refresh for compatibility, but do not call the mutation
      // applied: a transactional caller must preserve it as outcome-unknown.
      if (!Number.isSafeInteger(acknowledgement.requestId)) {
        _triggerRefetch();
        // Manual override is ephemeral playback arbitration, not a project
        // mutation; it intentionally has no editor-result-ring entry.
        if (path === "/api/v1/builder/automation/manual-override") return;
        throw new EditorMutationError(
          "Core accepted the edit but cannot confirm its exact outcome. State was refreshed; do not resend blindly.",
          "unknown", path,
        );
      }
      if (!acknowledgement.accepted || !acknowledgement.stateSessionId
        || !Number.isSafeInteger(acknowledgement.projectEpoch))
        throw new EditorMutationError(
          "Core returned an invalid editor-command admission response", "unknown", path,
        );
      const requestId = acknowledgement.requestId!;
      const sessionId = acknowledgement.stateSessionId;
      const projectEpoch = acknowledgement.projectEpoch!;
      const deadline = Date.now() + 30_000;
      while (Date.now() <= deadline) {
        if (backendOrigin() !== identity?.origin && identity)
          throw new EditorMutationError("Core changed while applying the project edit", "unknown", path, requestId);
        const stateResponse = await apiFetch("/api/v1/state");
        if (!stateResponse.ok)
          throw new EditorMutationError(`Cannot confirm the project edit (HTTP ${stateResponse.status})`, "unknown", path, requestId);
        const snapshot = await stateResponse.json() as Partial<WebUiState>;
        if (snapshot.stateSessionId !== sessionId)
          throw new EditorMutationError("Core restarted before this project edit could be confirmed", "unknown", path, requestId);
        if (identity && (identity.origin !== backendOrigin()
          || !sameProjectCommandIdentity(identity, _projectCommandIdentity)))
          throw new EditorMutationError("Project changed while confirming the edit", "unknown", path, requestId);
        const result = snapshot.editorCommandResults?.find((entry) => entry.requestId === requestId);
        if (result) {
          _refetchHandler?.(snapshot);
          if (!result.applied)
            throw new EditorMutationError(
              result.error || "Core did not apply the project edit", "rejected", path, requestId,
            );
          if (identity && snapshot.projectEpoch !== identity.projectEpoch)
            throw new EditorMutationError("Project changed while applying the edit", "stored", path, requestId);
          if (snapshot.projectEpoch !== projectEpoch || result.projectEpoch !== projectEpoch
            || !Number.isSafeInteger(snapshot.stateRevision)
            || result.projectRevision > snapshot.stateRevision!)
            throw new EditorMutationError("Core returned an inconsistent editor-command revision", "unknown", path, requestId);
          const lightingMutation = path.startsWith("/api/v1/lighting/");
          const expectedApplicationDomain = lightingMutation ? "lighting" : "audio";
          if (result.applicationDomain !== undefined
            && result.applicationDomain !== expectedApplicationDomain)
            throw new EditorMutationError(
              `Core returned an unexpected ${result.applicationDomain || "unknown"} application domain for ${path}`,
              "unknown", path, requestId,
            );
          if (result.playbackApplied === true
            && (!Number.isSafeInteger(result.playbackProjectEpoch)
              || result.playbackProjectEpoch !== snapshot.playbackProjectEpoch
              || !Number.isSafeInteger(result.playbackRevision)
              || result.playbackRevision! < result.projectRevision))
            throw new EditorMutationError(
              "Core returned an inconsistent playback-snapshot identity or revision", "unknown", path, requestId,
            );
          if (lightingMutation && result.lightingApplied !== true) {
            throw new EditorMutationError(result.error ||
              `Core stored project revision ${result.projectRevision}, but did not confirm publishing it to LightEngine. The project view was refreshed; do not resend this edit blindly.`,
            "stored", path, requestId);
          }
          if (!lightingMutation && (result.playbackApplied === false
            || (Number.isSafeInteger(snapshot.playbackProjectRevision)
              && snapshot.playbackProjectRevision! < result.projectRevision))) {
            throw new EditorMutationError(result.error ||
              `Core stored project revision ${result.projectRevision}, but audio is still using its last valid snapshot at revision ${result.playbackRevision}. The project view was refreshed; do not resend this edit blindly.`,
            "stored", path, requestId);
          }
          return;
        }
        // A present result ring is authoritative. Keep waiting for this request;
        // an absent row may mean the Core has not dispatched it yet.
        if (!Array.isArray(snapshot.editorCommandResults)) {
          _triggerRefetch();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      _triggerRefetch();
      throw new EditorMutationError(
        "Core did not confirm the project edit before timeout. Its outcome is unknown; state was refreshed and the command was not resent. Do not retry blindly.",
        "unknown", path,
      );
    }, utf8ByteLength(serializedBody));
  } catch (cause) {
    if (cause instanceof EditorMutationError) throw cause;
    // Reaching this catch before the queued operation runs means no request was
    // issued (for example, local queue saturation); conservative owners may
    // safely offer a retry for that explicit local rejection.
    throw new EditorMutationError(
      cause instanceof Error ? cause.message : String(cause),
      requestWasSent ? "unknown" : "not-sent",
      path,
    );
  }
}

/** Decisions are generation-bound; unlike best-effort controls, errors stay visible. */
export async function decidePluginLoading(
  epoch: number,
  generation: number,
  decision: "continue" | "stop" | "retry",
): Promise<void> {
  const serializedBody = JSON.stringify({ epoch, generation, decision });
  if (typeof serializedBody !== "string")
    throw new Error("Plug-in loading decision is not JSON-serializable");
  await serializeCommand(async () => {
    const response = await apiFetch("/api/v1/plugins/loading/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializedBody,
    });
    if (!response.ok) throw new Error(`Core rejected loading decision (HTTP ${response.status})`);
  }, utf8ByteLength(serializedBody));
  _triggerRefetch();
}

// ── Continuous parameter coalescing ──────────────────────────────────────────
// High-frequency dragging (faders, pan knobs, send knobs) can generate hundreds
// of updates per second. Over LAN/Wi-Fi, spamming un-throttled HTTP POSTs floods
// Chromium's 6-connection pool and causes multi-second queue lag.
//
// postContinuous ensures that if a request is already in-flight for a specific
// target, subsequent intermediate values replace each other in a pending slot,
// and only the latest value is sent as soon as the in-flight POST finishes.
interface ContinuousPayload {
  body: string;
  bytes: number;
  identity: ProjectCommandIdentity | null;
}

interface ContinuousRequestState {
  pending: ContinuousPayload | null;
  busy: boolean;
}

const _continuousInFlight = new Map<string, ContinuousRequestState>();
const _continuousValueFieldsByPath = new Map<string, ReadonlySet<string>>([
  ["/api/v1/track/gain", new Set(["value"])],
  ["/api/v1/track/pan", new Set(["value"])],
  ["/api/v1/track/trim", new Set(["inputTrimDb"])],
  ["/api/v1/bus/gain", new Set(["value"])],
  ["/api/v1/bus/pan", new Set(["value"])],
  ["/api/v1/mixer/track/send", new Set(["level"])],
]);
const _maximumContinuousPayloadBytes = 4096;
const _maximumContinuousPendingBytes = 1024 * 1024;
let _continuousPendingBytes = 0;

const _continuousPromises = new Set<Promise<void>>();
function postContinuous(path: string, body: unknown): Promise<void> {
  let payload: ContinuousPayload;
  try {
    const serialized = serializeJsonBody(body);
    const bytes = utf8ByteLength(serialized);
    if (bytes > _maximumContinuousPayloadBytes)
      return Promise.resolve();
    payload = {
      body: serialized,
      bytes,
      identity: isProjectScopedPath(path) ? captureProjectCommandIdentity() : null,
    };
  } catch {
    return Promise.resolve();
  }
  const identityKey = payload.identity
    ? `${payload.identity.origin}:${payload.identity.stateSessionId}:${payload.identity.projectEpoch}`
    : "legacy";
  const targetKey = `${identityKey}:${coalescingTargetKey(
    path, body, _continuousValueFieldsByPath.get(path) ?? new Set(), payload.body,
  )}`;
  const request = postContinuousImpl(path, targetKey, payload);
  _continuousPromises.add(request);
  void request.finally(() => { _continuousPromises.delete(request); });
  return request;
}
function replaceContinuousPending(
  state: ContinuousRequestState,
  payload: ContinuousPayload,
): boolean {
  const previousBytes = state.pending?.bytes ?? 0;
  if (payload.bytes > _maximumContinuousPendingBytes
    - (_continuousPendingBytes - previousBytes))
    return false;
  _continuousPendingBytes -= previousBytes;
  state.pending = payload;
  _continuousPendingBytes += payload.bytes;
  return true;
}

function releaseContinuousPending(state: ContinuousRequestState): ContinuousPayload | null {
  const pending = state.pending;
  if (pending !== null) {
    _continuousPendingBytes -= pending.bytes;
    state.pending = null;
  }
  return pending;
}

async function postContinuousImpl(
  path: string,
  targetKey: string,
  payload: ContinuousPayload,
): Promise<void> {
  let state = _continuousInFlight.get(targetKey);
  if (!state) {
    state = { pending: null, busy: false };
    _continuousInFlight.set(targetKey, state);
  }

  if (state.busy) {
    replaceContinuousPending(state, payload);
    return;
  }

  state.busy = true;
  let nextPayload: ContinuousPayload | null = payload;

  try {
    while (nextPayload !== null) {
      const requestPayload = nextPayload;
      await serializeCommand(async () => {
        if (requestPayload.identity
          && (requestPayload.identity.origin !== backendOrigin()
            || !sameProjectCommandIdentity(requestPayload.identity, _projectCommandIdentity)))
          throw new Error("Core project changed before the control was sent");
        const response = await apiFetch(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...projectCommandHeaders(requestPayload.identity),
          },
          body: requestPayload.body,
        });
        if (!response.ok) throw new Error(`Core rejected ${path} (HTTP ${response.status})`);
      }, requestPayload.bytes);
      nextPayload = releaseContinuousPending(state);
    }
  } catch {
    /* best effort */
  } finally {
    state.busy = false;
    releaseContinuousPending(state);
    _continuousInFlight.delete(targetKey);
    _triggerRefetch();
  }
}

export const transport = {
  play: () => post("/api/v1/transport/play"),
  record: (recording?: boolean, trackIndex?: number) =>
    post("/api/v1/transport/record", {
      ...(recording !== undefined ? { recording } : {}),
      ...(trackIndex !== undefined ? { trackIndex } : {}),
    }),
  // Pause -- freezes in place, resumed by play(). Used by the Play/Pause
  // toggle + spacebar. See AudioEngine::stop()'s doc comment.
  stop: () => post("/api/v1/transport/stop"),
  // Dedicated "Stop" button -- see AudioEngine::stopToStart(): first press
  // rewinds the current song to its start, a second press (already there)
  // rewinds to the very start of the whole project. Distinct from stop()
  // above, which never moves the playhead.
  stopToStart: () => post("/api/v1/transport/stop-to-start"),
  next: () => post("/api/v1/transport/next"),
  prev: () => post("/api/v1/transport/prev"),
  select: (index: number) => post("/api/v1/transport/select", { index }),
  // Mirrors TimelineView.cpp's click/drag-to-seek (AudioEngine::
  // seekToSeconds) -- restages the song, so the caller should throttle
  // repeated calls during a drag gesture (same reason the native timeline
  // does) rather than firing on every pointermove. `songIndex` is optional:
  // pass it to seek into a *different* song in one atomic call (preserves
  // playback state), instead of a separate select() + seek() pair.
  seek: (seconds: number, songIndex?: number) =>
    post(
      "/api/v1/transport/seek",
      songIndex !== undefined ? { seconds, songIndex } : { seconds },
    ),
};

export const recording = {
  setAutoInputMonitoring: (enabled: boolean) =>
    post("/api/v1/recording/auto-input", { enabled }),
  setAutoPunch: (enabled: boolean, startSample: number, endSample: number) =>
    post("/api/v1/recording/auto-punch", { enabled, startSample, endSample }),
  setLowLatencyMonitoring: (enabled: boolean, limitMs: number = 5.0) =>
    post("/api/v1/recording/low-latency", { enabled, limitMs }),
  fetchLivePeaks: async (
    recordingId: string,
    level: number = 0,
    first: number = 0,
    count: number = 512,
  ): Promise<LivePeakChunkResponse> => {
    const res = await apiFetch(
      `/api/v1/recording/${encodeURIComponent(recordingId)}/peaks?level=${level}&first=${first}&count=${count}`,
    );
    if (!res.ok) throw new Error(`Live peaks fetch failed: ${res.status}`);
    return res.json() as Promise<LivePeakChunkResponse>;
  },
};

export interface AudioRenderOptions {
  scope: "song" | "project" | "cycle" | "custom";
  songIndex: number;
  targets: Array<{
    kind: "master" | "bus" | "track" | "click";
    id?: string;
  }>;
  sampleRate: number;
  outputFormat: "wav" | "aiff" | "flac" | "mp3" | "m4a" | "alac" | "opus" | "ogg" | "wma";
  bitDepth: 16 | 24 | 32;
  rangeStartSeconds: number;
  rangeEndSeconds: number;
  tailPolicy: "cut" | "leave" | "wrap";
  tailThresholdDb: number;
  tailQuietSeconds: number;
  maxTailSeconds: number;
  dither: "none" | "tpdf";
  normalization: "off" | "overload" | "peak";
  normalizationCeilingDb: number;
  trimOutputLatency: boolean;
  fileNamePattern: string;
  /** Absolute folder on Core; empty selects the standard Exports folder. */
  outputDirectory?: string;
}

export interface AudioRenderStatus {
  state: "idle" | "rendering" | "complete" | "cancelled" | "failed";
  progress: number;
  jobId?: string;
  phase?: string;
  elapsedSeconds?: number;
  estimatedRemainingSeconds?: number;
  processingSpeedMultiplier?: number;
  processedFrames?: number;
  estimatedTotalFrames?: number;
  outputPath: string;
  /** Absent on older Core versions that supported only one render output. */
  outputPaths?: string[];
  warnings?: string[];
  error: string;
}

export const audioRender = {
  start: async (options: AudioRenderOptions): Promise<void> => {
    const res = await apiFetch("/api/v1/render/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    if (!res.ok) throw new Error(await res.text());
  },
  status: async (): Promise<AudioRenderStatus> => {
    const res = await apiFetch("/api/v1/render/status");
    if (!res.ok) throw new Error(await res.text());
    return res.json<AudioRenderStatus>();
  },
  cancel: async (): Promise<void> => {
    const res = await apiFetch("/api/v1/render/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw new Error(await res.text());
  },
};

export interface PluginCatalogEntry {
  id: string;
  name: string;
  manufacturer: string;
  format: string;
  category?: string;
  version?: string;
  fileOrIdentifier: string;
  instrument: boolean;
  inputs?: number;
  outputs?: number;
  enabled: boolean;
  isNew: boolean;
}

export interface PluginPresetEntry {
  id: string;
  name: string;
  stateBytes: number;
}

export interface PluginPresetList {
  pluginId: string;
  presets: PluginPresetEntry[];
  error: string;
}

export interface PluginCatalogResponse {
  scan: {
    state:
      | "idle"
      | "scanning"
      | "complete"
      | "cancelled"
      | "failed"
      | "unavailable";
    progress: number;
    format: string;
    formatIndex: number;
    formatCount: number;
    formatProgress: number;
    currentPlugin: string;
    error: string;
  };
  catalog: {
    plugins: PluginCatalogEntry[];
    blacklist: string[];
  };
}

export const pluginCatalog = {
  list: async (): Promise<PluginCatalogResponse> => {
    const res = await apiFetch("/api/v1/plugins/list");
    if (!res.ok) throw new Error(await res.text());
    return res.json<PluginCatalogResponse>();
  },
  scan: async (rescanAll = false): Promise<void> => {
    const res = await apiFetch("/api/v1/plugins/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rescanAll }),
    });
    if (!res.ok) throw new Error(await res.text());
  },
  cancelScan: async (): Promise<void> => {
    const res = await apiFetch("/api/v1/plugins/scan/cancel", {
      method: "POST",
    });
    if (!res.ok) throw new Error(await res.text());
  },
  setEnabled: async (pluginId: string, enabled: boolean): Promise<void> => {
    const res = await apiFetch("/api/v1/plugins/enabled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pluginId, enabled }),
    });
    if (!res.ok) throw new Error(await res.text());
  },
};

export const pluginChains = {
  presets: async (pluginId: string): Promise<PluginPresetList> => {
    const response = await apiFetch(
      `/api/v1/plugins/slot/presets?pluginId=${encodeURIComponent(pluginId)}`,
    );
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json() as PluginPresetList;
    if (result.pluginId !== pluginId)
      throw new Error("Core returned presets for a different plug-in");
    return result;
  },
  savePreset: async (stripId: string, slotId: string, name: string) => {
    const accepted = await postProjectCommand(
      "/api/v1/plugins/slot/preset/save", { stripId, slotId, name },
    );
    if (!accepted) throw new Error("Core did not accept the plug-in preset save request");
  },
  loadPreset: async (stripId: string, slotId: string, presetId: string) => {
    const accepted = await postProjectCommand(
      "/api/v1/plugins/slot/preset/load", { stripId, slotId, presetId },
    );
    if (!accepted) throw new Error("Core did not accept the plug-in preset load request");
  },
  parameters: async (stripOrSlotId: string, scopedSlotId?: string): Promise<PluginParameterList> => {
    const slotId = scopedSlotId ?? stripOrSlotId;
    const stripQuery = scopedSlotId === undefined
      ? ""
      : `&stripId=${encodeURIComponent(stripOrSlotId)}`;
    const response = await apiFetch(
      `/api/v1/plugins/slot/parameters?slotId=${encodeURIComponent(slotId)}${stripQuery}`,
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  },
  parameterValues: async (stripOrSlotId: string, scopedSlotId?: string): Promise<PluginParameterValues> => {
    const slotId = scopedSlotId ?? stripOrSlotId;
    const stripQuery = scopedSlotId === undefined
      ? ""
      : `&stripId=${encodeURIComponent(stripOrSlotId)}`;
    const response = await apiFetch(
      `/api/v1/plugins/slot/parameter-values?slotId=${encodeURIComponent(slotId)}${stripQuery}`,
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  },
  add: (stripId: string, pluginId: string) =>
    postEditorMutation("/api/v1/plugins/slot/add", { stripId, pluginId }),
  replace: (stripId: string, slotId: string, pluginId: string) =>
    postEditorMutation("/api/v1/plugins/slot/replace", { stripId, slotId, pluginId }),
  remove: (stripId: string, slotId: string) =>
    postEditorMutation("/api/v1/plugins/slot/remove", { stripId, slotId }),
  move: (stripId: string, slotId: string, toIndex: number, delta?: number) =>
    postEditorMutation(
      "/api/v1/plugins/slot/move",
      delta !== undefined
        ? { stripId, slotId, toIndex, delta }
        : { stripId, slotId, toIndex },
    ),
  setBypassed: (stripId: string, slotId: string, bypassed: boolean) =>
    post("/api/v1/plugins/slot/bypass", { stripId, slotId, bypassed }),
  retry: (stripId: string, slotId: string) =>
    post("/api/v1/plugins/slot/retry", { stripId, slotId }),
  setKeepAwake: (stripId: string, slotId: string, keepAwake: boolean) =>
    post("/api/v1/plugins/slot/keep-awake", { stripId, slotId, keepAwake }),
  park: (stripId: string, slotId: string) =>
    post("/api/v1/plugins/slot/park", { stripId, slotId }),
  unpark: (stripId: string, slotId: string) =>
    post("/api/v1/plugins/slot/unpark", { stripId, slotId }),
  openEditor: (stripId: string, slotId: string) =>
    post("/api/v1/plugins/slot/editor", { stripId, slotId }),
};

// Per-track peak-overview waveform data for the currently-staged song (see
// MainComponent::buildPeaksJson()). Not part of the live WS state -- fetch
// on demand (mount + whenever state.songIndex changes).
export async function fetchPeaks(): Promise<PeaksResponse> {
  const res = await apiFetch("/api/v1/player/peaks");
  return (await res.json()) as PeaksResponse;
}

// Peak data for every song, powering the continuous multi-song Timeline.
// Larger/slower than fetchPeaks() (whole project, not just the staged
// song) -- fetch once on Timeline mount and poll at a slow interval rather
// than on every state tick.
export async function fetchAllPeaks(): Promise<AllPeaksResponse> {
  const res = await apiFetch("/api/v1/player/peaks-all");
  return (await res.json()) as AllPeaksResponse;
}

/**
 * The signal flow the audio thread is rendering right now -- a verbatim
 * projection of the engine's MixGraph (core/engine/audio/MixGraph.h).
 *
 * Deliberately its own endpoint rather than part of the 30 Hz state frame:
 * it only changes when routing does, and only one screen ever wants it.
 */
export async function fetchMixGraph(): Promise<MixGraphPayload> {
  const res = await apiFetch("/api/v1/audio/mixgraph");
  const body = (await res.json()) as { mixGraph?: MixGraphPayload };
  return body.mixGraph ?? { strips: [], edges: [] };
}

export interface WaveformRawResponse {
  sampleRate: number;
  startSec: number;
  samples: number[];
}

// True per-sample window for extreme zoom-in, where even the finest cached
// pyramid level (see PeakLevelData) is coarser than one pixel. `file` is the
// region's archive-relative WAV path (RegionRow.file). Bounded to a few
// seconds server-side -- only call this for a genuinely small visible range.
const rawWaveformCache = new Map<string, WaveformRawResponse>();

export function clearApiCaches(): void {
  rawWaveformCache.clear();
  _continuousInFlight.clear();
  _projectCommandIdentity = null;
}

export async function fetchWaveformRaw(
  file: string,
  startSec: number,
  endSec: number,
): Promise<WaveformRawResponse> {
  const cacheKey = `${file}:${startSec.toFixed(2)}:${endSec.toFixed(2)}`;
  if (rawWaveformCache.has(cacheKey)) {
    return rawWaveformCache.get(cacheKey)!;
  }
  // startSec / endSec, not start / end: the server reads those exact names
  // (WebServer::serveWaveformRaw) and answers 400 to anything else. It had
  // been answering 400 to every single one of these, so the deepest zoom
  // level quietly fell back to binned peaks instead of real samples.
  const url =
    `/api/v1/player/waveform-raw?file=${encodeURIComponent(file)}` +
    `&startSec=${startSec}&endSec=${endSec}`;
  const res = await apiFetch(url);
  const data = (await res.json()) as WaveformRawResponse;
  if (data && data.samples) {
    rawWaveformCache.set(cacheKey, data);
  }
  return data;
}

// Mixer parity -- same calls the native MixerStrip/MixerPanel make, just
// routed from here. `index` is relative to the currently-staged song for
// track commands (matching the native convention), or the bus list for bus
// commands. See AudioEngine::setTrackGainDb et al. and
// MainComponent::drainWebCommands() for the C++ side.
export const mixer = {
  setTrackGain: (index: number, value: number) =>
    postContinuous("/api/v1/track/gain", { index, value }),
  setTrackPan: (index: number, value: number) =>
    postContinuous("/api/v1/track/pan", { index, value }),
  setTrackPanLaw: (index: number, value: number) =>
    post("/api/v1/track/pan-law", { index, value }),
  setTrackMute: (index: number, value: boolean) =>
    post("/api/v1/track/mute", { index, value }),
  setTrackSolo: (index: number, value: boolean) =>
    post("/api/v1/track/solo", { index, value }),
  setTrackSoloSafe: (index: number, value: boolean) =>
    post("/api/v1/track/solo-safe", { index, value }),
  setTrackRecordArm: (index: number, value: boolean) =>
    post("/api/v1/track/arm", { index, value }),
  setTrackInputMonitor: (index: number, value: boolean) =>
    post("/api/v1/track/monitor", { index, value }),
  setFocusedTrack: (index: number) =>
    post("/api/v1/track/focus", { index, value: true }),
  setTrackInputSource: (
    trackIndex: number,
    inputSource: string,
    midiInputChannel: number = 0,
    midiInputDevice: string = "all",
  ) =>
    post("/api/v1/track/input-source", {
      trackIndex,
      inputSource,
      midiInputChannel,
      midiInputDevice,
    }),
  setTrackMono: (index: number, mono: boolean) =>
    post("/api/v1/track/mono", { index, value: mono }),
  setTrackTrim: (
    trackIndex: number,
    inputTrimDb: number,
    phaseInvert: boolean,
    polarity: "none" | "left" | "right" | "both" = phaseInvert
      ? "both"
      : "none",
  ) =>
    postContinuous("/api/v1/track/trim", {
      trackIndex,
      inputTrimDb,
      phaseInvert,
      polarity,
    }),
  setTrackPolarity: (
    trackIndex: number,
    polarity: "none" | "left" | "right" | "both",
    inputTrimDb: number = 0.0,
  ) =>
    postContinuous("/api/v1/track/trim", {
      trackIndex,
      inputTrimDb,
      phaseInvert: polarity !== "none",
      polarity,
    }),
  // Bus assignment for the track's main output -- matches the MixerStrip
  // outputBusBox in the native UI. Empty busId = "(sends only)".
  setTrackBus: (index: number, busId: string) =>
    builder.trackUpdate({ index, busId }),
  setBusGain: (index: number, value: number) =>
    postContinuous("/api/v1/bus/gain", { index, value }),
  setBusPan: (index: number, value: number) =>
    postContinuous("/api/v1/bus/pan", { index, value }),
  setBusMute: (index: number, value: boolean) =>
    post("/api/v1/bus/mute", { index, value }),
  setBusSolo: (index: number, value: boolean) =>
    post("/api/v1/bus/solo", { index, value }),
  setBusSoloSafe: (index: number, value: boolean) =>
    post("/api/v1/bus/solo-safe", { index, value }),
  // Metronome solo -- joins the same solo group as setTrackSolo, silencing
  // every regular track exactly as if one of them had solo engaged. See
  // AudioEngine::setClickSolo(). `index` is unused (server ignores it).
  setClickSolo: (value: boolean) =>
    post("/api/v1/click/solo", { index: 0, value }),
  setClickSoloSafe: (value: boolean) =>
    post("/api/v1/click/solo-safe", { index: 0, value }),
  /**
   * Find-or-create this track's send to busId at `level`, the schema's own
   * 0-100 LINEAR percent (100 = unity / 0 dB). Turning a knob up from its
   * floor implicitly creates the send, so there is no separate "add" call.
   *
   * `enabled` is optional and omitted by the knob: leaving it out means
   * "just move the level", so muting a send from the context menu and then
   * nudging its knob doesn't silently switch it back on.
   */
  setTrackSend: (
    trackIndex: number,
    busId: string,
    level: number,
    enabled?: boolean,
    /** Collapses a knob drag into one undo entry -- see lib/editGesture. */
    gestureId?: string,
    tap?: import("@/lib/state/types").SendTapMode,
  ) =>
    postContinuous("/api/v1/mixer/track/send", {
      trackIndex,
      gestureId,
      busId,
      level,
      ...(enabled === undefined ? {} : { enabled }),
      ...(tap === undefined ? {} : { tap, preFader: tap === "pre-fader" }),
    }),
  // Actually erases the track's TrackSendDef for busId (as opposed to setting
  // its level to 0 or disabling it, both of which keep the send entry). Still
  // used by "Remove all sends" in the strip context menu.
  removeTrackSend: (trackIndex: number, busId: string) =>
    post("/api/v1/mixer/track/send/remove", { trackIndex, busId }),
};

// Project lifecycle. New/loadDialog/save/saveAs just ask the native app to
// do exactly what its own top-bar buttons do -- correct whether this page is
// embedded in the app's webview or not, since any native dialog they pop
// shows up in that same on-screen window (see lib/embedded.ts). upload/
// exportAndDownload are the browser-only equivalents for a client that has
// no such window: a normal <input type=file> upload, and a poll-until-ready
// then <a download> for the reverse direction (avoids ever blocking the
// server's single lws thread on the save that produces the download).
const QUIT_DECISION_INDEX = { cancel: 0, save: 1, discard: 2 } as const;

export const project = {
  new: async () => { await postProjectCommand("/api/v1/project/new"); },
  loadDialog: async () => { await postProjectCommand("/api/v1/project/load-dialog"); },
  save: async () => { await postProjectCommand("/api/v1/project/save"); },
  saveAs: async () => { await postProjectCommand("/api/v1/project/save-as"); },
  // Recent-projects parity -- native-only (no filesystem path model makes
  // sense in a plain browser tab, see ProjectMenu's IS_EMBEDDED gating).
  openRecent: async (path: string) => { await postProjectCommand("/api/v1/project/open-recent", { path }); },
  clearRecent: () => post("/api/v1/project/clear-recent"),
  // Renames the loaded project directly (Project::name), independent of
  // any file path a save/export happens to use -- see WebCommandKind::
  // SetProjectName. Needed because a plain-browser "download" Save As can't
  // otherwise drive the archive's internal name at all (JS never learns the
  // filename the user picked in the OS's own save sheet).
  setName: async (name: string) => { await postProjectCommand("/api/v1/project/name", { name }); },
  // Answers the in-webview "Unsaved Changes" quit prompt (WebUiState.
  // quitConfirmPending) -- see WebCommandKind::QuitDecision.
  resolveQuit: (choice: "save" | "discard" | "cancel") =>
    postProjectCommand("/api/v1/project/quit-decision", {
      index: QUIT_DECISION_INDEX[choice],
    }).then(() => undefined),
  // Answers the in-webview "Unsaved Changes" prompt shown before opening an
  // externally-requested project (WebUiState.openConfirmPending) -- see
  // WebCommandKind::OpenDecision.
  resolveOpen: (choice: "save" | "discard" | "cancel") =>
    postProjectCommand("/api/v1/project/open-decision", {
      index: QUIT_DECISION_INDEX[choice],
    }).then(() => undefined),

  async upload(file: File): Promise<void> {
    try {
      const response = await apiFetch("/api/v1/project/upload", {
        method: "POST",
        body: file,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Core rejected the project upload (HTTP ${response.status})`);
      }
      _triggerRefetch();
    } catch (cause) {
      reportEditorCommandFailure(cause);
    }
  },

  async exportAndDownload(): Promise<void> {
    if (!await postProjectCommand("/api/v1/project/export")) return;
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const res = await apiFetch("/api/v1/project/export-status");
        if (!res.ok)
          throw new Error(`Could not check project export status (HTTP ${res.status})`);
        const body = (await res.json()) as { ready: boolean; fileName: string };
        if (body.ready) {
          const link = document.createElement("a");
          link.href = apiUrl("/api/v1/project/download");
          link.download = body.fileName || "project.rsnraset";
          document.body.appendChild(link);
          link.click();
          link.remove();
          return;
        }
      }
      reportEditorCommandFailure(new Error(
        "Project export is still not ready; Core may still be preparing the download.",
      ));
    } catch (cause) {
      reportEditorCommandFailure(cause);
    }
  },
};

// Builder structural-edit parity -- mirrors BuilderPanel.cpp's
// addItem/removeItem/moveItem/apply*Settings, one call per operation. Every
// payload is a plain JSON object forwarded byte-for-byte to
// MainComponentBuilder.cpp, which does the actual field parsing -- see
// app/web/BuilderJson.h.
export const builder = {
  // noSeed=true skips the default-track scaffolding (clone of the first
  // song's tracks, or the 8 standard names for the very first song) --
  // for callers that build their own exact track list right after (see
  // ImportStemsModal.tsx), since otherwise the seeded tracks silently
  // shift every index the caller assumes is fresh.
  songAdd: (noSeed = false) => postEditorMutation("/api/v1/builder/song/add", { noSeed }),
  songImportFolder: () => post("/api/v1/builder/song/import-folder"),
  songRemove: (index: number) => postEditorMutation("/api/v1/builder/song/remove", { index }),
  /**
   * Move a song's end marker. `endSeconds <= 0` clears the override and lets
   * the song go back to being as long as its content.
   *
   * `gestureId` coalesces a drag into ONE undo entry -- pass the same string
   * for every frame of one drag, and omit it for a discrete edit.
   */
  songEnd: (index: number, endSeconds: number, gestureId?: string) =>
    postEditorMutation("/api/v1/builder/song/end", { index, endSeconds, gestureId }),
  songMove: (index: number, delta: number) =>
    postEditorMutation("/api/v1/builder/song/move", { index, delta }),
  songUpdate: (patch: {
    index: number;
    name: string;
    bpm: number;
    mode: "auto" | "wait";
    tsNum: number;
    tsDen: number;
    click: boolean;
    clickBusId: string;
    clickGainDb?: number;
    clickPan?: number;
    clickMono?: boolean;
    clickName?: string;
    clickSends: { busId: string; level: number; enabled: boolean }[];
    tempoPoints?: { beat: number; bpm: number; timeSeconds: number; curve: number }[];
    signaturePoints?: { beat: number; numerator: number; denominator: number; bar: number }[];
  }) => postEditorMutation("/api/v1/builder/song/update", patch),

  trackAdd: (
    songIndex: number,
    params?: {
      kind?: import("@/lib/state/types").TrackKindWire;
      name?: string;
      channels?: number;
      instrumentPluginId?: string;
    },
  ) => postEditorMutation("/api/v1/builder/track/add", { songIndex, ...params }),
  trackDuplicate: (index: number, withContent = false) =>
    postEditorMutation("/api/v1/builder/track/duplicate", { index, withContent }),
  trackRemove: (songIndex: number, index: number) =>
    postEditorMutation("/api/v1/builder/track/remove", { songIndex, index }),
  trackMove: (
    songIndex: number,
    index: number,
    target: number | { delta?: number; to?: number },
  ) =>
    postEditorMutation(
      "/api/v1/builder/track/move",
      typeof target === "number"
        ? { songIndex, index, delta: target }
        : { songIndex, index, ...target },
    ),
  trackUpdate: (patch: {
    songIndex?: number;
    index: number;
    name?: string;
    busId?: string;
    gainDb?: number;
    pan?: number;
    mute?: boolean;
    solo?: boolean;
    mono?: boolean;
  }) => postEditorMutation("/api/v1/builder/track/update", patch),

  // `gestureId`: pass the same id across several regionAdd/regionRemove/
  // regionUpdate calls that belong to one user gesture (split/duplicate/
  // paste/multi-select delete) so the backend's undo history collapses them
  // into a single undo step instead of N. Leave unset for a normal
  // single-region edit (always its own undo step). See ProjectHistory.h.
  regionAdd: (patch: {
    songIndex: number;
    trackId: string;
    file?: string;
    startSeconds?: number;
    sourceOffsetSeconds?: number;
    durationSeconds?: number;
    gainDb?: number;
    fadeInSeconds?: number;
    fadeOutSeconds?: number;
    fadeInCurve?: number;
    fadeOutCurve?: number;
    loop?: boolean;
    gestureId?: string;
  }) => postEditorMutation("/api/v1/builder/region/add", patch),
  regionRemove: (songIndex: number, regionId: string, gestureId?: string) =>
    postEditorMutation("/api/v1/builder/region/remove", { songIndex, regionId, gestureId }),
  regionUpdate: (patch: {
    songIndex: number;
    regionId: string;
    trackId?: string;
    file?: string;
    startSeconds?: number;
    sourceOffsetSeconds?: number;
    durationSeconds?: number;
    gainDb?: number;
    fadeInSeconds?: number;
    fadeOutSeconds?: number;
    fadeInCurve?: number;
    fadeOutCurve?: number;
    loop?: boolean;
    loopLengthSeconds?: number;
    /** Playback rate; pitch follows it, as on tape. */
    speed?: number;
    semitones?: number;
    reverse?: boolean;
    gestureId?: string;
  }) => postEditorMutation("/api/v1/builder/region/update", patch),

  midiRegionAdd: (patch: {
    songIndex: number;
    trackId: string;
    name?: string;
    startBeats?: number;
    durationBeats?: number;
    clipOffsetBeats?: number;
    loop?: boolean;
    loopLengthBeats?: number;
    loopStartBeats?: number;
    muted?: boolean;
    color?: string;
    notes?: import("@/lib/state/types").MidiNoteRow[];
    events?: import("@/lib/state/types").MidiClipEventRow[];
    umpEvents?: import("@/lib/state/types").MidiUmpEventRow[];
    automationLanes?: import("@/lib/state/types").AutomationLaneRow[];
    gestureId?: string;
  }) => postEditorMutation("/api/v1/builder/midi-region/add", patch),
  midiRegionRemove: (songIndex: number, regionId: string, gestureId?: string) =>
    postEditorMutation("/api/v1/builder/midi-region/remove", {
      songIndex,
      regionId,
      gestureId,
    }),
  midiRegionUpdate: (patch: {
    songIndex: number;
    regionId: string;
    trackId?: string;
    name?: string;
    startBeats?: number;
    durationBeats?: number;
    clipOffsetBeats?: number;
    loop?: boolean;
    loopLengthBeats?: number;
    loopStartBeats?: number;
    muted?: boolean;
    color?: string;
    notes?: import("@/lib/state/types").MidiNoteRow[];
    events?: import("@/lib/state/types").MidiClipEventRow[];
    umpEvents?: import("@/lib/state/types").MidiUmpEventRow[];
    automationLanes?: import("@/lib/state/types").AutomationLaneRow[];
    gestureId?: string;
  }) => postEditorMutation("/api/v1/builder/midi-region/update", patch),

  automationLaneAdd: (patch: {
    songIndex: number;
    regionId?: string;
    domain: import("@/lib/state/types").AutomationDomain;
    entityId: string;
    stripId?: string;
    parameterId: string;
    valueType?: import("@/lib/state/types").ParameterValueType;
    defaultValue?: number;
    minValue?: number;
    maxValue?: number;
    scope?: import("@/lib/state/types").AutomationScope;
    writeMode?: import("@/lib/state/types").AutomationWriteMode;
    enabled?: boolean;
    muted?: boolean;
    initialTimeBeats?: number;
    initialValue?: number;
    points?: import("@/lib/state/types").AutomationPointRow[];
    gestureId?: string;
  }) => postEditorMutation("/api/v1/builder/automation-lane/add", patch),
  automationLaneRemove: (
    songIndex: number,
    laneId: string,
    gestureId?: string,
  ) =>
    postEditorMutation("/api/v1/builder/automation-lane/remove", {
      songIndex,
      laneId,
      gestureId,
    }),
  automationLaneUpdate: (patch: {
    songIndex: number;
    laneId: string;
    enabled?: boolean;
    muted?: boolean;
    writeMode?: import("@/lib/state/types").AutomationWriteMode;
    target?: AutomationTargetRow;
    gestureId?: string;
  }) => postEditorMutation("/api/v1/builder/automation-lane/update", patch),
  automationPointAdd: (patch: {
    songIndex: number;
    laneId: string;
    timeBeats: number;
    value: number;
    curve?: number;
    gestureId?: string;
  }) => postEditorMutation("/api/v1/builder/automation-point/add", patch),
  automationPointRemove: (
    songIndex: number,
    laneId: string,
    timeBeats: number,
    gestureId?: string,
  ) =>
    postEditorMutation("/api/v1/builder/automation-point/remove", {
      songIndex,
      laneId,
      timeBeats,
      gestureId,
    }),
  automationPointsReplace: (patch: {
    songIndex: number;
    laneId: string;
    points: import("@/lib/state/types").AutomationPointRow[];
    gestureId?: string;
  }) => postEditorMutation("/api/v1/builder/automation-points/replace", patch),
  automationRecordGesture: (patch: {
    songIndex: number;
    laneId: string;
    punchInBeats: number;
    releaseBeats: number;
    releaseValue: number;
    returnRampBeats?: number;
    underlyingValue?: number;
    rdpTolerance?: number;
    pointsCompacted?: boolean;
    points: { timeBeats: number; value: number }[];
    gestureId?: string;
  }) => postEditorMutation("/api/v1/builder/automation/record-gesture", patch),
  automationManualOverride: (patch: {
    songIndex: number;
    laneId: string;
    active: boolean;
  }) => postEditorMutation("/api/v1/builder/automation/manual-override", patch),

  async trackImportWAV(
    songIndex: number,
    index: number,
    file: File,
    startSeconds = 0,
  ): Promise<void> {
    await importMediaFile(songIndex, index, file, startSeconds, currentProjectCommandHeaders());
    _triggerRefetch();
  },

  trackImportWav(
    songIndex: number,
    index: number,
    file: File,
    startSeconds = 0,
  ): Promise<void> {
    return this.trackImportWAV(songIndex, index, file, startSeconds);
  },

  // Native "Open Audio File" picker (embedded webview only -- see
  // IS_EMBEDDED gating in AudioTrackLanes.tsx; a plain browser tab has no
  // native window to show the dialog in and keeps the file-input fallback).
  // The Core side pops a JUCE FileChooser and imports the picked file
  // straight from disk, so no upload round-trip happens here.
  trackImportWAVDialog: (songIndex: number, index: number) =>
    post("/api/v1/builder/track/import-wav/dialog", { songIndex, index }),

  trackImportWavDialog(songIndex: number, index: number) {
    return this.trackImportWAVDialog(songIndex, index);
  },

  busAdd: () => postEditorMutation("/api/v1/builder/bus/add"),
  busRemove: (index: number) => postEditorMutation("/api/v1/builder/bus/remove", { index }),
  busMove: (index: number, delta: number) =>
    postEditorMutation("/api/v1/builder/bus/move", { index, delta }),
  busUpdate: (patch: {
    index: number;
    name: string;
    channels: number;
    startChannel: number;
    gainDb: number;
    pan?: number;
    mute: boolean;
    solo: boolean;
    isAux: boolean;
  }) => postEditorMutation("/api/v1/builder/bus/update", patch),

  eventAdd: (songIndex: number) =>
    postEditorMutation("/api/v1/builder/event/add", { songIndex }),
  eventRemove: (songIndex: number, index: number) =>
    postEditorMutation("/api/v1/builder/event/remove", { songIndex, index }),
  eventMove: (songIndex: number, index: number, delta: number) =>
    postEditorMutation("/api/v1/builder/event/move", { songIndex, index, delta }),
  eventUpdate: (patch: {
    songIndex: number;
    index: number;
    type: EventTypeWire;
    timeSeconds: number;
    triggerOnLoad: boolean;
    latencyMs: number;
    midiChannel: number;
    midiProgram: number;
    midiCC: number;
    midiCCValue: number;
    midiNote: number;
    midiVelocity: number;
    httpUrl: string;
  }) => postEditorMutation("/api/v1/builder/event/update", patch),

  // Structural song markers (Intro/Verse/Chorus/Bridge/Outro/Solo/custom).
  // Identity is by sectionId (like regions), not positional index (like
  // events) -- repositioning a marker (drag) is just a startSeconds update.
  sectionAdd: (songIndex: number, startSeconds: number, name?: string) =>
    postEditorMutation("/api/v1/builder/section/add", { songIndex, startSeconds, name }),
  sectionRemove: (songIndex: number, sectionId: string) =>
    postEditorMutation("/api/v1/builder/section/remove", { songIndex, sectionId }),
  sectionUpdate: (patch: {
    songIndex: number;
    sectionId: string;
    name?: string;
    startSeconds?: number;
    colorIndex?: number;
  }) => postEditorMutation("/api/v1/builder/section/update", patch),

  // Per-song cycle locators (Logic-style loop/skip). Coordinates persist even
  // when inactive; AudioEngine applies seeks so every connected client hears
  // the same loop without SPA-side racing.
  cycleUpdate: (patch: {
    songIndex: number;
    active?: boolean;
    skip?: boolean;
    leftSec?: number;
    rightSec?: number;
    gestureId?: string;
  }) => postEditorMutation("/api/v1/builder/cycle/update", patch),
};

// Lighting rig config + fixture roster + Light-timeline tracks/cues -- see
// MainComponentLighting.cpp and RESTORE_POINT.md Feature 6. Mirrors
// `builder` above: same raw-JSON-passthrough routing, field parsing happens
// server-side.
export const lighting = {
  setConfig: (patch: {
    enabled?: boolean;
    kind?: "none" | "resolight" | "dmx::generic";
    resolightColumns?: number;
    resolightRows?: number;
    idleBehavior?: "hold" | "blackout" | "static" | "effect";
    idleColorR?: number;
    idleColorG?: number;
    idleColorB?: number;
    idleIntensity?: number;
    idleEffectType?: string;
    idleEffectRateHz?: number;
    idleGradientPreset?: string;
    idleGradientColors?: string;
    defaultRefreshRateHz?: number;
    artNetTargetHost?: string;
  }) => postEditorMutation("/api/v1/lighting/config", patch),

  fixtureAdd: (name?: string) => postEditorMutation("/api/v1/lighting/fixture/add", { name }),
  fixtureDuplicate: (fixtureId: string) =>
    postEditorMutation("/api/v1/lighting/fixture/duplicate", { fixtureId }),
  fixtureRemove: (fixtureId: string) =>
    postEditorMutation("/api/v1/lighting/fixture/remove", { fixtureId }),

  fixtureUpdate: (patch: {
    fixtureId: string;
    name?: string;
    ledCount?: number;
    addressable?: boolean;
    posX?: number;
    posY?: number;
    posZ?: number;
    rotationYDeg?: number;
    mountedHorizontally?: boolean;
    gridColumn?: number;
    gridRow?: number;
    dmxUniverse?: number;
    dmxStartChannel?: number;
    dmxChannelCount?: number;
    shape?:
      | "bar"
      | "strip"
      | "ring"
      | "matrix"
      | "par"
      | "wash"
      | "spot"
      | "moving-head";
    matrixCols?: number;
    channelProfile?: "dimmer" | "rgb" | "rgbw" | "rgbwa" | "custom";
    tiltDeg?: number;
    refreshRateHz?: number;
    /** Empty string clears the host (back to preview-only). Port is protocol-fixed. */
    networkHost?: string;
  }) => postEditorMutation("/api/v1/lighting/fixture/update", patch),

  trackAdd: () => postEditorMutation("/api/v1/lighting/track/add"),
  trackRemove: (index: number) =>
    postEditorMutation("/api/v1/lighting/track/remove", { index }),
  trackMove: (
    index: number,
    target: number | { delta?: number; to?: number },
  ) =>
    postEditorMutation(
      "/api/v1/lighting/track/move",
      typeof target === "number"
        ? { index, delta: target }
        : { index, ...target },
    ),
  trackUpdate: (patch: {
    index: number;
    name?: string;
    fixtureIds?: string[];
  }) => postEditorMutation("/api/v1/lighting/track/update", patch),

  cueAdd: (
    songIndex: number,
    trackId: string,
    startSeconds: number,
    durationSeconds = 2.0,
    extra?: Partial<LightCueRow> & { gestureId?: string },
  ) =>
    postEditorMutation("/api/v1/lighting/cue/add", {
      songIndex,
      trackId,
      startSeconds,
      durationSeconds,
      ...extra,
    }),
  cueRemove: (songIndex: number, cueId: string) =>
    postEditorMutation("/api/v1/lighting/cue/remove", { songIndex, cueId }),
  cueUpdate: (patch: {
    songIndex: number;
    cueId: string;
    trackId?: string;
    startSeconds?: number;
    durationSeconds?: number;
    colorR?: number;
    colorG?: number;
    colorB?: number;
    intensity?: number;
    fadeInSeconds?: number;
    fadeOutSeconds?: number;
    label?: string;
    // Audio-reactive effect (resolved by both LightEngine and the per-LED
    // websocket stream -- see liveLevels.ts for the live result).
    effectType?:
      | "none"
      | "meter"
      | "strobe"
      | "pulse"
      | "ripple"
      | "converge"
      | "gradientflow"
      | "chase"
      | "helix"
      | "plasma"
      | "twinkle"
      | "sonicboom"
      | "fire"
      | "bouncing"
      | "drip"
      | "fireworks"
      | "colorwaves"
      | "strobeswipe"
      | "vupeak"
      | "geq"
      | "blurz"
      | "scanner"
      | "lightning"
      | "barberpole";
    effectSourceType?: "bus" | "track";
    effectSourceId?: string;
    effectIntensity?: number;
    tempoSync?: boolean;
    tempoSubdiv?: string;
    effectRateHz?: number;
    gradientPreset?:
      | "solid"
      | "greenYellowRed"
      | "custom"
      | "vulcanFire"
      | "toxicFire"
      | "cryoFire"
      | "cyberpunkFire";
    gradientColors?: string;
    blendMode?:
      | "normal"
      | "additive"
      | "multiply"
      | "difference"
      | "lighten"
      | "subtractive";
    gestureId?: string;
  }) => postEditorMutation("/api/v1/lighting/cue/update", patch),
};

// Timeline undo/redo (regions + sections of the currently loaded project).
// See ProjectHistory.h / AudioEngine::undoTimelineEdit()/redoTimelineEdit().
const navigateHistory = createHistoryNavigator({
  fetch: apiFetch,
  origin: backendOrigin,
  serialize: serializeCommand,
  projectIdentity: currentProjectCommandIdentity,
  prepare: async () => {
    cancelActiveDrags();
    // Finish text fields before history, otherwise their later blur can write
    // the pre-Undo draft back into Core and silently create a new branch.
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    flushPendingCommits();
    while (_continuousPromises.size > 0) await Promise.all([..._continuousPromises]);
  },
  applySnapshot: (snapshot) => { _refetchHandler?.(snapshot); },
});
export const timelineHistory = {
  undo: () => navigateHistory("undo"),
  redo: () => navigateHistory("redo"),
};

// Settings parity -- mirrors SettingsPanel.cpp's AudioDeviceSelectorComponent
// callbacks and MIDI/keybinding row handlers. See MainComponentSettings.cpp.
export const settings = {
  setCountInBars: (bars: number) => post("/api/v1/settings/count-in", { bars }),
  setAudioOutputDevice: (name: string) =>
    post("/api/v1/settings/audio-device", { name }),
  setAudioInputDevice: (name: string) =>
    post("/api/v1/settings/audio-input-device", { name }),
  /** Switch host audio API (ASIO / CoreAudio / ALSA / JACK / Windows Audio). */
  setAudioDriver: (type: string) =>
    post("/api/v1/settings/audio-driver", { type }),
  showAudioControlPanel: () => post("/api/v1/settings/audio-control-panel", {}),
  setSampleRate: (value: number) =>
    post("/api/v1/settings/sample-rate", { value }),
  setBufferSize: (value: number) =>
    post("/api/v1/settings/buffer-size", { value }),
  setMIDIOutput: (names: string[] | string) =>
    post("/api/v1/settings/midi-output", Array.isArray(names) ? { names } : { name: names }),
  setMidiOutput(names: string[] | string) {
    return this.setMIDIOutput(names);
  },
  setMIDIInput: (names: string[] | string) =>
    post("/api/v1/settings/midi-input", Array.isArray(names) ? { names } : { name: names }),
  setMidiInput(names: string[] | string) {
    return this.setMIDIInput(names);
  },
  /** Toggles the "ResoStage Sync" virtual MIDI source, for testing DAW clock/transport sync. */
  setMIDIVirtualPort: (enabled: boolean) =>
    post("/api/v1/settings/midi-virtual-port", { enabled }),
  setMidiVirtualPort(enabled: boolean) {
    return this.setMIDIVirtualPort(enabled);
  },
  setUiRenderEngine: (engine: "browser" | "electron") =>
    post("/api/v1/settings/ui-render-engine", { engine }),
  setTheme: (theme: string) => post("/api/v1/settings/theme", { theme }),
  /** Relaunch ResoStage so a changed UI engine takes effect (performAction "restart_app"). */
  restart: () => post("/api/v1/action", { action: "restart_app" }),
  setKeybinding: (action: string, key: string) =>
    post("/api/v1/settings/keybinding", { action, key }),
  // `channels` is the full list of active channel indices (0-based) -- the
  // caller sends the complete set every time, matching the native checkbox
  // list's "whole BigInteger bitmask" semantics.
  setOutputChannels: (channels: number[]) =>
    post("/api/v1/settings/output-channels", { channels }),
  setInputChannels: (channels: number[]) =>
    post("/api/v1/settings/input-channels", { channels }),
  /** Arm MIDI-learn for `action` -- next Note On / CC from the remote is bound. */
  midiLearn: (action: string) =>
    post("/api/v1/settings/midi-learn", { action }),
  midiLearnCancel: () => post("/api/v1/settings/midi-learn-cancel", {}),
  /** Drop any MIDI mapping for `action`. */
  midiClear: (action: string) =>
    post("/api/v1/settings/midi-clear", { action }),
  /** Toggle advanced send tap routing (Pre/Post-Fader, Post-Pan). Client-only. */
  setAdvancedSendRouting: (enabled: boolean) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("resostage:advanced-send-routing", String(enabled));
    }
    // Trigger a refetch so useLiveState picks up the localStorage change
    _triggerRefetch();
    return Promise.resolve();
  },
};
