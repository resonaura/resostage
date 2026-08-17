#include <cstdlib>
#if defined(_WIN32)
#include <windows.h>
[[maybe_unused]] inline int getCurrentProcessId() {
    return static_cast<int>(::GetCurrentProcessId());
}
#else
#include <unistd.h>
[[maybe_unused]] inline int getCurrentProcessId() {
    return static_cast<int>(::getpid());
}
#endif

#include "config/CliParser.h"
#include "network/UdpDiscovery.h"
#include "MainComponent.h"
#include "platform/ProcessPriority.h"

namespace resostage {

class ResoStageApplication final : public juce::JUCEApplication {
public:
    const juce::String getApplicationName() override {
#if JUCE_MAC
        return "ResoStage Core";
#else
        return "core";
#endif
    }
    const juce::String getApplicationVersion() override { return "0.2.0"; }
    bool moreThanOneInstanceAllowed() override { return false; }

    void initialise(const juce::String& commandLine) override {
#if defined(_WIN32)
        if (::AttachConsole(ATTACH_PARENT_PROCESS)) {
            (void)::freopen("CONOUT$", "w", stdout);
            (void)::freopen("CONOUT$", "w", stderr);
        }
#endif
        boostAppProcessPriority();

        CliParser parser("ResoStage Core CLI v0.2.0", "ResoStage Core engine daemon & CLI");
        parser.addOption("h", "help", "Show this help message and exit", "", true);
        parser.addOption("v", "version", "Output version information and exit", "", true);
        parser.addOption("", "backend-port", "HTTP/WebSocket server port", "2899");
        parser.addOption("", "bind-address", "Server bind IP address (0.0.0.0 or 127.0.0.1)", "0.0.0.0");
        parser.addOption("", "discovery", "Enable mDNS / UDP datagram discovery", "true", true);
        parser.addOption("", "no-discovery", "Disable mDNS / UDP datagram discovery", "", true);
        parser.addOption("", "ipc-socket", "IPC socket path for Electron bridge", "");
        parser.addOption("l", "list-audio-devices", "List available audio driver types and devices, then exit", "", true);
        parser.addOption("s", "scan-network", "Scan local network for ResoStage instances via UDP discovery, then exit", "", true);
        parser.addOption("", "test-discovery", "Test UDP discovery transmission and reception, then exit", "", true);

        const juce::String cli = commandLine.trim();
        juce::StringArray tokens = juce::StringArray::fromTokens(commandLine, true);

        if (cli.isEmpty() || tokens.contains("--help") || tokens.contains("-h")) {
            std::fprintf(stderr, "%s\n", parser.generateHelp().c_str());
            std::exit(0);
        }

        if (tokens.contains("--version") || tokens.contains("-v")) {
            std::fprintf(stderr, "ResoStage Core v0.2.0\n");
            std::exit(0);
        }

        if (tokens.contains("--list-audio-devices") || tokens.contains("--devices") || tokens.contains("-l")) {
            juce::AudioDeviceManager mgr;
            juce::OwnedArray<juce::AudioIODeviceType> types;
            mgr.createAudioDeviceTypes(types);
            std::printf("========================================\n");
            std::printf("  ResoStage Audio Drivers & Devices\n");
            std::printf("========================================\n\n");

            if (types.isEmpty()) {
                std::printf("  (No audio device drivers found)\n");
            } else {
                for (auto* t : types) {
                    if (t == nullptr) continue;
                    std::printf("Driver API: %s\n", t->getTypeName().toRawUTF8());
                    t->scanForDevices();

                    const auto inputs = t->getDeviceNames(true);
                    std::printf("  Input Devices (%d):\n", inputs.size());
                    for (const auto& dev : inputs) {
                        std::printf("   - %s\n", dev.toRawUTF8());
                    }

                    const auto outputs = t->getDeviceNames(false);
                    std::printf("  Output Devices (%d):\n", outputs.size());
                    for (const auto& dev : outputs) {
                        std::printf("   - %s\n", dev.toRawUTF8());
                    }
                    std::printf("\n");
                }
            }
            std::fflush(stdout);
            std::fflush(stderr);
            std::exit(0);
        }

        if (tokens.contains("--scan-network") || tokens.contains("-s") || tokens.contains("--test-discovery") || tokens.contains("--scan")) {
            std::printf("========================================\n");
            std::printf("  ResoStage LAN Discovery Scanner\n");
            std::printf("========================================\n\n");
            std::printf("Listening for UDP announcements on port %d for 3 seconds...\n", UdpDiscovery::kDiscoveryPort);
            std::fflush(stdout);

            UdpDiscovery discovery;
            discovery.start(2899, true);

            // Wait 3 seconds for beacons
            juce::Thread::sleep(3000);

            const auto devices = discovery.getDiscoveredDevices();
            discovery.stop();

            std::printf("\nScan complete. Discovered %zu device(s):\n", devices.size());
            if (devices.empty()) {
                std::printf("  (No remote ResoStage instances responded on the local network)\n");
            } else {
                for (size_t idx = 0; idx < devices.size(); ++idx) {
                    const auto& d = devices[idx];
                    std::printf("  [%zu] \"%s\" (%s) -> %s:%u [protocol v%s]\n",
                                idx + 1, d.name.c_str(), d.platform.c_str(),
                                d.ip.c_str(), d.port, d.protocolVersion.c_str());
                }
            }
            std::printf("========================================\n\n");
            std::fflush(stdout);
            std::exit(0);
        }

        std::string ipcSocketPath;
        uint16_t webPort = MainComponent::kWebPort;
        std::string bindAddress = "0.0.0.0";
        [[maybe_unused]] bool enableDiscovery = true;
        std::string projectPathToLoad;

        for (int i = 0; i < tokens.size(); ++i) {
            juce::String tok = tokens[i].unquoted().trim();
            if (tok.startsWith("--ipc-socket")) {
                if (tok == "--ipc-socket" && i + 1 < tokens.size()) {
                    ipcSocketPath = tokens[i + 1].unquoted().trim().toStdString();
                    ++i;
                } else if (tok.contains("=")) {
                    ipcSocketPath = tok.fromFirstOccurrenceOf("=", false, false).trim().toStdString();
                }
                continue;
            }
            if (tok.startsWith("--backend-port=")) {
                int p = tok.fromFirstOccurrenceOf("=", false, false).trim().getIntValue();
                if (p > 0 && p < 65536) webPort = static_cast<uint16_t>(p);
                continue;
            }
            if (tok.startsWith("--bind-address=")) {
                bindAddress = tok.fromFirstOccurrenceOf("=", false, false).trim().toStdString();
                continue;
            }
            if (tok == "--no-discovery") {
                enableDiscovery = false;
                bindAddress = "127.0.0.1";
                continue;
            }
            if (tok == "--discovery") {
                enableDiscovery = true;
                continue;
            }
            if (juce::File::isAbsolutePath(tok)) {
                projectPathToLoad = tok.toStdString();
            }
        }

        mainComponent = std::make_unique<MainComponent>(std::move(ipcSocketPath), webPort, enableDiscovery, bindAddress);

        if (!projectPathToLoad.empty()) {
            const juce::File file(projectPathToLoad);
            if (file.exists() && mainComponent != nullptr) {
                mainComponent->loadProjectFromPath(file);
            }
        }
    }

