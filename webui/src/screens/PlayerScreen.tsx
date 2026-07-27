import { useEffect, useState } from "react";
import { Button, Card } from "@heroui/react";
import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { fetchPeaks, transport } from "../lib/api";
import { LevelMeterBar } from "../components/LevelMeterBar";
import { Timeline } from "../components/Timeline";
import type { PeaksResponse, WebUiState } from "../lib/types";

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

export function PlayerScreen({ state }: { state: WebUiState }) {
  const [peaks, setPeaks] = useState<PeaksResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    let cancelPoll = false;

    // The background peak build can still be in flight right after a song
    // switch (see MainComponent::maybePublishPeaks()) -- poll briefly until
    // every track has real data instead of freezing on an empty first fetch.
    const poll = async () => {
      for (let attempt = 0; attempt < 20 && !cancelPoll; attempt++) {
        const data = await fetchPeaks().catch(() => null);
        if (cancelled) return;
        if (data) setPeaks(data);
        const complete = data != null && data.tracks.length > 0 && data.tracks.every((t) => t.peaks.length > 0);
        if (complete) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    void poll();

    return () => {
      cancelled = true;
      cancelPoll = true;
    };
  }, [state.songIndex]);

  return (
    <div className="flex flex-col gap-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <Card>
          <Card.Content className="flex flex-col gap-4 pt-6">
            <div className="text-center">
              <div className="text-6xl font-bold tabular-nums">{formatTime(state.playheadSeconds)}</div>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm text-foreground/60">
                <span className={state.playing ? "font-bold text-success" : "font-bold text-danger"}>
                  {state.playing ? "PLAYING" : "STOPPED"}
                </span>
                <span>{state.songName || "No song selected"}</span>
                {state.bpm > 0 && <span>{state.bpm.toFixed(1)} bpm</span>}
                {state.drift !== 1 && <span>drift &times;{state.drift.toFixed(5)}</span>}
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2">
              <Button variant="secondary" onPress={() => transport.prev()}>
                <SkipBack size={18} />
                Prev
              </Button>
              <Button variant="primary" onPress={() => (state.playing ? transport.stop() : transport.play())}>
                {state.playing ? <Pause size={18} /> : <Play size={18} />}
                {state.playing ? "Pause" : "Play"}
              </Button>
              <Button variant="tertiary" onPress={() => transport.stop()}>
                <Square size={18} />
                Stop
              </Button>
              <Button variant="secondary" onPress={() => transport.next()}>
                <SkipForward size={18} />
                Next
              </Button>
            </div>
          </Card.Content>
        </Card>
      </div>

      <Timeline state={state} peaks={peaks} />

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <Card>
          <Card.Header>
            <Card.Title>Setlist</Card.Title>
          </Card.Header>
          <Card.Content className="flex flex-col gap-1">
            {state.songs.length === 0 && (
              <div className="py-6 text-center text-sm text-foreground/50">No songs in this project.</div>
            )}
            {state.songs.map((song, i) => (
              <button
                key={i}
                type="button"
                onClick={() => transport.select(i)}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  i === state.songIndex
                    ? "border-accent bg-accent/10"
                    : "border-transparent hover:bg-default/40"
                }`}
              >
                <span>
                  {i + 1}. {song.name}
                </span>
                <span className="text-xs text-foreground/50">
                  {song.bpm.toFixed(1)} bpm &middot; {song.mode === "auto" ? "auto" : "wait"}
                </span>
              </button>
            ))}
          </Card.Content>
        </Card>

        <Card>
          <Card.Header>
            <Card.Title>Bus meters</Card.Title>
          </Card.Header>
          <Card.Content className="flex flex-col gap-2">
            {state.meters.length === 0 && (
              <div className="py-4 text-center text-sm text-foreground/50">No busses.</div>
            )}
            {state.meters.map((m) => (
              <LevelMeterBar key={m.id} db={m.peakDb} label={m.id} vertical={false} />
            ))}
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}
