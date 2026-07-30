// NSEvent local key-down monitor (see MacKeyMonitor.h for the "why" --
// WKWebView swallows keyDown before Component::keyPressed() ever sees it).
#if defined(__APPLE__)

#import <AppKit/AppKit.h>

#include <atomic>

#include "MacKeyMonitor.h"

namespace resostage {

namespace {
id keyMonitorToken = nil;
id flagsMonitorToken = nil;
MacKeyCallback keyMonitorCallback;

// Tracked modifier state (only Cmd/Shift/Option/Ctrl bits).
// Updated by flagsChanged monitor; used in keyDown instead of
// event.modifierFlags which includes device-dependent / "stale" flags.
std::atomic<uint32_t> currentModNSEvent{0};

constexpr NSEventModifierFlags kRelevantMods =
    NSEventModifierFlagCommand | NSEventModifierFlagShift
    | NSEventModifierFlagOption | NSEventModifierFlagControl;

int juceModsFromNSEventFlags(uint32_t nsFlags) {
    int mods = 0;
    if (nsFlags & NSEventModifierFlagCommand) mods |= juce::ModifierKeys::commandModifier;
    if (nsFlags & NSEventModifierFlagShift)   mods |= juce::ModifierKeys::shiftModifier;
    if (nsFlags & NSEventModifierFlagOption)  mods |= juce::ModifierKeys::altModifier;
    if (nsFlags & NSEventModifierFlagControl) mods |= juce::ModifierKeys::ctrlModifier;
    return mods;
}
} // namespace

void installMacKeyMonitor(MacKeyCallback onKeyDown) {
    uninstallMacKeyMonitor();
    keyMonitorCallback = std::move(onKeyDown);
    fprintf(stderr, "[MacKeyMonitor] installMacKeyMonitor called, callback=%s\n",
            keyMonitorCallback ? "valid" : "NULL");

    // Track modifier key state accurately (avoids "stale" flags from
    // event.modifierFlags which reflects current state, not the state
    // at the time a particular key was pressed).
    id ftoken = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskFlagsChanged
                                                       handler:^NSEvent*(NSEvent* event) {
        currentModNSEvent.store((uint32_t)(event.modifierFlags & kRelevantMods),
                                std::memory_order_relaxed);
        return event; // always pass through
    }];
    flagsMonitorToken = [ftoken retain];

    id token = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                       handler:^NSEvent*(NSEvent* event) {
        NSString* chars = [event charactersIgnoringModifiers];
        const unsigned short vk = [event keyCode];
        if (chars.length == 0) {
            fprintf(stderr, "[MacKeyMonitor] chars empty, keyCode=%u, passing through\n", vk);
            return event;
        }
        if (!keyMonitorCallback) {
            fprintf(stderr, "[MacKeyMonitor] callback null, passing through\n");
            return event;
        }
        const juce::juce_wchar keyCode = static_cast<juce::juce_wchar>([chars characterAtIndex:0]);
        // Use TRACKED modifier state instead of event.modifierFlags.
        const uint32_t trackedNseMods = currentModNSEvent.load(std::memory_order_relaxed);
        const int trackedJuceMods = juceModsFromNSEventFlags(trackedNseMods);
        fprintf(stderr, "[MacKeyMonitor] keyDown chars='%lc' vk=%u trackedMods=0x%x\n",
                (wint_t)keyCode, vk, trackedNseMods);
        const juce::KeyPress kp(keyCode, juce::ModifierKeys(trackedJuceMods), 0);
        const bool consumed = keyMonitorCallback(kp, vk, trackedJuceMods);
        fprintf(stderr, "[MacKeyMonitor] -> %s\n", consumed ? "CONSUMED (return nil)" : "passed through");
        if (consumed)
            return nil;
        return event;
    }];
    keyMonitorToken = [token retain];
    fprintf(stderr, "[MacKeyMonitor] token=%p\n", (void*)token);
}

void uninstallMacKeyMonitor() {
    if (flagsMonitorToken != nil) {
        [NSEvent removeMonitor:flagsMonitorToken];
        [flagsMonitorToken release];
        flagsMonitorToken = nil;
    }
    if (keyMonitorToken != nil) {
        [NSEvent removeMonitor:keyMonitorToken];
        [keyMonitorToken release];
        keyMonitorToken = nil;
    }
    keyMonitorCallback = nullptr;
    currentModNSEvent.store(0, std::memory_order_relaxed);
}

} // namespace resostage

#endif