    void anotherInstanceStarted(const juce::String& commandLine) override {
        juce::StringArray tokens = juce::StringArray::fromTokens(commandLine, true);
        for (int i = 0; i < tokens.size(); ++i) {
            juce::String tok = tokens[i].unquoted().trim();
            if (tok.startsWith("--ipc-socket")) {
                if (tok == "--ipc-socket" && i + 1 < tokens.size()) ++i;
                continue;
            }
            if (tok.startsWith("--backend-port")) continue;
            if (juce::File::isAbsolutePath(tok)) {
                const juce::File file(tok);
                if (file.exists() && mainComponent != nullptr) {
                    mainComponent->loadProjectFromPath(file);
                    break;
                }
            }
        }
    }

    void shutdown() override {
        mainComponent = nullptr;
    }

    void systemRequestedQuit() override {
        if (isQuitting)
            return;
        if (mainComponent != nullptr) {
            isQuitting = true;
            mainComponent->confirmQuitIfUnsaved([this](bool canQuit) {
                if (canQuit) {
                    forceQuit();
                } else {
                    isQuitting = false;
                }
            });
            return;
        }
        forceQuit();
    }

    void forceQuit() {
        mainComponent = nullptr;
        juce::JUCEApplicationBase::quit();

        juce::File exeDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getParentDirectory();
#if JUCE_WINDOWS
        juce::File kaishakuExe = exeDir.getChildFile("kaishaku.exe");
        if (kaishakuExe.existsAsFile()) {
            auto selfPid = getCurrentProcessId();
            juce::ChildProcess killer;
            killer.start("\"" + kaishakuExe.getFullPathName() + "\" " + juce::String(selfPid));
        } else {
            const juce::String killCmd = "cmd.exe /c \"timeout /t 1 /nobreak >NUL & taskkill /IM resostage.exe /F /T >NUL 2>&1 & taskkill /IM ResoStage.exe /F /T >NUL 2>&1 & taskkill /IM core.exe /F /T >NUL 2>&1 & taskkill /IM \"ResoStage Core.exe\" /F /T >NUL 2>&1\"";
            juce::ChildProcess killer;
            killer.start(killCmd);
        }
        std::exit(0);
#else
        juce::File kaishakuExe = exeDir.getChildFile("kaishaku");
        if (!kaishakuExe.existsAsFile())
            kaishakuExe = exeDir.getChildFile("Resources").getChildFile("kaishaku");

        if (kaishakuExe.existsAsFile()) {
            auto selfPid = getCurrentProcessId();
            juce::ChildProcess killer;
            killer.start("\"" + kaishakuExe.getFullPathName() + "\" " + juce::String(selfPid));
        } else {
#if JUCE_MAC
            std::system("pkill -9 -x 'ResoStage' >/dev/null 2>&1 & pkill -9 -x 'ResoStage Core' >/dev/null 2>&1");
#else
            std::system("pkill -9 -x resostage >/dev/null 2>&1 & pkill -9 -x core >/dev/null 2>&1");
#endif
        }
        std::exit(0);
#endif
    }

private:
    bool isQuitting = false;
    std::unique_ptr<MainComponent> mainComponent;
};

juce::JUCEApplicationBase* juce_CreateApplication();
juce::JUCEApplicationBase* juce_CreateApplication() { return new ResoStageApplication(); }

} // namespace resostage

#if defined(_WIN32)
// Windows: JUCE drives a WinMain entry point (the app is built with
// /subsystem:windows, no console main). The hand-rolled main() below is for
// the Unix/macOS hosts where a normal C entry point exists. juce_CreateApplication
// is already defined above, matching JUCE's JUCE_CREATE_APPLICATION_DEFINE.
int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    juce::JUCEApplicationBase::createInstance = &resostage::juce_CreateApplication;
    return juce::JUCEApplicationBase::main();
}
#else
// START_JUCE_APPLICATION is expanded by hand (matching JUCE's
// JUCE_CREATE_APPLICATION_DEFINE/JUCE_MAIN_FUNCTION_DEFINITION macros) so
// main() stays a normal C++ entry point we control.
int main(int argc, char* argv[]) {
    juce::JUCEApplicationBase::createInstance = &resostage::juce_CreateApplication;
    return juce::JUCEApplicationBase::main(argc, const_cast<const char**>(argv));
}
#endif
