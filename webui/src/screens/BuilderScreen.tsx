import { Card, Chip } from "@heroui/react";
import type { WebUiState } from "../lib/types";

// Read-only project structure mirror -- structural editing (songs/tracks/
// busses/events) stays on the desktop Builder tab; this remote has no
// mutation endpoints for it (see MixerScreen's note).
export function BuilderScreen({ state }: { state: WebUiState }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Card>
        <Card.Header>
          <Card.Title>{state.projectName || "No project"}</Card.Title>
          <Card.Description>
            {state.songCount} song{state.songCount === 1 ? "" : "s"} &middot; edit structure on the desktop
            Builder tab
          </Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-1">
          {state.songs.map((s, i) => (
            <div
              key={i}
              className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${
                i === state.songIndex ? "bg-accent/10" : ""
              }`}
            >
              <span>
                {i === state.songIndex ? "▶ " : ""}
                {i + 1}. {s.name}
              </span>
              <span className="text-xs text-foreground/50">
                {s.bpm.toFixed(1)} bpm &middot; {s.mode === "auto" ? "auto" : "wait"}
              </span>
            </div>
          ))}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Tracks ({state.tracks.length})</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-1">
          {state.tracks.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm">
              <span>
                {t.name || t.id} &rarr; {t.busId || "?"}
              </span>
              <span className="flex items-center gap-2 text-xs text-foreground/50">
                {t.gainDb.toFixed(1)} dB
                {t.mute && <Chip size="sm" color="danger">M</Chip>}
                {t.solo && <Chip size="sm" color="warning">S</Chip>}
                sends: {t.sends}
              </span>
            </div>
          ))}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Busses ({state.busses.length})</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-1">
          {state.busses.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm">
              <span>
                {b.name || b.id}
                {b.isAux && (
                  <Chip size="sm" color="accent" className="ml-2">
                    AUX
                  </Chip>
                )}
              </span>
              <span className="text-xs text-foreground/50">
                out {b.startChannel} &middot; {b.gainDb.toFixed(1)} dB
              </span>
            </div>
          ))}
        </Card.Content>
      </Card>
    </div>
  );
}
