#pragma once

// Shared CefApp used by every process role (browser, renderer, GPU,
// utility) -- see CefLifecycle.cpp (browser/main process) and HelperMain.mm
// (every other role). A CefApp instance is per-process; OnBeforeCommandLineProcessing
// runs once inside *each* process before Chromium reads its own switches,
// so this must be wired up everywhere, not just the browser process.
#include "include/cef_app.h"

namespace resostage::cef_lifecycle {

class ResoStageCefApp final : public CefApp {
public:
    void OnBeforeCommandLineProcessing(const CefString&, CefRefPtr<CefCommandLine> commandLine) override {
        // The embedded UI has no login/credential storage of its own --
        // nothing here is worth encrypting with a macOS Keychain-backed
        // key. Without this, Chromium's cookie-encryption path
        // (OSCrypt) silently prompts the user for their system Keychain
        // password the first time it touches cookies -- exactly the kind
        // of surprise a live-performance tool must never cause mid-show.
        // --use-mock-keychain redirects that key storage to an in-memory
        // mock instead of the real Keychain.
        commandLine->AppendSwitch("use-mock-keychain");
    }

private:
    IMPLEMENT_REFCOUNTING(ResoStageCefApp);
};

} // namespace resostage::cef_lifecycle
