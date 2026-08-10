import { useEffect, useRef, useState } from "react";
import { builder } from "../../lib/api";
import {
  overrunsSong,
  readLongImportPreference,
  writeLongImportPreference,
  type LongImportChoice,
} from "../../lib/importPrefs";
import type { SongRow } from "../../lib/types";

/**
 * Catches audio that lands past the end of the song it was imported into.
 *
 * Watches the project for regions it has never seen rather than wrapping the
 * import calls. There are four ways audio gets in -- drag and drop, the
 * pencil's file picker, the native Open dialog (which the page cannot wrap at
 * all, since Core owns that window), and stem-folder import -- and every one
 * of them ends the same way: a new region in `songs`. One watcher covers all
 * four and cannot be forgotten when a fifth is added.
 *
 * Ids are remembered forever, never removed. Undoing a delete brings a region
 * back with the id it had, and being asked about a region again because it was
 * restored would be nonsense.
 */
export interface LongImportPrompt {
  songIndex: number;
  regionId: string;
  regionStartSeconds: number;
  regionEndSeconds: number;
  songEndSeconds: number;
}

export function useLongImportGuard(songs: SongRow[]): {
  prompt: LongImportPrompt | null;
  resolve: (choice: LongImportChoice, remember: boolean) => void;
  dismiss: () => void;
} {
  const seenRef = useRef<Set<string> | null>(null);
  const [prompt, setPrompt] = useState<LongImportPrompt | null>(null);

  useEffect(() => {
    const first = seenRef.current === null;
    const seen = seenRef.current ?? new Set<string>();
    seenRef.current = seen;

    const fresh: LongImportPrompt[] = [];
    songs.forEach((song, songIndex) => {
      for (const r of song.regions ?? []) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        // Everything already in the project when this mounted is, by
        // definition, not an import that just happened.
        if (first) continue;
        if (r.durationSeconds <= 0) continue; // "runs to the end" cannot overrun it
        const end = r.startSeconds + r.durationSeconds;
        const songEnd = song.endSeconds ?? 0;
        if (!overrunsSong(end, songEnd)) continue;
        fresh.push({
          songIndex,
          regionId: r.id,
          regionStartSeconds: r.startSeconds,
          regionEndSeconds: end,
          songEndSeconds: songEnd,
        });
      }
    });

    if (fresh.length === 0) return;

    // One decision covers the whole batch: a stem folder drops a dozen
    // regions at once and they all overrun by the same amount, so asking
    // twelve times would be a worse bug than the one this fixes.
    const pref = readLongImportPreference();
    if (pref !== "ask") {
      for (const c of fresh) applyChoice(c, pref);
      return;
    }
    setPrompt((current) => current ?? fresh[0]);
    // Only `songs` -- the preference is read at decision time on purpose, so
    // changing it in Settings takes effect on the next import without this
    // having to subscribe to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs]);

  return {
    prompt,
    resolve: (choice, remember) => {
      if (prompt) applyChoice(prompt, choice);
      if (remember) writeLongImportPreference(choice);
      setPrompt(null);
    },
    dismiss: () => setPrompt(null),
  };
}

/** Trim the region to the song, or push the song's end out to the region. */
function applyChoice(c: LongImportPrompt, choice: LongImportChoice): void {
  if (choice === "trim") {
    void builder.regionUpdate({
      songIndex: c.songIndex,
      regionId: c.regionId,
      // Keep at least a sliver. A region that starts past the end marker
      // would otherwise be trimmed to nothing and vanish, which is not what
      // "trim to the song" means -- and losing the import outright is a far
      // worse outcome than a region that needs moving.
      durationSeconds: Math.max(0.05, c.songEndSeconds - c.regionStartSeconds),
    });
    return;
  }
  void builder.songEnd(c.songIndex, c.regionEndSeconds);
}
