/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "PlatformShellMode.h"

namespace resostage {

class WinShellMode final : public PlatformShellMode {
public:
    void backOffToHeadlessShell() override {}
    void restoreForegroundShell() override {}
    void activateElectronShell() override {}
};

} // namespace resostage
