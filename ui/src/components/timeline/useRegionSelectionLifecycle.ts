import { useEffect, useRef } from "react";
import { allRegionSelKeys, type RegionSelKey } from "./regionUtils";
import type { SongRow } from "../../lib/state/types";

interface RegionSelectionLifecycleOptions {
  songs: SongRow[];
  recording: boolean | undefined;
  setSelectedRegionKeys: (
    value:
      | RegionSelKey[]
      | ((previous: RegionSelKey[]) => RegionSelKey[]),
  ) => void;
}

/** Reconcile region selection with recording completion and project changes. */
export function useRegionSelectionLifecycle({
  songs,
  recording,
  setSelectedRegionKeys,
}: RegionSelectionLifecycleOptions) {
  const recordingWasActiveRef = useRef(false);
  const recordingBaselineRef = useRef<Set<RegionSelKey>>(new Set());
  const awaitingRecordedRegionsRef = useRef(false);

  // Recording completion is a project mutation arriving from Core. Remember
  // the arrangement at Record start and select the newly committed audio
  // regions when the structural snapshot catches up; do not open an editor
  // automatically.
  useEffect(() => {
    const isRecording = recording ?? false;
    if (isRecording && !recordingWasActiveRef.current) {
      recordingBaselineRef.current = new Set(allRegionSelKeys(songs));
      awaitingRecordedRegionsRef.current = false;
    } else if (!isRecording && recordingWasActiveRef.current) {
      awaitingRecordedRegionsRef.current = true;
    }
    recordingWasActiveRef.current = isRecording;

    if (!isRecording && awaitingRecordedRegionsRef.current) {
      const added = allRegionSelKeys(songs).filter(
        (key) => !recordingBaselineRef.current.has(key),
      );
      if (added.length > 0) {
        setSelectedRegionKeys(added);
        awaitingRecordedRegionsRef.current = false;
      }
    }
  }, [recording, songs, setSelectedRegionKeys]);

  // Drop selection entries that no longer exist (delete / project reload).
  useEffect(() => {
    const valid = new Set(allRegionSelKeys(songs));
    setSelectedRegionKeys((previous) => {
      const next = previous.filter((key) => valid.has(key));
      return next.length === previous.length ? previous : next;
    });
  }, [songs, setSelectedRegionKeys]);
}
