/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { lazy, Suspense } from "react";
import type { RenderDialogIntent } from "@/transfer/render/components/RenderAudioDialog";
import type { WebUiState } from "@/lib/state/types";
import { PluginChainModal } from "@/screens/mixer/plugins/PluginChainModal";
import {
  StripContextMenu,
  type StripMenuTarget,
} from "@/screens/mixer/strips/StripContextMenu";

const SignalFlowDialog = lazy(() =>
  import("@/screens/settings/audio/components/SignalFlowDialog").then((module) => ({
    default: module.SignalFlowDialog,
  })),
);

export interface MixerStripTarget {
  stripId: string;
  stripName: string;
}
export type PluginTarget = MixerStripTarget;

/** Context-menu and plug-in-chain overlays owned by the Mixer screen. */
export function MixerOverlays({
  state,
  songIndex,
  menu,
  pluginTarget,
  signalFlowTarget,
  onRender,
  onCloseMenu,
  onClosePlugins,
  onCloseSignalFlow,
}: {
  state: WebUiState;
  songIndex: number;
  menu: StripMenuTarget | null;
  pluginTarget: PluginTarget | null;
  signalFlowTarget: MixerStripTarget | null;
  onRender: (intent: RenderDialogIntent) => void;
  onCloseMenu: () => void;
  onClosePlugins: () => void;
  onCloseSignalFlow: () => void;
}) {
  return (
    <>
      {menu && (
        <StripContextMenu
          target={menu}
          onRender={onRender}
          onClose={onCloseMenu}
        />
      )}
      {pluginTarget && (
        <PluginChainModal
          open
          stripId={pluginTarget.stripId}
          stripName={pluginTarget.stripName}
          track={state.tracks.find(
            (track) => track.id === pluginTarget.stripId,
          )}
          songIndex={songIndex}
          song={state.songs[songIndex]}
          pluginValueIdentity={`${state.stateSessionId ?? ""}:${state.projectEpoch ?? ""}:${state.pluginLoading?.generation ?? 0}`}
          slots={
            pluginTarget.stripId === "audio::click"
              ? (state.click?.plugins ?? [])
              : (state.tracks.find((track) => track.id === pluginTarget.stripId)
                  ?.plugins ??
                state.busses.find((bus) => bus.id === pluginTarget.stripId)
                  ?.plugins ??
                [])
          }
          onClose={onClosePlugins}
        />
      )}
      {signalFlowTarget && (
        <Suspense fallback={null}>
          <SignalFlowDialog
            state={state}
            focusStripId={signalFlowTarget.stripId}
            focusStripName={signalFlowTarget.stripName}
            onClose={onCloseSignalFlow}
          />
        </Suspense>
      )}
    </>
  );
}
