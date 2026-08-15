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
