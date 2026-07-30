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
// `onKeyDown` receives a juce::KeyPress (comparable via operator== against
// juce::KeyPress::createFromDescription results) plus the raw Mac virtual
// keyCode and the tracked modifier state in JUCE-modifier-flag format.
// The extra params enable physical-keyCode matching for cross-layout
// support (e.g., Cmd+Z on German QWERTZ where kVK_ANSI_Z produces 'y').
// Return true to consume the event; false lets it pass through.
//
// A LOCAL monitor (not global) only fires while this app is the active
// app -- exactly the desired "hotkeys work when the window is focused"
// behavior, no separate focus check needed. No-op on non-Apple builds.
using MacKeyCallback = std::function<bool(const juce::KeyPress&, uint16_t macKeyCode, int juceMods)>;
void installMacKeyMonitor(MacKeyCallback onKeyDown);
void uninstallMacKeyMonitor();

} // namespace resostage
