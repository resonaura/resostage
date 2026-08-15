import { useEffect, useRef, useState } from "react";
import { isRenderActive, setTransportPlaying } from "./appActivity";
import { apiUrl, wsUrl } from "./backend";
import { pushLiveLevels, pushLiveBinaryFrame, setMeterIds, subscribeLiveTransport, subscribeLiveMixerFlags, getLastMixerFlagsMs } from "./liveLevels";
import type { LiveMixerFlags } from "./liveLevels";
import { registerRefetchHandler, unregisterRefetchHandler } from "./api";
import { shareStructure } from "./structuralShare";
import { IS_ELECTRON } from "./electron";
import { IS_EMBEDDED } from "./embedded";
import { emptyState, type WebUiState } from "./types";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";
/** Live-state transport: UDP in embedded (Electron) mode, WS in remote browser mode. */
export type TransportKind = "ws" | "udp" | "none";

/**
 * Merge a partial WS snapshot into the previous state. The server only
 * includes arrays relevant to the active SPA tab (see WebServer::
 * buildStateJson(view)); omitted keys keep their previous values so tab
 * switches don't blank out the UI before the next full-for-view frame.
 *
 * Meter peaks are NOT max-merged here — that would be fake hold. Live
 * levels go through pushLiveLevels() on every frame so ballistics see
 * the true signal including brief silence between metronome hits.
 *
 * Health cpu/ram numbers are frozen here and only applied on the 1 Hz
 * sample tick so the Player widget doesn't jitter.
 */
function mergeState(prev: WebUiState, next: Partial<WebUiState>): WebUiState {
  return shareStructure(prev, buildMergedState(prev, next));
}

function buildMergedState(
  prev: WebUiState,
  next: Partial<WebUiState>,
): WebUiState {
  return {
    ...prev,
    ...next,
    songs: next.songs ?? prev.songs,
    meters: next.meters ?? prev.meters,
    tracks: next.tracks
      ? next.tracks.map((nt) => {
          const pt = prev.tracks.find((t) => t.id === nt.id);
          return {
            ...nt,
            output: {
              ...nt.output,
              sends:
                nt.output.sends.length > 0
                  ? nt.output.sends
                  : (pt?.output?.sends ?? nt.output.sends),
            },
          };
        })
      : prev.tracks,
    busses: next.busses ?? prev.busses,
    health: next.health
      ? {
          // Keep underrun/client counters live; freeze cpu/ram until 1 Hz tick.
          ...prev.health,
          underrunCount: next.health.underrunCount ?? prev.health.underrunCount,
          silentBlockCount:
            next.health.silentBlockCount ?? prev.health.silentBlockCount,
          streamStarveCount:
            next.health.streamStarveCount ?? prev.health.streamStarveCount,
          audioCallbackCount:
            next.health.audioCallbackCount ?? prev.health.audioCallbackCount,
          webClientCount:
            next.health.webClientCount ?? prev.health.webClientCount,
          freeBytes: next.health.freeBytes ?? prev.health.freeBytes,
          processes: prev.health.processes ?? [],
        }
      : prev.health,
    settings: next.settings
      ? {
          ...prev.settings,
          // Only overwrite fields that are actually present & meaningful.
          // Server omits device lists on non-settings views; never treat
          // missing/empty as "clear the UI".
          ...(next.settings.currentOutputDevice !== undefined &&
          next.settings.currentOutputDevice !== ""
            ? { currentOutputDevice: next.settings.currentOutputDevice }
            : {}),
          ...(next.settings.sampleRate !== undefined &&
          next.settings.sampleRate > 0
            ? { sampleRate: next.settings.sampleRate }
            : {}),
          ...(next.settings.bufferSize !== undefined &&
          next.settings.bufferSize > 0
            ? { bufferSize: next.settings.bufferSize }
            : {}),
          outputDevices: next.settings.outputDevices?.length
            ? next.settings.outputDevices
            : prev.settings.outputDevices,
          availableSampleRates: next.settings.availableSampleRates?.length
            ? next.settings.availableSampleRates
            : prev.settings.availableSampleRates,
          availableBufferSizes: next.settings.availableBufferSizes?.length
            ? next.settings.availableBufferSizes
            : prev.settings.availableBufferSizes,
          outputChannelNames: next.settings.outputChannelNames?.length
            ? next.settings.outputChannelNames
            : prev.settings.outputChannelNames,
          activeOutputChannels: next.settings.activeOutputChannels?.length
            ? next.settings.activeOutputChannels
            : prev.settings.activeOutputChannels,
          midiOutputs: next.settings.midiOutputs?.length
            ? next.settings.midiOutputs
            : prev.settings.midiOutputs,
          midiInputs: next.settings.midiInputs?.length
            ? next.settings.midiInputs
            : prev.settings.midiInputs,
          virtualMidiPortEnabled:
            next.settings.virtualMidiPortEnabled ??
            prev.settings.virtualMidiPortEnabled,
          keybindings: next.settings.keybindings ?? prev.settings.keybindings,
          recentProjects:
            next.settings.recentProjects ?? prev.settings.recentProjects,
          midiBindings:
            next.settings.midiBindings ?? prev.settings.midiBindings,
          midiLearnAction:
            next.settings.midiLearnAction ?? prev.settings.midiLearnAction,
          uiRenderEngine:
            next.settings.uiRenderEngine ?? prev.settings.uiRenderEngine,
          theme: next.settings.theme ?? prev.settings.theme,
        }
      : prev.settings,
  };
}

