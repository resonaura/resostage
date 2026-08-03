// Minimal CEF subprocess entry point for the real ResoStage app. On macOS,
// every non-browser CEF process (renderer, GPU, utility, ...) re-executes a
// separate Helper.app bundle rather than the main app binary -- see the CEF
// distribution's README.txt "REDISTRIBUTION" section. CEF requires four
// distinctly-named helper bundle variants (base/GPU/Renderer/Plugin) even
// though they all share this exact same trivial main(): each role gets a
// different hardened-runtime entitlement set in a signed build, and CEF's
// own default subprocess-path derivation looks up the bundle by role-
// specific name (confirmed empirically in the tools/cef_smoke spike -- a
// missing "Helper (Renderer)" variant caused CEF to fall back to relaunching
// the *main* app executable as the renderer, which macOS's AppleSystemPolicy
// then denied). CEF passes --type=... on the command line at relaunch time,
// so this one binary doesn't need to know its role at compile time; only
// the bundle name/Info.plist (set in app/CMakeLists.txt) differs per
// variant.
#include "CefAppImpl.h"

#include "include/cef_app.h"
#include "include/wrapper/cef_library_loader.h"

int main(int argc, char* argv[]) {
    CefScopedLibraryLoader libraryLoader;
    if (!libraryLoader.LoadInHelper())
        return 1;

    CefMainArgs mainArgs(argc, argv);
    // Every process independently reads its own command line -- see
    // ResoStageCefApp's doc comment for why the mock-keychain switch must
    // be applied here too, not just in the browser process.
    CefRefPtr<CefApp> app(new resostage::cef_lifecycle::ResoStageCefApp());
    return CefExecuteProcess(mainArgs, app, nullptr);
}
