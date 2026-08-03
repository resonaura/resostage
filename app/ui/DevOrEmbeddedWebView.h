#pragma once

#include "IWebEngineView.h"

#include <juce_gui_extra/juce_gui_extra.h>

#if JUCE_MAC
#include <objc/runtime.h>
#include <objc/message.h>
#endif

namespace resostage {

// Always prefers the Vite dev server (ui/, port 2900) when it's running
// -- live HMR while iterating on the web UI -- and falls back to whatever
// the embedded WebServer is serving (the last `pnpm build` output, baked
// into the binary via EmbeddedAssets.h) when the dev server isn't reachable
// (e.g. a packaged release running on stage, with no `pnpm dev` around).
//
// Live state always uses WebSockets (same path as a remote browser tab).
// Pushing full 30 Hz UI snapshots through JUCE emitEvent/evaluateJavascript
// was tried and is far too expensive for multi-KB JSON frames.
class DevOrEmbeddedWebView final : public juce::WebBrowserComponent, public IWebEngineView {
public:
    juce::Component& getComponent() override { return *this; }

    explicit DevOrEmbeddedWebView(juce::String fallbackUrl)
        : embeddedFallbackUrl(std::move(fallbackUrl) + "?embedded=1") {
        setOpaque(true);
        goToURL(devServerUrl);
    }

    void pageFinishedLoading(const juce::String& url) override {
        juce::WebBrowserComponent::pageFinishedLoading(url);
        if (onPageLoaded) {
            juce::MessageManager::callAsync(onPageLoaded);
        }
    }

    void paint(juce::Graphics& g) override {
        g.fillAll(juce::Colours::black);
    }

    void parentHierarchyChanged() override {
        juce::WebBrowserComponent::parentHierarchyChanged();
        applyNativeWebViewSettings();
    }

    void resized() override {
        juce::WebBrowserComponent::resized();
        applyNativeWebViewSettings();
    }

private:
    void applyNativeWebViewSettings() {
#if JUCE_MAC
        if (auto* peer = getPeer()) {
            if (auto nsView = static_cast<id>(peer->getNativeHandle())) {
                auto configureView = [](auto self, id view) -> void {
                    if (view == nullptr) return;
                    Class wkClass = objc_getClass("WKWebView");
                    if (wkClass && ((bool (*)(id, SEL, Class))objc_msgSend)(view, sel_registerName("isKindOfClass:"), wkClass)) {
                        // ── Black background ──
                        id noVal = ((id (*)(Class, SEL, bool))objc_msgSend)(objc_getClass("NSNumber"), sel_registerName("numberWithBool:"), false);
                        id keyDraws = ((id (*)(Class, SEL, const char*))objc_msgSend)(objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), "drawsBackground");
                        ((void (*)(id, SEL, id, id))objc_msgSend)(view, sel_registerName("setValue:forKey:"), noVal, keyDraws);

                        id blackColor = ((id (*)(Class, SEL))objc_msgSend)(objc_getClass("NSColor"), sel_registerName("blackColor"));
                        id keyBg = ((id (*)(Class, SEL, const char*))objc_msgSend)(objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), "backgroundColor");
                        ((void (*)(id, SEL, id, id))objc_msgSend)(view, sel_registerName("setValue:forKey:"), blackColor, keyBg);

                        SEL selUnder = sel_registerName("setUnderPageBackgroundColor:");
                        if (((bool (*)(id, SEL, SEL))objc_msgSend)(view, sel_registerName("respondsToSelector:"), selUnder)) {
                            ((void (*)(id, SEL, id))objc_msgSend)(view, selUnder, blackColor);
                        }

                        // ── Web Inspector (inspect element) ──
                        id conf = ((id (*)(id, SEL))objc_msgSend)(view, sel_registerName("configuration"));
                        id prefs = ((id (*)(id, SEL))objc_msgSend)(conf, sel_registerName("preferences"));
                        if (prefs != nullptr) {
                            id yesVal = ((id (*)(Class, SEL, bool))objc_msgSend)(objc_getClass("NSNumber"), sel_registerName("numberWithBool:"), true);
                            id keyDev = ((id (*)(Class, SEL, const char*))objc_msgSend)(objc_getClass("NSString"), sel_registerName("stringWithUTF8String:"), "developerExtrasEnabled");
                            ((void (*)(id, SEL, id, id))objc_msgSend)(prefs, sel_registerName("setValue:forKey:"), yesVal, keyDev);
                        }
                    }
                    id subviews = ((id (*)(id, SEL))objc_msgSend)(view, sel_registerName("subviews"));
                    std::size_t count = ((std::size_t (*)(id, SEL))objc_msgSend)(subviews, sel_registerName("count"));
                    for (std::size_t i = 0; i < count; ++i) {
                        id sub = ((id (*)(id, SEL, std::size_t))objc_msgSend)(subviews, sel_registerName("objectAtIndex:"), i);
                        self(self, sub);
                    }
                };
                configureView(configureView, nsView);
            }
        }
#endif
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
        juce::MessageManager::callAsync([this, url = embeddedFallbackUrl] {
            goToURL(url);
        });
        return false;
    }

    // The `?embedded=1` marker lets the SPA tell "I'm running inside this
    // app's own webview" apart from "I'm a plain LAN/localhost browser tab" --
    // see ui/src/lib/embedded.ts. It's how a file-picker/save action
    // decides between driving the native FileChooser (same on-screen window
    // either way) versus a browser upload/download, which is the only option
    // a remote tab has.
    const juce::String devServerUrl = "http://localhost:2900/?embedded=1";
    juce::String embeddedFallbackUrl;
    bool triedFallback = false;
};

} // namespace resostage
