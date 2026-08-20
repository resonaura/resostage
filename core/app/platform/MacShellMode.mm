#if defined(__APPLE__)

#import <AppKit/AppKit.h>
#include <cstring>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>

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
