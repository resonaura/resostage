#pragma once
#include "KaishakuAdapter.h"

namespace resostage {

class MacKaishakuAdapter : public KaishakuAdapter {
public:
    bool killPids(const std::vector<int>& pids) override;
    bool isCliMode() const override;
    void showNoPidAlert() const override;
};

} // namespace resostage
