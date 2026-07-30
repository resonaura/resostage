import { useEffect, useRef, useState } from "react";
import { wsUrl } from "./backend";
import { pushLiveLevels } from "./liveLevels";
import { emptyState, type WebUiState } from "./types";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";
/** Live-state transport. Currently always WS (see note in connect effect). */
export type TransportKind = "ws" | "none";

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
  return {
    ...prev,
    ...next,
    songs: next.songs ?? prev.songs,
    meters: next.meters ?? prev.meters,
    tracks: next.tracks ?? prev.tracks,
    busses: next.busses ?? prev.busses,
    health: next.health
      ? {
          // Keep underrun/client counters live; freeze cpu/ram until 1 Hz tick.
          ...prev.health,
          underrunCount: next.health.underrunCount ?? prev.health.underrunCount,
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
          midiBindings:
            next.settings.midiBindings ?? prev.settings.midiBindings,
          midiLearnAction:
            next.settings.midiLearnAction ?? prev.settings.midiLearnAction,
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
  const pendingRawRef = useRef<string | null>(null);
  const rafRef = useRef<number>(0);

  const flushPending = () => {
    rafRef.current = 0;
    const raw = pendingRawRef.current;
    pendingRawRef.current = null;
    if (raw == null) return;
    try {
      const parsed = JSON.parse(raw) as Partial<WebUiState>;
      setState((prev) => mergeState(prev, parsed));
      if (parsed.health) {
        latestHealthRef.current = {
          cpu: Math.max(0, parsed.health.cpuPercent ?? 0),
          ram: (parsed.health.rssBytes ?? 0) / (1024 * 1024),
        };
      }
    } catch {
      // ignore malformed
    }
  };

  const sendView = (v: string) => {
    console.log('[sendView]', v);
    // POST is more reliable than WS for this — no dependency on WS state.
    fetch('/api/v1/view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view: v }),
    }).then(r => {
      if (r.ok) console.log('[sendView] POST ok', v);
    }).catch(e => console.warn('[sendView] POST fail', v, e));

    // Also try WS if open (dual-path for redundancy).
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ view: v })); console.log('[sendView] WS sent', v); } catch {}
    }
  };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    // Live state always goes over WebSocket — even inside the embedded
    // webview. JUCE emitEvent/evaluateJavascript for full multi-KB frames at
    // 30 Hz was unusably expensive (UI freeze). Native bridge is only a good
    // fit for small discrete RPCs, not telemetry dumps.
    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(wsUrl(), "resoset");
      wsRef.current = ws;
      setTransport("ws");

      ws.onopen = () => {
        reconnectMsRef.current = 500;
        setStatus("live");
        try {
          ws?.send(JSON.stringify({ view: viewRef.current }));
        } catch {
          // safe to ignore — WS will retry on reconnect
        }
      };
      ws.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        // 1) Levels: every frame, immediately (no drop).
        try {
          const parsed = JSON.parse(raw) as Partial<WebUiState>;
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
        } catch {
          // ignore
        }
        // 2) Full React state: coalesce to paint rate.
        pendingRawRef.current = raw;
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(flushPending);
        }
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          // no-op
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (cancelled) return;
        setStatus("reconnecting");
        reconnectTimer = setTimeout(connect, reconnectMsRef.current);
        reconnectMsRef.current = Math.min(reconnectMsRef.current * 1.5, 4000);
      };
    };

    connect();

    // 1 Hz: sparkline history + freeze CPU/RAM numbers into React state.
    const sampleInterval = setInterval(() => {
      const sample = latestHealthRef.current;
      setCpuHistory((prev) => [...prev.slice(1), sample.cpu]);
      setRamHistory((prev) => [...prev.slice(1), sample.ram]);
      setState((prev) => ({
        ...prev,
        health: {
          ...prev.health,
          cpuPercent: sample.cpu,
          rssBytes: sample.ram * 1024 * 1024,
        },
      }));
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(sampleInterval);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ws?.close();
      wsRef.current = null;
    };
  }, []);

  return { state, status, transport, cpuHistory, ramHistory, sendView };
}
