import { Button } from "@heroui/react";
import { RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchMixGraph } from "../../lib/api";
import { SignalFlowGraph } from "./SignalFlowGraph";
import type { MixGraphPayload } from "./signalFlowLayout";

/** How often the open diagram re-reads the graph. Routing only changes when
 *  someone turns a knob, so this is about staying live during a soundcheck,
 *  not about frame rate. */
const REFRESH_MS = 700;

const LEGEND: { swatch: string; label: string }[] = [
  { swatch: "bg-default/60", label: "Track / metronome" },
  { swatch: "bg-warning/70", label: "Aux send" },
  { swatch: "tint--subtle0", label: "Master" },
  { swatch: "bg-success/70", label: "Physical output" },
];

export function SignalFlowDialog({ onClose }: { onClose: () => void }) {
  const [graph, setGraph] = useState<MixGraphPayload | null>(null);
  const [error, setError] = useState(false);
  const [live, setLive] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchMixGraph();
        if (!cancelled) {
          setGraph(next);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    };
    void load();
    if (!live) return () => { cancelled = true; };
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [live]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Signal flow"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-xl border border-default/40 bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-default/25 px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">Signal flow</h2>
            <p className="truncate text-[11px] text-foreground/45">
              Exactly what the audio engine is rendering — sources on the left,
              physical outputs on the right.
            </p>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-3">
            {LEGEND.map((item) => (
              <span
                key={item.label}
                className="flex items-center gap-1.5 text-[10px] text-foreground/55"
              >
                <span className={`h-2 w-2 rounded-sm ${item.swatch}`} />
                {item.label}
              </span>
            ))}
            <Button
              size="sm"
              variant={live ? "secondary" : "outline"}
              onPress={() => setLive((v) => !v)}
              className="!h-7 !min-h-0 !px-2 text-[11px]"
              aria-label={
                live
                  ? "Following live changes — click to freeze"
                  : "Frozen — click to follow live changes"
              }
            >
              <RefreshCw size={12} className={live ? "animate-spin [animation-duration:3s]" : ""} />
              {live ? "Live" : "Frozen"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onPress={onClose}
              className="!h-7 !min-h-0 !px-2 text-[11px]"
              aria-label="Close"
            >
              <X size={13} />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1">
          {error ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-warning">
              Couldn't read the routing graph from the engine. Is the ResoStage
              backend running?
            </div>
          ) : graph === null ? (
            <div className="flex h-full items-center justify-center text-sm text-foreground/40">
              Reading routing…
            </div>
          ) : (
            <SignalFlowGraph graph={graph} />
          )}
        </div>

        {graph && graph.strips.length > 0 && (
          <div className="flex shrink-0 items-center gap-4 border-t border-default/25 px-4 py-1.5 text-[10px] text-foreground/40">
            <span>{graph.strips.length} strips</span>
            <span>{graph.edges.length} connections</span>
            <span className="ml-auto">
              Dashed red = silenced by mute or solo · Orange = pre-fader send
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
