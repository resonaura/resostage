#include "MacShellMode.h"

// Windows shell mode: there is no Electron process to manage -- ResoStage
// runs as a headless host and the Web UI is a browser tab. These hooks are
// declared by MacShellMode.h and only meaningful on macOS (the macOS-only
// .mm provides the real implementations); on Windows they are no-ops.
//
// Compiled only on WIN32 (see app/CMakeLists.txt), mirroring how the macOS
// build pulls in platform/MacShellMode.mm.

namespace resostage {

void backOffToHeadlessShell() {}
void restoreForegroundShell() {}
void activateElectronShell() {}

} // namespace resostage