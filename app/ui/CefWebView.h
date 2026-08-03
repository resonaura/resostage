#pragma once

// Chromium-backed alternative to DevOrEmbeddedWebView, used when
// RESOSTAGE_ENABLE_CEF is compiled in and the user has selected "cef" in
// Settings (see app/cef/CefLifecycle.h). This is the M4 "software paint"
// milestone: a windowless (off-screen) browser whose BGRA frame buffer is
// copied into a juce::Image and drawn in paint() -- correct and simple, but
// a CPU blit rather than the zero-copy GPU path a later milestone adds.
//
// Only ever constructed on the JUCE message thread, and every CEF callback
// this class receives (OnPaint, OnAfterCreated, OnLoadError, ...) also
// arrives on that same thread: the app's single CefDoMessageLoopWork()
// pump (owned by CefLifecycle) runs from a juce::Timer, and CEF's
// single-threaded (non-multi_threaded_message_loop) mode dispatches all
// client callbacks synchronously from within that pump call. That means no
// cross-thread locking is needed anywhere in this class.
#include "IWebEngineView.h"

#include "include/cef_client.h"

#include <juce_gui_basics/juce_gui_basics.h>

namespace resostage {

class CefWebView final : public juce::Component, public IWebEngineView {
public:
    // `fallbackUrl` matches DevOrEmbeddedWebView's constructor argument --
    // the embedded WebServer's own base URL, tried after the Vite dev
    // server (localhost:2900) fails to load.
    explicit CefWebView(juce::String fallbackUrl);
    ~CefWebView() override;

    juce::Component& getComponent() override { return *this; }

    void paint(juce::Graphics& g) override;
    void resized() override;
    void visibilityChanged() override;
    void focusGained(FocusChangeType) override;
    void focusLost(FocusChangeType) override;

    void mouseDown(const juce::MouseEvent& e) override;
    void mouseUp(const juce::MouseEvent& e) override;
    void mouseDrag(const juce::MouseEvent& e) override;
    void mouseMove(const juce::MouseEvent& e) override;
    void mouseEnter(const juce::MouseEvent& e) override;
    void mouseExit(const juce::MouseEvent& e) override;
    void mouseWheelMove(const juce::MouseEvent& e, const juce::MouseWheelDetails& wheel) override;
    bool keyPressed(const juce::KeyPress& key) override;
    bool keyStateChanged(bool isKeyDown) override;

private:
    // Owns the actual CefClient/CefRenderHandler/CefLifeSpanHandler/
    // CefLoadHandler implementation -- kept separate from this
    // juce::Component because CEF ref-counts client objects
    // (IMPLEMENT_REFCOUNTING overrides new/delete) while this Component is
    // owned by a plain std::unique_ptr in MainComponent; mixing those two
    // ownership models in one object risks a double-free. The browser holds
    // a CefRefPtr to the Handler for as long as it lives, potentially a
    // little past this Component's own destruction (see ~CefWebView), so
    // the Handler forwards callbacks back here through a raw pointer that
    // gets nulled out first.
    class Handler;
    friend class Handler;

    void createBrowser();
    void handlePaint(const void* buffer, int width, int height);
    void handleAfterCreated(CefRefPtr<CefBrowser> browser);
    void handleLoadError();

    juce::String devServerUrl;
    juce::String embeddedFallbackUrl;
    bool triedFallback = false;

    CefRefPtr<Handler> handler;
    CefRefPtr<CefBrowser> browser; // valid once handleAfterCreated() has run
    juce::Image frame;             // last painted frame, ARGB, drawn as-is in paint()
};

} // namespace resostage
