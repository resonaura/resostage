import { VirtualMidiKeyboard } from "./VirtualMidiKeyboard";
import type { WebUiState } from "../../../lib/state/types";

export function StandaloneKeyboardWindow({ state }: { state: WebUiState }) {
  return (
    <div className="h-screen w-screen overflow-hidden bg-background select-none text-foreground">
      <VirtualMidiKeyboard
        isOpen={true}
        standalone={true}
        onClose={() => {
          if (window.resostageElectron?.closeKeyboardWindow) {
            void window.resostageElectron.closeKeyboardWindow();
          } else {
            window.close();
          }
        }}
        state={state}
      />
    </div>
  );
}
