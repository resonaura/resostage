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

class MessagePumpTimer final : public juce::Timer {
public:
    void timerCallback() override { CefDoMessageLoopWork(); }
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
    const AppSettings settings = loadAppSettings();
    if (settings.uiRenderEngine != "cef")
        return; // default path -- never touch CEF at all

    gLibraryLoader = new CefScopedLibraryLoader();
    if (!gLibraryLoader->LoadInMain()) {
        delete gLibraryLoader;
        gLibraryLoader = nullptr;
        return;
    }

    // Required entry-point check for every CEF process, including the
    // browser process itself -- see this header's doc comment for why this
    // always resolves to "not a subprocess" on the main ResoStage
    // executable specifically.
    const CefMainArgs mainArgs(argc, argv);
    const CefRefPtr<CefApp> app(new ResoStageCefApp());
    CefExecuteProcess(mainArgs, app, nullptr);
}

void initializeIfLoaded() {
    if (gLibraryLoader == nullptr || gInitialized)
        return;

    const CefMainArgs mainArgs(0, nullptr);
    const CefRefPtr<CefApp> app(new ResoStageCefApp());

    CefSettings settings;
    settings.windowless_rendering_enabled = true;
    // TODO(M6): re-evaluate sandboxing now that this is real application
    // code driving a real embedded UI, not the tools/cef_smoke throwaway
    // spike this milestone's design was validated against.
    settings.no_sandbox = true;

    const juce::File helper = resolveHelperExecutable();
    CefString(&settings.browser_subprocess_path) = helper.getFullPathName().toRawUTF8();

    const juce::File cacheDir = resolveCacheDir();
    CefString(&settings.root_cache_path) = cacheDir.getFullPathName().toRawUTF8();

    if (!CefInitialize(mainArgs, settings, app, nullptr))
        return;
    gInitialized = true;

    gPumpTimer = new MessagePumpTimer();
    gPumpTimer->startTimer(10); // ~100Hz, matches CEF's own sample apps

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
