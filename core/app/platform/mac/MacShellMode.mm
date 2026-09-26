#if defined(__APPLE__)

#import <AppKit/AppKit.h>
#include <cstring>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <unordered_map>

#include "MacShellMode.h"

namespace resostage {

void MacShellMode::backOffToHeadlessShell() {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
}

void MacShellMode::restoreForegroundShell() {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp activateIgnoringOtherApps:YES];
}

void MacShellMode::makeWindowKeyAndActive(void* nativeHandle) {
    if (nativeHandle == nullptr) return;
    NSView* peerView = (__bridge NSView*)nativeHandle;
    NSWindow* window = [peerView window];
    if (window != nil) {
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [NSApp activateIgnoringOtherApps:YES];
        [window makeKeyAndOrderFront:nil];
    }
}

void MacShellMode::forwardFocusToPluginNativeView(void* nativeHandle) {
    if (nativeHandle == nullptr) return;
    NSView* peerView = (__bridge NSView*)nativeHandle;
    NSWindow* window = [peerView window];
    if (window == nil) return;

    [window makeKeyAndOrderFront:nil];

    // Find any embedded third-party or AU subview inside peerView
    NSView* targetView = nil;
    for (NSView* subview in [peerView subviews]) {
        if (subview != peerView) {
            targetView = subview;
            break;
        }
    }

    if (targetView != nil) {
        if ([targetView acceptsFirstResponder])
            [window makeFirstResponder:targetView];
        else if (auto* next = [targetView nextValidKeyView])
            [window makeFirstResponder:next];
        else
            [window makeFirstResponder:targetView];
    } else {
        [window makeFirstResponder:peerView];
    }
}

bool MacShellMode::isNativeTextInputFocused(void* nativeHandle) {
    if (nativeHandle == nullptr) return false;
    NSView* peerView = (__bridge NSView*)nativeHandle;
    NSWindow* window = [peerView window];
    if (window == nil) return false;

    NSResponder* first = [window firstResponder];
    if (first == nil) return false;

    // In Cocoa, active text editing is handled by an editable NSTextView (or window's fieldEditor)
    if ([first isKindOfClass:[NSTextView class]]) {
        NSTextView* textView = (NSTextView*)first;
        if ([textView isEditable])
            return true;
    }
    return false;
}

struct PluginWindowObserverEntry {
    id notificationObserver = nil;
    id eventMonitor = nil;
};

static std::unordered_map<void*, PluginWindowObserverEntry> s_pluginWindowObservers;

void MacShellMode::setupPluginWindow(void* nativeHandle,
                                     std::function<void()> onTogglePlay,
                                     std::function<void()> onClose) {
    if (nativeHandle == nullptr) return;
    NSView* peerView = (__bridge NSView*)nativeHandle;
    NSWindow* window = [peerView window];
    if (window == nil) return;

    cleanupPluginWindow(nativeHandle);

    PluginWindowObserverEntry entry;
    entry.notificationObserver = [[NSNotificationCenter defaultCenter]
        addObserverForName:NSWindowDidBecomeKeyNotification
        object:window
        queue:[NSOperationQueue mainQueue]
        usingBlock:^(NSNotification*) {
            [NSApp activateIgnoringOtherApps:YES];
        }];

    entry.eventMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
        handler:^NSEvent*(NSEvent* event) {
            NSWindow* eventWin = [event window];
            if (eventWin == nil)
                eventWin = [NSApp keyWindow];
            if (eventWin != nil && eventWin != window)
                return event;

            // If active text input is focused in the plugin, allow typing unimpeded
            if (isNativeTextInputFocused(nativeHandle))
                return event;

            constexpr NSEventModifierFlags kModifierMask =
                NSEventModifierFlagCommand | NSEventModifierFlagOption |
                NSEventModifierFlagControl | NSEventModifierFlagShift;

            const NSEventModifierFlags activeMods = [event modifierFlags] & kModifierMask;
            const unsigned short keyCode = [event keyCode];

            // Spacebar (keyCode 49) without modifiers -> toggle transport
            if (keyCode == 49 && activeMods == 0) {
                if (onTogglePlay)
                    onTogglePlay();
                return nil;
            }

            // Escape (keyCode 53) without command/option/control -> close window
            if (keyCode == 53 && (activeMods & ~NSEventModifierFlagShift) == 0) {
                hidePluginWindow(nativeHandle);
                if (onClose)
                    onClose();
                return nil;
            }

            // Cmd+W (Command+W, layout-independent) -> close window
            const BOOL isW = (keyCode == 13) ||
                ([[event charactersIgnoringModifiers] caseInsensitiveCompare:@"w"] == NSOrderedSame);
            if (isW && (activeMods & NSEventModifierFlagCommand) != 0) {
                hidePluginWindow(nativeHandle);
                if (onClose)
                    onClose();
                return nil;
            }

            return event;
        }];

    s_pluginWindowObservers[nativeHandle] = entry;
}

void MacShellMode::cleanupPluginWindow(void* nativeHandle) {
    if (nativeHandle == nullptr) return;
    auto it = s_pluginWindowObservers.find(nativeHandle);
    if (it != s_pluginWindowObservers.end()) {
        if (it->second.notificationObserver != nil) {
            [[NSNotificationCenter defaultCenter] removeObserver:it->second.notificationObserver];
        }
        if (it->second.eventMonitor != nil) {
            [NSEvent removeMonitor:it->second.eventMonitor];
        }
        s_pluginWindowObservers.erase(it);
    }
}

void MacShellMode::hidePluginWindow(void* nativeHandle) {
    if (nativeHandle == nullptr) return;
    NSView* peerView = (__bridge NSView*)nativeHandle;
    NSWindow* window = [peerView window];
    if (window != nil) {
        [window makeFirstResponder:nil];
        [window orderOut:nil];
    }
}

void MacShellMode::activateElectronShell() {
    NSArray<NSRunningApplication*>* apps = [NSRunningApplication
        runningApplicationsWithBundleIdentifier:@"com.resonaura.resostage"];
    for (NSRunningApplication* app in apps)
        [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
}

void MacShellMode::triggerLocalNetworkPermission() {
    // Send a UDP broadcast datagram to trigger macOS Sequoia/Sonoma Local Network privacy prompt
    int s = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (s >= 0) {
        int opt = 1;
        ::setsockopt(s, SOL_SOCKET, SO_BROADCAST, &opt, sizeof(opt));
        struct sockaddr_in addr;
        std::memset(&addr, 0, sizeof(addr));
        addr.sin_family = AF_INET;
        addr.sin_port = htons(28991);
        addr.sin_addr.s_addr = INADDR_BROADCAST;
        const char probe[] = "RESOSTAGE_LOCAL_PROBE";
        ::sendto(s, probe, sizeof(probe) - 1, 0, reinterpret_cast<const struct sockaddr*>(&addr), sizeof(addr));
        ::close(s);
    }
}

} // namespace resostage

#endif
