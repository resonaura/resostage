#pragma once

#include "PlatformThreadTime.h"

namespace resostage {

class LinuxThreadTime final : public PlatformThreadTime {
public:
    double currentThreadCpuMillis() override;
};

} // namespace resostage
