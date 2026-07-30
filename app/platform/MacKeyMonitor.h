#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

#include <functional>

namespace resostage {

// NSEvent local key-down monitor for the shared hotkey action catalog.
//
// JUCE's WebBrowserComponent (WKWebView on mac) consumes almost all keyDown
// events itself before they would ever reach Component::keyPressed() --
// confirmed directly in JUCE's own juce_WebBrowserComponent_mac.mm
// (WebViewKeyEquivalentResponder::performKeyEquivalent: only forwards
// cmd+x/c/v/a to the app; everything else is swallowed by the WKWebView).
// Since the embedded SPA is the entire window, MainComponent::keyPressed()
// is effectively dead while it has focus. This local monitor intercepts
// keyDown at the application-event-stream level instead, independent of
// which NSView currently has first-responder focus.
//
// `onKeyDown` receives a juce::KeyPress built to be comparable (via
// operator==) against juce::KeyPress::createFromDescription(...) results,
// matching the same description-string format Project::keybindings and the
// Settings rebind UI already use. Return true to consume the event
// (suppressing the WKWebView's own handling of it); false lets it pass
// through untouched -- e.g. normal typing in a text field.
//
// A LOCAL monitor (not global) only fires while this app is the active
// app -- exactly the desired "hotkeys work when the window is focused"
// behavior, no separate focus check needed. No-op on non-Apple builds.
void installMacKeyMonitor(std::function<bool(const juce::KeyPress&)> onKeyDown);
void uninstallMacKeyMonitor();

} // namespace resostage
