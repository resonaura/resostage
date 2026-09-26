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