export function useLiveState(view: string = "player") {
  const [state, setState] = useState<WebUiState>(emptyState);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [transport, setTransport] = useState<TransportKind>("none");
  const [cpuHistory, setCpuHistory] = useState<number[]>(() =>
    Array(30).fill(0),
  );
  const [ramHistory, setRamHistory] = useState<number[]>(() =>
    Array(30).fill(0),
  );
  const [effectiveHz, setEffectiveHz] = useState<number>(60);
  // Flips true once the first real WS snapshot has been merged into `state`
  // -- callers that forward `state` elsewhere (e.g. the Electron menu-state
  // bridge) should wait for this rather than sending `emptyState`'s
  // placeholder values on mount.
  const [hasLiveSnapshot, setHasLiveSnapshot] = useState(false);

  const reconnectMsRef = useRef(500);
  const latestHealthRef = useRef<{ cpu: number; ram: number }>({
    cpu: 0,
    ram: 0,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Structural state is rAF-coalesced (latest wins). Meter levels are pushed
  // on every frame into liveLevels so short impulses (metronome) are never
  // dropped by coalesce.
  // The PARSED frame, not the raw text. Every telemetry frame used to be
  // JSON.parse'd twice -- once in onmessage for the meter fallback and again
  // here for the React state -- which at ~20 KB and ~60 frames/s is a couple
  // of megabytes a second of parsing plus two whole object graphs per frame
  // for the collector to clean up. That garbage is what the light preview and
  // the VU meters were periodically stuttering on: they share this thread, so
  // they hitch together on the same GC pause.
  const pendingStateRef = useRef<Partial<WebUiState> | null>(null);
  // Latest v5 mixer flags (mute/solo/soloActiveInGroup) from the UDP frame.
  // Kept separate from pendingStateRef and applied ON TOP of any poll snapshot
  // during the single coalesced flush, so the 60 Hz flags always win over a
  // stale 1 s poll that captured a mid-toggle state. Using one writer (instead
  // of a second direct setState) is what stops rapid solo toggling from
  // reverting the whole console to the greyed "solo active" look for a second.
  const mixerFlagsRef = useRef<LiveMixerFlags | null>(null);
  const rafRef = useRef<number>(0);
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSnapshotRef = useRef(false);

  const applyMixerFlags = (
    prev: WebUiState,
    flags: LiveMixerFlags,
  ): WebUiState => {
    let tracks = prev.tracks;
    let busses = prev.busses;
    if (flags.tracks.length === prev.tracks.length) {
      tracks = prev.tracks.map((t, i) => {
        const f = flags.tracks[i];
        if (
          t.mute === f.mute &&
          t.solo === f.solo &&
          t.soloActiveInGroup === f.soloActiveInGroup
        )
          return t;
        return { ...t, ...f };
      });
    }
    if (flags.busses.length === prev.busses.length) {
      busses = prev.busses.map((b, i) => {
        const f = flags.busses[i];
        if (
          b.mute === f.mute &&
          b.solo === f.solo &&
          b.soloActiveInGroup === f.soloActiveInGroup
        )
          return b;
        return { ...b, ...f };
      });
    }
    if (tracks === prev.tracks && busses === prev.busses) return prev;
    return { ...prev, tracks, busses };
  };

  const flushPending = () => {
    rafRef.current = 0;
    if (flushTimeoutRef.current) {
      clearTimeout(flushTimeoutRef.current);
      flushTimeoutRef.current = null;
    }
    const parsed = pendingStateRef.current;
    pendingStateRef.current = null;
    const flags = mixerFlagsRef.current;
    mixerFlagsRef.current = null;
    if (typeof window !== "undefined" && (window as any).__DEBUG_SOLO && flags) {
      const t = (window as any).__soloLogs = (window as any).__soloLogs || [];
      t.push(["flush", Date.now() - (window as any).__t0, flags.tracks.slice(0,3)]);
    }
    if (parsed == null && flags == null) return;
    setState((prev) => {
      let next = parsed != null ? mergeState(prev, parsed) : prev;
      if (flags != null) next = applyMixerFlags(next, flags);
      return next;
    });
    if (!hasSnapshotRef.current && parsed != null) {
      hasSnapshotRef.current = true;
      setHasLiveSnapshot(true);
    }
  };

  // Coalesce structural state to paint rate via rAF, but never let it go
  // fully silent: a throttled/occluded window (Electron backgroundThrottling
  // edge cases, devtools open, a GPU hiccup) can stall rAF indefinitely, and
  // this is a live-performance app -- the Player screen and 3D lighting
  // preview must not freeze just because the window lost focus/visibility.
  // A setTimeout safety net forces the flush even if rAF never fires.
  const scheduleFlush = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(flushPending);
    if (flushTimeoutRef.current) clearTimeout(flushTimeoutRef.current);
    flushTimeoutRef.current = setTimeout(() => {
      flushTimeoutRef.current = null;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      flushPending();
    }, 100);
  };

  /**
   * Tell the server how fast this client can actually use frames.
   *
   * Purely a cap: the server serves the slower of this and its own
   * backpressure period (see WsSession::requestedPeriodUs). Sending 60 frames
   * a second at a UI repainting 15 times costs a serialize on one side and a
   * parse plus a React commit on the other, for fourteen frames nobody sees.
   *
   * WS only, no HTTP fallback -- it is an optimisation, and a socket that
   * isn't open has nothing to slow down.
   */
  const sendTelemetryHz = (hz: number) => {
    if (hz <= 0) return;
    const clamped = Math.round(hz);
    setEffectiveHz(clamped);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ telemetryHz: clamped }));
      } catch {}
    }
    fetch(apiUrl("/api/v1/settings/telemetry-hz"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telemetryHz: clamped }),
    }).catch(() => {});
  };

  const sendView = (v: string) => {
    // POST is more reliable than WS for this — no dependency on WS state.
    fetch(apiUrl("/api/v1/view"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ view: v }),
    }).catch(() => {
      // Best-effort — the WS send below is the fallback path.
    });

    // Also try WS if open (dual-path for redundancy).
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ view: v }));
      } catch {}
    }
  };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const isEmbeddedMode = IS_EMBEDDED || IS_ELECTRON || ("resostageElectron" in window);

    if (isEmbeddedMode) {
      setTransport("udp");
      setStatus("live");

      const onUdpFrame = (e: Event) => {
        if (cancelled) return;
        const customEvent = e as CustomEvent<Buffer | Uint8Array | ArrayBuffer>;
        const raw = customEvent.detail;
        if (!raw) return;
        let buf: ArrayBuffer;
        if (raw instanceof ArrayBuffer) {
          buf = raw;
        } else if (ArrayBuffer.isView(raw)) {
          const slice = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
          buf = slice as ArrayBuffer;
        } else {
          return;
        }
        pushLiveBinaryFrame(buf);
      };

      window.addEventListener("resostage-udp-telemetry", onUdpFrame);

      const unsubTransport = subscribeLiveTransport((ts) => {
        if (cancelled) return;
        pendingStateRef.current = {
          ...(pendingStateRef.current || {}),
          playing: ts.playing,
          playheadSeconds: ts.playheadSeconds,
          songIndex: ts.songIndex,
          bpm: ts.bpm,
          globalPlayheadSeconds: ts.globalPlayheadSeconds,
          // Forward drift at 60 Hz only when the frame actually carries it
          // (v6+). v5 frames use a 1.0 fallback that must NOT overwrite the
          // real value from the HTTP poll -- that was making drift disappear.
          ...(ts.hasDrift ? { drift: ts.drift } : {}),
        };
        scheduleFlush();
      });

      // v5 mixer flags (mute/solo/soloActiveInGroup) arrive on the same 60 Hz
      // UDP frame. Apply them to the current structural state so a solo/mute
      // toggle responds at paint rate instead of the next 1 s state poll.
      // Index-aligned with state.tracks / state.busses. These go through the
      // SAME coalesced flush as the poll/transport so there is a single writer
      // to state.tracks/busses -- applying them on top of (after) any poll
      // snapshot guarantees the fresh flags win and a mid-toggle poll can't
      // regress the whole console to greyed for ~1 s.
      const unsubMixerFlags = subscribeLiveMixerFlags((flags) => {
        if (cancelled) return;
        if (typeof window !== "undefined" && (window as any).__DEBUG_SOLO) {
          const t = (window as any).__soloLogs = (window as any).__soloLogs || [];
          t.push(["flags", Date.now() - (window as any).__t0, flags.tracks.slice(0,3)]);
        }
        mixerFlagsRef.current = flags;
        scheduleFlush();
      });

      const fetchState = async () => {
        if (cancelled) return;
        try {
          const res = await fetch(apiUrl("/api/v1/state"));
          if (res.ok) {
            const data = (await res.json()) as Partial<WebUiState>;
            if (data.meters) setMeterIds(data.meters.map((m) => m.id));
            if (data.playing !== undefined) setTransportPlaying(data.playing);
            if (data.health) {
              latestHealthRef.current = {
                cpu: Math.max(0, data.health.cpuPercent ?? 0),
                ram: (data.health.rssBytes ?? 0) / (1024 * 1024),
              };
            }
            // If v5 UDP mixer flags have been received within the last 5 s,
            // the UDP path is the authoritative source for mute/solo state.
            // Strip those fields from the HTTP poll snapshot so that a poll
            // that arrived mid-toggle (Core hadn't fully committed the change
            // yet) cannot briefly revert the mixer to the old look while we
            // wait for the next UDP frame to correct it again (~1 s flash).
            // The fields are already applied at 60 Hz via mixerFlagsRef; we
            // only need the poll for the non-flags structural state.
            const udpFlagsActive = Date.now() - getLastMixerFlagsMs() < 5_000;
            let pollData: Partial<WebUiState> = data;
            if (udpFlagsActive && data.tracks) {
              pollData = {
                ...data,
                tracks: data.tracks.map((t) => {
                  const { mute: _m, solo: _s, soloActiveInGroup: _si, ...rest } =
                    t as unknown as Record<string, unknown>;
                  void _m; void _s; void _si;
                  return rest as unknown as typeof t;
                }),
                ...(data.busses
                  ? {
                      busses: data.busses.map((b) => {
                        const { mute: _m, solo: _s, soloActiveInGroup: _si, ...rest } =
                          b as unknown as Record<string, unknown>;
                        void _m; void _s; void _si;
                        return rest as unknown as typeof b;
                      }),
                    }
                  : {}),
              };
            }
            pendingStateRef.current = pollData;
            if (typeof window !== "undefined" && (window as any).__DEBUG_SOLO) {
              const t = (window as any).__soloLogs = (window as any).__soloLogs || [];
              t.push(["poll", Date.now() - (window as any).__t0, data.tracks?.slice(0,3)?.map((x:any)=>({solo:x.solo,si:x.soloActiveInGroup})), "udpActive:", udpFlagsActive]);
            }
            scheduleFlush();
          }
        } catch {}
      };

      // Register as the immediate-refetch target so any post() call
      // (solo, mute, gain commit, etc.) triggers a fresh poll without
      // waiting for the next 1 s interval.
      registerRefetchHandler(() => void fetchState());

      void fetchState();
      const statePollInterval = setInterval(fetchState, 1000);

      const sampleInterval = setInterval(() => {
        if (cancelled) return;
        const sample = latestHealthRef.current;
        setCpuHistory((prev) => [...prev.slice(1), sample.cpu]);
        setRamHistory((prev) => [...prev.slice(1), sample.ram]);
      }, 1000);

      return () => {
        cancelled = true;
        unregisterRefetchHandler();
        unsubTransport();
        unsubMixerFlags();
        window.removeEventListener("resostage-udp-telemetry", onUdpFrame);
        clearInterval(statePollInterval);
        clearInterval(sampleInterval);
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        if (flushTimeoutRef.current) clearTimeout(flushTimeoutRef.current);
      };
    }

    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(wsUrl(), "resoset");
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      setTransport("ws");

      ws.onopen = () => {
        reconnectMsRef.current = 500;
        setStatus("live");
        try {
          ws?.send(JSON.stringify({ view: viewRef.current }));
        } catch {}
      };
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          pushLiveBinaryFrame(ev.data);
          return;
        }

        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        let parsed: Partial<WebUiState>;
        try {
          parsed = JSON.parse(raw) as Partial<WebUiState>;
        } catch {
          return;
        }
        if (parsed.meters) {
          setMeterIds(parsed.meters.map((m) => m.id));
        }
        if (parsed.playing !== undefined) setTransportPlaying(parsed.playing);
        pushLiveLevels({
          clickPeakDb: parsed.clickPeakDb,
          clickPeakDbL: parsed.clickPeakDbL,
          clickPeakDbR: parsed.clickPeakDbR,
          tracks: parsed.tracks,
          meters: parsed.meters,
        });
        if (parsed.health) {
          latestHealthRef.current = {
            cpu: Math.max(0, parsed.health.cpuPercent ?? 0),
            ram: (parsed.health.rssBytes ?? 0) / (1024 * 1024),
          };
        }
        pendingStateRef.current = parsed;
        scheduleFlush();
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {}
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (cancelled) return;
        setStatus("reconnecting");
        reconnectTimer = setTimeout(connect, reconnectMsRef.current);
        reconnectMsRef.current = Math.min(reconnectMsRef.current * 1.5, 4000);
      };
    };

    connect();

    const wakeSocket = () => {
      if (cancelled) return;
      const cur = wsRef.current;
      if (cur && cur.readyState === WebSocket.OPEN) {
        try {
          cur.send(JSON.stringify({ view: viewRef.current }));
        } catch {
          try {
            cur.close();
          } catch {}
        }
        return;
      }
      if (
        !cur ||
        cur.readyState === WebSocket.CLOSED ||
        cur.readyState === WebSocket.CLOSING
      ) {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        connect();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") wakeSocket();
    };
    const onShellResume = () => wakeSocket();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resoshell-resume", onShellResume);

    const sampleInterval = setInterval(() => {
      if (!isRenderActive()) return;
      const sample = latestHealthRef.current;
      setCpuHistory((prev) => [...prev.slice(1), sample.cpu]);
      setRamHistory((prev) => [...prev.slice(1), sample.ram]);
      setState((prev) => {
        const rssBytes = sample.ram * 1024 * 1024;
        if (
          prev.health.cpuPercent === sample.cpu &&
          prev.health.rssBytes === rssBytes
        )
          return prev;
        return {
          ...prev,
          health: { ...prev.health, cpuPercent: sample.cpu, rssBytes },
        };
      });
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(sampleInterval);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (flushTimeoutRef.current) clearTimeout(flushTimeoutRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resoshell-resume", onShellResume);
      ws?.close();
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, []);

  return {
    state,
    status,
    transport,
    effectiveHz,
    cpuHistory,
    ramHistory,
    sendView,
    sendTelemetryHz,
    hasLiveSnapshot,
  };
}
