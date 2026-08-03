// Minimal CEF subprocess entry point. On macOS, every non-browser CEF
// process (renderer, GPU, utility, ...) re-executes a separate Helper.app
// bundle rather than the main app binary -- see the CEF distribution's
// README.txt "REDISTRIBUTION" section. This same binary serves every
// subprocess role; CEF passes --type=... on the command line at relaunch
// time, so the helper itself doesn't need to know its role at compile time.
#include "include/wrapper/cef_library_loader.h"
#include "include/cef_app.h"

int main(int argc, char* argv[]) {
    CefScopedLibraryLoader libraryLoader;
    if (!libraryLoader.LoadInHelper())
        return 1;

    CefMainArgs mainArgs(argc, argv);
    return CefExecuteProcess(mainArgs, nullptr, nullptr);
}
