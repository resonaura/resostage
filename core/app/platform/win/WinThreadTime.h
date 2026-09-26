#pragma once

#include "PlatformThreadTime.h"

namespace resostage {

class WinThreadTime final : public PlatformThreadTime {
public:
    double currentThreadCpuMillis() override;
};

} // namespace resostage
