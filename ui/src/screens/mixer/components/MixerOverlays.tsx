import type { RenderDialogIntent } from "@/transfer/render/components/RenderAudioDialog";
import type { WebUiState } from "@/lib/state/types";
import { PluginChainModal } from "@/screens/mixer/plugins/PluginChainModal";
import {
  StripContextMenu,
  type StripMenuTarget,
} from "@/screens/mixer/strips/StripContextMenu";

export interface PluginTarget {
  stripId: string;
  stripName: string;
}

/** Context-menu and plug-in-chain overlays owned by the Mixer screen. */
export function MixerOverlays({
  state,
  songIndex,
  menu,
  pluginTarget,
  onRender,
  onCloseMenu,
  onClosePlugins,
}: {
  state: WebUiState;
  songIndex: number;
  menu: StripMenuTarget | null;
  pluginTarget: PluginTarget | null;
  onRender: (intent: RenderDialogIntent) => void;
  onCloseMenu: () => void;
  onClosePlugins: () => void;
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
    </>
  );
}
