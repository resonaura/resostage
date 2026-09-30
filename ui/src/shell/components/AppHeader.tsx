import { Tooltip } from "@heroui/react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui";
import { GlobalTransportBar } from "@/transport/components/GlobalTransportBar";
import { ProjectMenu } from "@/project/components/ProjectMenu";
import type { RenderDialogIntent } from "@/transfer/render/components/RenderAudioDialog";
import type { WebUiState } from "@/lib/state/types";
import { IS_ELECTRON } from "@/lib/platform/electron";
import { IS_EMBEDDED } from "@/lib/platform/embedded";
import type { TransportKind } from "@/lib/state/useLiveState";
import { ConnectionBadge } from "@/shell/components/ConnectionBadge";

export function AppHeader({
  state,
  tab,
  remoteHost,
  onDisconnect,
  onRender,
  isVirtualKeyboardOpen,
  onToggleVirtualKeyboard,
  status,
  transport,
  telemetryHz,
}: {
  state: WebUiState;
  tab: string;
  remoteHost: string | null;
  onDisconnect: () => void;
  onRender: (intent: RenderDialogIntent) => void;
  isVirtualKeyboardOpen: boolean;
  onToggleVirtualKeyboard: () => void;
  status: "connecting" | "live" | "reconnecting";
  transport: TransportKind;
  telemetryHz: number;
}) {
  return (
    <header className="relative flex h-14 shrink-0 items-center bg-background px-2 sm:px-4">
      <div className="z-10 flex shrink-0 items-center gap-2">
        <img
          src="/logo.svg"
          alt="ResoStage"
          title="ResoStage"
          className="h-7 w-7 shrink-0 object-contain"
          draggable={false}
        />
        {remoteHost ? (
          <div className="flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-0.5 text-warning font-medium text-[11px] border border-warning/30">
            <span className="font-semibold">REMOTE: {remoteHost}</span>
            <button
              type="button"
              onClick={() => void onDisconnect()}
              className="ml-1 text-[10px] text-foreground/70 underline hover:text-foreground cursor-pointer"
            >
              Disconnect
            </button>
          </div>
        ) : null}
      </div>

      {/* Center transport: always mounted, fades out on Player tab. Hidden
          outright on phones -- it cannot fit beside the logo and the status
          badge, and every screen that needs transport has its own.
          Positioned absolutely in the dead center of the header so
          it remains mathematically centered regardless of asymmetric left/right items. */}
      <div
        className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 hidden md:flex items-center justify-center transition-opacity duration-200 ease-out z-20 ${
          tab !== "player" ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="pointer-events-auto">
          <GlobalTransportBar state={state} />
        </div>
      </div>

      <div className="z-10 ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
        {(!IS_EMBEDDED && !IS_ELECTRON) || remoteHost ? (
          <ProjectMenu state={state} onRender={onRender} />
        ) : null}
        {/* Musical Typing / Virtual MIDI Keyboard Toggle */}
        <Tooltip>
          <Button
            isIconOnly
            size="sm"
            variant={isVirtualKeyboardOpen ? "accent-soft" : "default-soft"}
            onPress={onToggleVirtualKeyboard}
            aria-label="Musical Typing Keyboard"
            className={`h-8 w-8 ${isVirtualKeyboardOpen ? "text-accent" : "text-foreground/70 hover:text-foreground"}`}
          >
            <Keyboard size={15} />
          </Button>
          <Tooltip.Content>Musical Typing / Virtual MIDI Keyboard (Cmd+K)</Tooltip.Content>
        </Tooltip>

        <ConnectionBadge
          status={status}
          transport={transport}
          telemetryHz={telemetryHz}
        />
      </div>
    </header>
  );
}
