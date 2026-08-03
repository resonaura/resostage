#include "CefLifecycle.h"

#if RESOSTAGE_ENABLE_CEF

#include "../AppSettings.h"
#include "CefAppImpl.h"

#include "include/cef_app.h"
#include "include/wrapper/cef_library_loader.h"

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include <unistd.h>
#include <vector>

namespace resostage::cef_lifecycle {

namespace {

// Deliberately module-lifetime raw state, not RAII wrapped in a class --
// there is exactly one of these per OS process, constructed once from
// main() (before JUCE exists) and torn down once from
// ResoStageApplication::shutdown(), matching CEF's own one-shot-per-process
// lifecycle contract (see this header's doc comment).
CefScopedLibraryLoader* gLibraryLoader = nullptr;
bool gInitialized = false;
int gArgc = 0;
char** gArgv = nullptr;

class MessagePumpTimer final : public juce::Timer {
public:
    void timerCallback() override {
        if (gInitialized) {
            CefDoMessageLoopWork();
        }
    }
};

MessagePumpTimer* gPumpTimer = nullptr;

// See whenReady's doc comment.
std::vector<std::function<void()>> gReadyCallbacks;

// Resolves "ResoStage.app/Contents/Frameworks/ResoStage Helper.app/Contents/
// MacOS/ResoStage Helper" relative to the running executable, rather than
// relying on CEF's own default per-process-type name derivation -- explicit
// here since browser_subprocess_path is the one thing CefSettings actually
// needs from us; the per-role suffix ("(GPU)"/"(Renderer)"/"(Plugin)")
// lookup for the *other* three helper variants remains CEF's own internal
// logic, unaffected by this field (confirmed in the tools/cef_smoke spike --
// setting this only changes the base path used for the generic/base and
// utility roles).
juce::File resolveHelperExecutable() {
    const juce::File exe = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
    return exe.getParentDirectory()             // Contents/MacOS
        .getParentDirectory()                   // Contents
        .getChildFile("Frameworks")
        .getChildFile("ResoStage Helper.app")
        .getChildFile("Contents")
        .getChildFile("MacOS")
        .getChildFile("ResoStage Helper");
}

// ResoStage explicitly supports running more than one instance at once
// (JUCEApplication::moreThanOneInstanceAllowed() returns true, see
// Main.cpp) -- CEF's own docs warn that sharing one root_cache_path across
// independent processes risks "unintended process singleton behavior"
// (a lock one instance would hold, blocking the others). Giving every
// process its own cache directory, keyed by PID, avoids that entirely; it's
// disk-cache-only state (cookies/local storage for whatever's loaded in the
// embedded UI), not anything worth persisting or sharing across launches.
juce::File resolveCacheDir() {
    const juce::File tmp = juce::File::getSpecialLocation(juce::File::tempDirectory);
    return tmp.getChildFile("ResoStage-CEF-" + juce::String(static_cast<int>(getpid())));
}

} // namespace

void bootstrapIfSelected(int argc, char* argv[]) {
    gArgc = argc;
    gArgv = argv;

    const AppSettings settings = loadAppSettings();
    if (settings.uiRenderEngine != "cef")
        return; // default path -- never touch CEF at all

    gLibraryLoader = new CefScopedLibraryLoader();
    if (!gLibraryLoader->LoadInMain()) {
        delete gLibraryLoader;
        gLibraryLoader = nullptr;
        return;
    }

    const CefMainArgs mainArgs(argc, argv);
    const CefRefPtr<CefApp> app(new ResoStageCefApp());

    int exitCode = CefExecuteProcess(mainArgs, app, nullptr);
    if (exitCode >= 0) {
        exit(exitCode);
    }

    CefSettings settingsObj;
    settingsObj.windowless_rendering_enabled = false;
    settingsObj.no_sandbox = true;
    settingsObj.external_message_pump = true;
    settingsObj.multi_threaded_message_loop = false;

    const juce::File helper = resolveHelperExecutable();
    CefString(&settingsObj.browser_subprocess_path) = helper.getFullPathName().toRawUTF8();

    const juce::File cacheDir = resolveCacheDir();
    CefString(&settingsObj.root_cache_path) = cacheDir.getFullPathName().toRawUTF8();

    if (CefInitialize(mainArgs, settingsObj, app, nullptr)) {
        gInitialized = true;
    }
}

void initializeIfLoaded() {
    if (gLibraryLoader == nullptr || !gInitialized)
        return;

    if (gPumpTimer == nullptr) {
        gPumpTimer = new MessagePumpTimer();
        gPumpTimer->startTimer(16); // ~60 FPS, non-blocking with external_message_pump = true
    }

    // Anything that queued up while waiting for initialization (see
    // whenReady) can now safely create browsers etc.
    const auto callbacks = std::move(gReadyCallbacks);
    gReadyCallbacks.clear();
    for (const auto& cb : callbacks)
        cb();
}

void whenReady(std::function<void()> callback) {
    if (gInitialized) {
        callback();
        return;
    }
    gReadyCallbacks.push_back(std::move(callback));
}

void shutdownIfInitialized() {
    if (gPumpTimer != nullptr) {
        gPumpTimer->stopTimer();
        delete gPumpTimer;
        gPumpTimer = nullptr;
    }
    if (gInitialized) {
        for (int i = 0; i < 20; ++i) {
            CefDoMessageLoopWork();
        }
        CefShutdown();
        gInitialized = false;
    }
    if (gLibraryLoader != nullptr) {
        delete gLibraryLoader; // ~CefScopedLibraryLoader() unloads the framework
        gLibraryLoader = nullptr;
    }
}

} // namespace resostage::cef_lifecycle

#endif // RESOSTAGE_ENABLE_CEF
