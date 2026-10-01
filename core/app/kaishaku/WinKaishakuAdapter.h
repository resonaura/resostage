// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#pragma once
#include "KaishakuAdapter.h"

namespace resostage {

class WinKaishakuAdapter : public KaishakuAdapter {
public:
    bool killPids(const std::vector<int>& pids) override;
    bool isCliMode() const override;
    void showNoPidAlert() const override;
};

} // namespace resostage
