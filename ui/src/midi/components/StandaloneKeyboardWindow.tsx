// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { VirtualMidiKeyboard } from "@/midi/components/VirtualMidiKeyboard";
import type { WebUiState } from "@/lib/state/types";

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
