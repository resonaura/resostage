#pragma once

#include "PlatformThreadTime.h"

namespace resostage {

class MacThreadTime final : public PlatformThreadTime {
public:
    double currentThreadCpuMillis() override;
};

} // namespace resostage
