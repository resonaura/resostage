// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { useEffect, useRef } from "react";
import { builder } from "@/lib/state/api";
import type { BusRow } from "@/lib/state/types";
import {
  resolvePendingBusJobs,
  type PendingBusJob,
} from "@/screens/mixer/logic/pendingBusJobs";

/** Create aux/send buses and finalize each after Core publishes its new row. */
export function useMixerSendCreation({
  busses,
  auxBusses,
  master,
}: {
  busses: BusRow[];
  auxBusses: BusRow[];
  master: BusRow | undefined;
}) {
  const pendingBusJobs = useRef<PendingBusJob[]>([]);

  useEffect(() => {
    if (pendingBusJobs.current.length === 0) return;
    pendingBusJobs.current = resolvePendingBusJobs(
      pendingBusJobs.current,
      busses,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busses]);

  function queueBusJob(finalize: (busId: string, index: number) => void) {
    pendingBusJobs.current.push({
      knownIds: new Set(busses.map((bus) => bus.id)),
      finalize,
    });
    void builder.busAdd();
  }

  function requestAddSend() {
    const label = `Send ${auxBusses.length + 1}`;
    // A freshly-added send points at Master (same outs as master) so its
    // destination reads "Master" by default, not an awkward Ext. Out on some
    // stray free channel (which made a just-added send look broken/unrouted).
    const startChannel = master?.startChannel ?? 0;
    queueBusJob((_busId, index) => {
      void builder.busUpdate({
        index,
        name: label,
        channels: 2,
        startChannel,
        gainDb: 0,
        mute: false,
        solo: false,
        isAux: true,
      });
    });
  }

  return { requestAddSend };
}
