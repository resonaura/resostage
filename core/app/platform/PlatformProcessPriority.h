// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#pragma once

namespace resostage {

class PlatformProcessPriority {
public:
    virtual ~PlatformProcessPriority() = default;

    virtual void boostAppProcessPriority() = 0;
    virtual void boostStreamingIoThreadPriority() = 0;
    virtual void demoteBackgroundWorkerPriority() = 0;
    virtual void setBackgroundWorkerIoYielding(bool yielding) = 0;

    static PlatformProcessPriority& getInstance();
};

// Global wrappers
void boostAppProcessPriority();
void boostStreamingIoThreadPriority();
void demoteBackgroundWorkerPriority();
void setBackgroundWorkerIoYielding(bool yielding);

} // namespace resostage
