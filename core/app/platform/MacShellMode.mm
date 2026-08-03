#if defined(__APPLE__)

#import <AppKit/AppKit.h>

#include "MacShellMode.h"

namespace resostage {

void backOffToHeadlessShell() {
    // Accessory apps run fine (audio/web server keep working) but have no
    // Dock icon and never activate -- the Electron window becomes the single
    // visible face of ResoStage.
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
}

void restoreForegroundShell() {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
}

void activateElectronShell() {
    // Bundle ID branded in electron/scripts/brand-mac-app.mjs. Found +
    // activated directly via NSRunningApplication rather than round-tripping
    // through the backend -- this process has no other channel to the
    // shell's window (it's a separate process, and the shell doesn't poll
    // the backend for "please focus yourself" commands).
    NSArray<NSRunningApplication*>* apps = [NSRunningApplication
        runningApplicationsWithBundleIdentifier:@"com.resonaura.resostage"];
    for (NSRunningApplication* app in apps)
        [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
}

} // namespace resostage

#else // !__APPLE__

#include "MacShellMode.h"

namespace resostage {
void backOffToHeadlessShell() {}
void restoreForegroundShell() {}
void activateElectronShell() {}
} // namespace resostage

#endif
