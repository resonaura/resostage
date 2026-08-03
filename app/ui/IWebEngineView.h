#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include <functional>

namespace resostage {

// Engine-agnostic handle for whichever component actually renders the
// embedded web UI: the WKWebView-backed DevOrEmbeddedWebView (default), or
// the Chromium-backed CefWebView when RESOSTAGE_ENABLE_CEF is compiled in
// and the user has selected it (see app/cef/CefLifecycle.h). Deliberately
// NOT a juce::Component subclass itself: DevOrEmbeddedWebView already
// extends juce::WebBrowserComponent (itself a Component), and CefWebView is
// a plain Component -- unifying those under one more Component base would
// need virtual inheritance for no real benefit, so callers reach the actual
// Component to add to the layout via getComponent() instead.
class IWebEngineView {
public:
    virtual ~IWebEngineView() = default;

    virtual juce::Component& getComponent() = 0;

    // Fires once the page that actually ended up loading (after any dev-
    // server/embedded-fallback retry -- see each engine's own fallback
    // handling) has finished loading.
    std::function<void()> onPageLoaded;
};

} // namespace resostage
