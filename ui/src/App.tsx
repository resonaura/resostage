import { useState } from "react";
import { useGlobalHotkeys } from "./shell/hooks/useGlobalHotkeys";
import { useTheme } from "./shell/hooks/useTheme";
import { useVirtualKeyboard } from "./midi/hooks/useVirtualKeyboard";
import { StandaloneKeyboardWindow } from "./midi/components/StandaloneKeyboardWindow";
import { VirtualMidiKeyboard } from "./midi/components/VirtualMidiKeyboard";
import { usePerformanceMode } from "./performance/hooks/usePerformanceMode";
import { useProjectPeaks } from "./project/hooks/useProjectPeaks";
import { useTransferWorkflows } from "./transfer/workflows/hooks/useTransferWorkflows";
import { AppDialogLayer } from "./shell/components/AppDialogLayer";
import { AppFooter } from "./shell/components/AppFooter";
import { AppHeader } from "./shell/components/AppHeader";
import { AppNavigation } from "./shell/components/AppNavigation";
import { BackendStatusBanner } from "./shell/components/BackendStatusBanner";
import { HardwareAlarmToasts } from "./shell/components/HardwareAlarmToasts";
import { useCoreExit } from "./shell/hooks/useCoreExit";
import { useHardwareAlarmToasts } from "./shell/hooks/useHardwareAlarmToasts";
import { useRemoteBackend } from "./shell/hooks/useRemoteBackend";
import { useAppShellSync } from "./shell/hooks/useAppShellSync";
import { useLiveState } from "./lib/state/useLiveState";

export default function App() {
  const isStandaloneKeyboardWindow =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("window") ===
      "virtual-keyboard";
  const [tab, setTab] = useState("player");
  const keyboard = useVirtualKeyboard();
  // Tell the backend which SPA tab is active so WS frames only carry that
  // page's heavy arrays (transport/time always included).
  const {
    state,
    status,
    transport,
    effectiveHz,
    cpuHistory,
    ramHistory,
    sendView,
    sendTelemetryHz,
    hasLiveSnapshot,
  } = useLiveState(tab);
  const transferWorkflows = useTransferWorkflows(state);
  const { peaks, allPeaks, pxPerSec, setPxPerSec } = useProjectPeaks(state);
  const coreExit = useCoreExit();
  const hardwareToasts = useHardwareAlarmToasts(state.hardwareAlarm);
  const remote = useRemoteBackend();

  useGlobalHotkeys(state, setTab, keyboard.isOpen);
  // One frame budget for the whole UI -- see usePerformanceMode. Mounted here
  // and only here, so there is exactly one auto ladder deciding it.
  const performance = usePerformanceMode(state.health);
  const theme = useTheme();

  useAppShellSync({
    state,
    tab,
    setTab,
    status,
    effectiveTier: performance.effectiveTier,
    sendView,
    sendTelemetryHz,
    hasLiveSnapshot,
  });

  if (isStandaloneKeyboardWindow) {
    return <StandaloneKeyboardWindow state={state} />;
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <AppHeader
        state={state}
        tab={tab}
        remoteHost={remote.remoteHost}
        onDisconnect={remote.disconnect}
        onRender={transferWorkflows.openRender}
        isVirtualKeyboardOpen={keyboard.isOpen}
        onToggleVirtualKeyboard={keyboard.toggle}
        status={status}
        transport={transport}
        telemetryHz={effectiveHz || state.telemetryHz}
      />

      <BackendStatusBanner
        coreExit={coreExit}
        hasLiveSnapshot={hasLiveSnapshot}
        status={status}
      />

      <AppNavigation
        tab={tab}
        onTabChange={setTab}
        sendView={sendView}
        state={state}
        cpuHistory={cpuHistory}
        ramHistory={ramHistory}
        peaks={peaks}
        allPeaks={allPeaks}
        pxPerSec={pxPerSec}
        setPxPerSec={setPxPerSec}
        onRender={transferWorkflows.openRender}
        performance={performance}
        theme={theme}
      />

      <AppFooter state={state} />

      <AppDialogLayer state={state} transferWorkflows={transferWorkflows} />

      {!window.resostageElectron?.isElectron && (
        <VirtualMidiKeyboard
          state={state}
          isOpen={keyboard.isOpen}
          onClose={() => keyboard.setIsOpen(false)}
        />
      )}

      <HardwareAlarmToasts
        notifications={hardwareToasts.notifications}
        onDismiss={hardwareToasts.dismiss}
      />
    </div>
  );
}
