// NSEvent local key-down monitor (see MacKeyMonitor.h for the "why" --
// WKWebView swallows keyDown before Component::keyPressed() ever sees it).
#if defined(__APPLE__)

#import <AppKit/AppKit.h>

#include "MacKeyMonitor.h"

namespace resostage {

namespace {
id keyMonitorToken = nil;
std::function<bool(const juce::KeyPress&)> keyMonitorCallback;

juce::ModifierKeys modifiersFromNSEvent(NSEvent* event) {
    const NSEventModifierFlags flags = event.modifierFlags;
    int mods = 0;
    if (flags & NSEventModifierFlagCommand) mods |= juce::ModifierKeys::commandModifier;
    if (flags & NSEventModifierFlagShift) mods |= juce::ModifierKeys::shiftModifier;
    if (flags & NSEventModifierFlagOption) mods |= juce::ModifierKeys::altModifier;
    if (flags & NSEventModifierFlagControl) mods |= juce::ModifierKeys::ctrlModifier;
    return juce::ModifierKeys(mods);
}
} // namespace

void installMacKeyMonitor(std::function<bool(const juce::KeyPress&)> onKeyDown) {
    uninstallMacKeyMonitor();
    keyMonitorCallback = std::move(onKeyDown);
    id token = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                       handler:^NSEvent*(NSEvent* event) {
        NSString* chars = [event charactersIgnoringModifiers];
        if (chars.length == 0 || !keyMonitorCallback)
            return event;
        // KeyPress::operator== compares ASCII keyCodes case-insensitively
        // (see juce_KeyPress.cpp), so no case-normalization is needed here
        // even though createFromDescription("n") uppercases letter
        // descriptions internally.
        const juce_wchar keyCode = static_cast<juce_wchar>([chars characterAtIndex:0]);
        const juce::KeyPress kp(keyCode, modifiersFromNSEvent(event), 0);
        if (keyMonitorCallback(kp))
            return nil; // consumed -- suppress the WKWebView's own handling
        return event; // not one of ours -- let it flow through to the SPA/DOM normally
    }];
    keyMonitorToken = [token retain];
}

void uninstallMacKeyMonitor() {
    if (keyMonitorToken != nil) {
        [NSEvent removeMonitor:keyMonitorToken];
        [keyMonitorToken release];
        keyMonitorToken = nil;
    }
    keyMonitorCallback = nullptr;
}

} // namespace resostage

#endif
