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

} // namespace resostage

#else // !__APPLE__

#include "MacShellMode.h"

namespace resostage {
void backOffToHeadlessShell() {}
void restoreForegroundShell() {}
} // namespace resostage

#endif
