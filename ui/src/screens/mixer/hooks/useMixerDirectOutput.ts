/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useCallback, useRef } from "react";
import { mixer } from "@/lib/state/api";
import type { WebUiState } from "@/lib/state/types";
import { extOutTarget } from "@/screens/mixer/logic/mixerIds";
import { patchClickFields } from "@/screens/mixer/logic/mixerUtils";

/** Direct track and metronome routing to device output lanes. */
export function useMixerDirectOutput(state: WebUiState) {
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Output lanes are fabricated by the engine from the device's active output
   * channels (never persisted — see BusRow.isDirectOut). Lanes are always
   * mono, so a stereo pick is a pair of them. We only ever route to these —
   * never create project busses for Ext. Out.
   */
  function directBusIdFor(startChannel: number, pair: boolean): string {
    return extOutTarget(startChannel, pair);
  }

  // Stable identities: every strip is memoised (see TrackStrip), and a handler
  // rebuilt each render would defeat that on its own.
  const requestTrackDirectOutput = useCallback(
    (
      trackIndex: number,
      _mono: boolean,
      startChannel: number,
      pair: boolean,
    ) => {
      // Always switch: the lane id is deterministic from the channel and the
      // engine's routing drops any lane that isn't currently present (shadow /
      // unavailable) to silence without rejecting. Gating on the live bus list
      // here made Ext. Out feel dead on tracks (race the moment a lane isn't
      // yet in state.busses), while master -- a plain project bus -- always
      // switched fine.
      void mixer.setTrackBus(trackIndex, directBusIdFor(startChannel, pair));
    },
    [],
  );

  const requestClickDirectOutput = useCallback(
    (startChannel: number, pair: boolean) => {
      patchClickFields(stateRef.current, {
        clickBusId: directBusIdFor(startChannel, pair),
      });
    },
    [],
  );

  return { requestTrackDirectOutput, requestClickDirectOutput };
}
