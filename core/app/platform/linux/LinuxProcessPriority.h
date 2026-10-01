/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "PlatformProcessPriority.h"

namespace resostage {

class LinuxProcessPriority final : public PlatformProcessPriority {
public:
    void boostAppProcessPriority() override {}
    void boostStreamingIoThreadPriority() override {}
    void demoteBackgroundWorkerPriority() override {}
    void setBackgroundWorkerIoYielding(bool /*yielding*/) override {}
};

} // namespace resostage
