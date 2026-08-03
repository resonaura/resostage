// Standalone CEF spike -- no JUCE involved. Validates that this repo can
// actually fetch/build/link/bundle CEF on macOS and that a windowless
// (off-screen) browser renders a frame, before any of that machinery gets
// wired into the real ResoStage app (see the CEF integration plan's later
// milestones). `no_sandbox` is intentionally on here to keep this spike
// focused on the framework-loading/bundling/subprocess-relaunch mechanics;
// the real app milestone re-evaluates sandboxing on its own.
#include "include/wrapper/cef_library_loader.h"
#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_render_handler.h"

#import <Cocoa/Cocoa.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <thread>

namespace {

class SmokeRenderHandler final : public CefRenderHandler {
public:
    void GetViewRect(CefRefPtr<CefBrowser>, CefRect& rect) override { rect.Set(0, 0, 320, 240); }

    void OnPaint(CefRefPtr<CefBrowser>, PaintElementType, const RectList&, const void*, int width,
                int height) override {
        fprintf(stderr, "[cef_smoke] OnPaint %dx%d\n", width, height);
        gotPaint.store(true);
    }

    std::atomic<bool> gotPaint{false};

    IMPLEMENT_REFCOUNTING(SmokeRenderHandler);
};

class SmokeClient final : public CefClient {
public:
    explicit SmokeClient(CefRefPtr<SmokeRenderHandler> renderHandler) : renderHandler_(std::move(renderHandler)) {}

    CefRefPtr<CefRenderHandler> GetRenderHandler() override { return renderHandler_; }

private:
    CefRefPtr<SmokeRenderHandler> renderHandler_;

    IMPLEMENT_REFCOUNTING(SmokeClient);
};

} // namespace

int main(int argc, char* argv[]) {
    CefScopedLibraryLoader libraryLoader;
    if (!libraryLoader.LoadInMain()) {
        fprintf(stderr, "[cef_smoke] FAILURE: could not load the CEF framework\n");
        return 1;
    }

    CefMainArgs mainArgs(argc, argv);
    CefRefPtr<CefApp> app;
    const int subprocessExitCode = CefExecuteProcess(mainArgs, app, nullptr);
    if (subprocessExitCode >= 0)
        return subprocessExitCode; // this invocation was actually a relaunched helper subprocess

    // CEF's browser process needs a functioning NSApplication to bootstrap
    // its GPU/compositor path, same as any real embedding app would already
    // provide (JUCE creates its own NSApplication when the real app links
    // this in -- see the M3 lifecycle-wiring milestone).
    [NSApplication sharedApplication];

    CefSettings settings;
    settings.windowless_rendering_enabled = true;
    settings.no_sandbox = true;

    if (!CefInitialize(mainArgs, settings, app, nullptr)) {
        fprintf(stderr, "[cef_smoke] FAILURE: CefInitialize failed\n");
        return 1;
    }

    CefWindowInfo windowInfo;
    windowInfo.SetAsWindowless(kNullWindowHandle);
    CefBrowserSettings browserSettings;
    CefRefPtr<SmokeRenderHandler> renderHandler = new SmokeRenderHandler();
    CefRefPtr<SmokeClient> client = new SmokeClient(renderHandler);
    CefBrowserHost::CreateBrowser(windowInfo, client, "data:text/html,<h1>cef_smoke</h1>", browserSettings, nullptr,
                                  nullptr);

    // Pump the message loop ourselves (never CefRunMessageLoop -- the real
    // app drives this via a juce::Timer on the message thread instead) until
    // the first frame renders or a timeout proves something's wrong.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
    while (!renderHandler->gotPaint.load() && std::chrono::steady_clock::now() < deadline) {
        CefDoMessageLoopWork();
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    const bool ok = renderHandler->gotPaint.load();
    fprintf(stderr, ok ? "[cef_smoke] SUCCESS: received at least one OnPaint frame\n"
                        : "[cef_smoke] FAILURE: no OnPaint before the timeout\n");

    CefShutdown();
    return ok ? 0 : 2;
}
