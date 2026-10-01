/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "KaishakuAdapter.h"
#include <vector>
#include <cstdlib>
#include <memory>

#if defined(_WIN32)
#include <windows.h>
#include <shellapi.h>
#endif

// Kaishaku -- cross-platform helper for terminating ResoStage processes.
// It acts only on explicit target PIDs passed via the command line.

int runKaishakuMain(int argc, char* argv[]) {
    std::unique_ptr<resostage::KaishakuAdapter> adapter(resostage::createKaishakuAdapter());
    if (!adapter) return 1;

    std::vector<int> pids;
    for (int i = 1; i < argc; ++i) {
        int pid = std::atoi(argv[i]);
        if (pid > 0) pids.push_back(pid);
    }

    if (!pids.empty()) {
        adapter->killPids(pids);
        return 0;
    }

    adapter->showNoPidAlert();
    return 1;
}

#if defined(_WIN32)
int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    int argc = 0;
    LPWSTR* argvW = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::vector<int> pids;
    if (argvW && argc > 1) {
        for (int i = 1; i < argc; ++i) {
            int pid = _wtoi(argvW[i]);
            if (pid > 0) pids.push_back(pid);
        }
        LocalFree(argvW);
    }

    std::unique_ptr<resostage::KaishakuAdapter> adapter(resostage::createKaishakuAdapter());
    if (!adapter) return 1;

    if (!pids.empty()) {
        adapter->killPids(pids);
        return 0;
    }

    adapter->showNoPidAlert();
    return 1;
}
#else
int main(int argc, char* argv[]) {
    return runKaishakuMain(argc, argv);
}
#endif
