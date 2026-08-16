#include "KaishakuAdapter.h"
#include <vector>
#include <cstdlib>
#include <memory>

#if defined(_WIN32)
#include <windows.h>
#include <shellapi.h>
#endif

// kaishaku (介錯) -- Cross-Platform PID Executioner of ResoStage
// Liquidates ONLY our specific target processes by explicit PIDs passed via CLI.

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
