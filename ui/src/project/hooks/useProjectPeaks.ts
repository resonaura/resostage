/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useEffect, useState } from "react";
import { fetchAllPeaks, fetchPeaks } from "@/lib/state/api";
import type { AllPeaksResponse, PeaksResponse, WebUiState } from "@/lib/state/types";

/** Shared peak data and zoom for the Player and Editor timelines. */
export function useProjectPeaks(state: WebUiState) {
  const [peaks, setPeaks] = useState<PeaksResponse | null>(null);
  const [allPeaks, setAllPeaks] = useState<AllPeaksResponse | null>(null);
  const [pxPerSec, setPxPerSec] = useState(40);

  // Total region count across every song -- changes exactly when a region is
  // added/removed/split (peaks are keyed by file on the backend and a split
  // is served from cache almost instantly, but the poll loops below only run
  // for a bounded window after mount; without this, splitting a region more
  // than ~15s after load left the new region's waveform stuck on stale data
  // forever, since project name / song count / song index don't change on a
  // split -- looking like the peaks needed a slow recompute when they didn't).
  const totalRegionCount = Array.isArray(state.songs)
    ? state.songs.reduce((sum, song) => sum + (song?.regions?.length ?? 0), 0)
    : 0;

  // Per-song peaks (current staged song). Backend publishes each track as it
  // finishes -- poll frequently while filled count climbs, then settle.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      let lastFilled = -1;
      let stable = 0;
      for (let attempt = 0; attempt < 120 && !cancelled; attempt++) {
        const data = await fetchPeaks().catch(() => null);
        if (cancelled) return;
        if (data?.tracks && Array.isArray(data.tracks)) {
          setPeaks(data);
          const filled = data.tracks.filter(
            (track) => track?.levels && track.levels.length > 0,
          ).length;
          if (filled === lastFilled) {
            stable += 1;
            // Empty-lane tracks never get levels, so stop on plateau not on
            // filled === tracks.length.
            if (stable >= 4 && (filled > 0 || attempt > 10)) return;
          } else {
            stable = 0;
            lastFilled = filled;
          }
        }
        const climbing = lastFilled >= 0 && stable === 0;
        await new Promise((resolve) =>
          setTimeout(resolve, climbing ? 150 : attempt < 40 ? 250 : 600),
        );
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [state.projectName, state.songIndex, totalRegionCount]);

  // All-song peaks -- apply every partial so regions light up as the
  // background sweep fills the session cache.
  const songCount = state.songs?.length ?? 0;
  useEffect(() => {
    let cancelled = false;
    // Region count at the moment this effect (re)ran -- the backend emits one
    // payload entry per region, so a payload describing fewer than this is one
    // it built before our change landed.
    const expectedEntries = totalRegionCount;
    const poll = async () => {
      let lastFilled = -1;
      let stable = 0;
      for (let attempt = 0; attempt < 240 && !cancelled; attempt++) {
        const data = await fetchAllPeaks().catch(() => null);
        if (cancelled) return;
        if (data && Array.isArray(data.songs)) {
          setAllPeaks(data);
          // levelsIndex >= 0 means this region's file made it into the shared
          // file table, i.e. its waveform is drawable.
          const filled = data.songs.reduce(
            (count, song) =>
              count +
              (Array.isArray(song?.tracks)
                ? song.tracks.filter((track) => track && track.levelsIndex >= 0).length
                : 0),
            0,
          );
          const total = data.songs.reduce(
            (count, song) =>
              count + (Array.isArray(song?.tracks) ? song.tracks.length : 0),
            0,
          );
          // `total` counts entries in the PAYLOAD, not regions we know about.
          // The backend rebuilds that payload on its own ~30 Hz tick, so the
          // fetch this effect fires the instant a region appears (a split)
          // normally beats it and gets the PREVIOUS blob -- which is
          // internally complete, so this used to return immediately and never
          // look again, leaving the new half spinning forever. Requiring the
          // payload to cover every region we currently have is what closes
          // that race; the plateau check below still ends polls that can
          // never reach it (regions with no audio file never get levels).
          if (total > 0 && total >= expectedEntries && filled >= total) return;
          if (filled === lastFilled) {
            stable += 1;
            if (stable >= 8 && (filled > 0 || attempt > 15)) return;
          } else {
            stable = 0;
            lastFilled = filled;
          }
        }
        await new Promise((resolve) =>
          setTimeout(resolve, attempt < 40 ? 250 : 700),
        );
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [state.projectName, songCount, totalRegionCount]);

  return { peaks, allPeaks, pxPerSec, setPxPerSec };
}
