/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

namespace resostage {

class PlatformThreadTime {
public:
    virtual ~PlatformThreadTime() = default;
    virtual double currentThreadCpuMillis() = 0;

    static PlatformThreadTime& getInstance();
};

double currentThreadCpuMillis();

} // namespace resostage
