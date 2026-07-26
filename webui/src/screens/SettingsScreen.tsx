import { Card } from "@heroui/react";
import type { WebUiState } from "../lib/types";

function formatBytes(n: number): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-default/30 p-3">
      <div className="text-[11px] uppercase tracking-wide text-foreground/50">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function SettingsScreen({ state }: { state: WebUiState }) {
  const h = state.health;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Card>
        <Card.Header>
          <Card.Title>System health</Card.Title>
        </Card.Header>
        <Card.Content className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="CPU" value={`${h.cpuPercent.toFixed(1)} %`} />
          <Stat label="RAM (RSS)" value={formatBytes(h.rssBytes)} />
          <Stat label="Free RAM" value={formatBytes(h.freeBytes)} />
          <Stat label="Underruns" value={String(h.underrunCount)} />
          <Stat label="Audio callbacks" value={String(h.audioCallbackCount)} />
          <Stat label="Web clients" value={String(h.webClientCount)} />
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Remote</Card.Title>
        </Card.Header>
        <Card.Content>
          <p className="text-sm text-foreground/60">
            This page is the stage remote for the desktop ResoStage app. Transport, mixer meters, and
            project structure update live over WebSocket. Audio device selection, MIDI mapping, and
            keybindings are configured on the desktop Settings tab.
          </p>
        </Card.Content>
      </Card>
    </div>
  );
}
