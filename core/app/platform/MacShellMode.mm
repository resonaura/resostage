#if defined(__APPLE__)

#import <AppKit/AppKit.h>

#include "MacShellMode.h"

namespace resostage {

void MacShellMode::backOffToHeadlessShell() {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
}

void MacShellMode::restoreForegroundShell() {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
}

void MacShellMode::activateElectronShell() {
    NSArray<NSRunningApplication*>* apps = [NSRunningApplication
        runningApplicationsWithBundleIdentifier:@"com.resonaura.resostage"];
    for (NSRunningApplication* app in apps)
        [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
}

} // namespace resostage

#endif
