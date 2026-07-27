#pragma once

#include <juce_gui_extra/juce_gui_extra.h>

namespace resoset {

// Always prefers the Vite dev server (webui/, port 2900) when it's running
// -- live HMR while iterating on the web UI -- and falls back to whatever
// the embedded WebServer is serving (the last `pnpm build` output, baked
// into the binary via EmbeddedAssets.h) when the dev server isn't reachable
// (e.g. a packaged release running on stage, with no `pnpm dev` around).
class DevOrEmbeddedWebView final : public juce::WebBrowserComponent {
public:
    explicit DevOrEmbeddedWebView(juce::String fallbackUrl)
        : embeddedFallbackUrl(std::move(fallbackUrl) + "?embedded=1") {
        goToURL(devServerUrl);
    }

private:
    bool pageLoadHadNetworkError(const juce::String&) override {
        if (triedFallback) {
            // The embedded fallback itself failed to load (e.g. WebServer
            // hasn't finished starting yet) -- show JUCE's built-in error
            // page rather than bouncing between the two URLs forever.
            return true;
        }
        triedFallback = true;
        goToURL(embeddedFallbackUrl);
        return false;
    }

    // The `?embedded=1` marker lets the SPA tell "I'm running inside this
    // app's own webview" apart from "I'm a plain LAN/localhost browser tab" --
    // see webui/src/lib/embedded.ts. It's how a file-picker/save action
    // decides between driving the native FileChooser (same on-screen window
    // either way) versus a browser upload/download, which is the only option
    // a remote tab has.
    const juce::String devServerUrl = "http://localhost:2900/?embedded=1";
    juce::String embeddedFallbackUrl;
    bool triedFallback = false;
};

} // namespace resoset
