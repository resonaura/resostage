/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once
#include <vector>

namespace resostage {

class KaishakuAdapter {
public:
    virtual ~KaishakuAdapter() = default;

    /** Liquidate target processes by explicit numeric PIDs. */
    virtual bool killPids(const std::vector<int>& pids) = 0;

    /** Check if execution is running in CLI/terminal mode vs GUI file manager. */
    virtual bool isCliMode() const = 0;

    /** Display alert dialog (GUI) or stderr message (CLI) when no PIDs are provided. */
    virtual void showNoPidAlert() const = 0;
};

/** Factory function creating the platform-specific KaishakuAdapter. */
KaishakuAdapter* createKaishakuAdapter();

} // namespace resostage
