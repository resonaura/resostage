#include <juce_gui_basics/juce_gui_basics.h>

#include "MainComponent.h"
#include "platform/ProcessPriority.h"

namespace resostage {

class ResoStageApplication final : public juce::JUCEApplication {
public:
    const juce::String getApplicationName() override { return "ResoStage Core"; }
    const juce::String getApplicationVersion() override { return "0.2.0"; }
    bool moreThanOneInstanceAllowed() override { return false; }

    void initialise(const juce::String& commandLine) override {
        // Prefer high scheduling priority so audio stays solid when the
        // rest of the system is thrashing (see ProcessPriority.cpp).
        boostAppProcessPriority();

        const juce::String cli = commandLine.trim();
        std::fprintf(stderr, "[resostage-core] CLI: %s\n", cli.toRawUTF8());
        const juce::String ipcToken = "--ipc-socket ";
        const int idx = cli.indexOf(ipcToken);
        std::string ipcSocketPath;
        if (idx >= 0) {
            const int start = idx + ipcToken.length();
            const juce::String rest = cli.substring(start).trim();
            // путь может начинаться с / (Linux/macOS) — читаем до пробела
            juce::String path;
            for (int i = 0; i < rest.length(); ++i) {
                const juce::juce_wchar c = rest[i];
                if (c == ' ' || c == '\t')
                    break;
                path << c;
            }
            if (!path.isEmpty())
                ipcSocketPath = path.toStdString();
        }

        // Parse --backend-port for remote mode (Electron connects to this port)
        uint16_t webPort = MainComponent::kWebPort;
        const juce::String portToken = "--backend-port=";
        const int portIdx = cli.indexOf(portToken);
        if (portIdx >= 0) {
            const int start = portIdx + portToken.length();
            const juce::String rest = cli.substring(start).trim();
            juce::String portStr;
            for (int i = 0; i < rest.length(); ++i) {
                const juce::juce_wchar c = rest[i];
                if (c == ' ' || c == '\t')
                    break;
                portStr << c;
            }
            if (!portStr.isEmpty()) {
                int parsed = portStr.getIntValue();
                if (parsed > 0 && parsed < 65536)
                    webPort = static_cast<uint16_t>(parsed);
            }
        }

        // Headless host only: audio / lighting / WebServer / timers. The
        // on-screen UI is always Electron (or a browser tab). Deliberately
        // NO DocumentWindow / desktop peer -- a 1x1 black host window was
        // flashing on launch and reappearing whenever a native FileChooser
        // or Alert activated this process (orderFront of the hidden peer).
        // JUCE's message loop does not require a visible window; FileChooser
        // / NativeMessageBox / AlertWindow create their own peers when needed.
        //
        // The IPC socket path is set on MainComponent before audio setup so the
        // readiness server exists (and is connectable by Electron) before the
        // device-open work that triggers notifyCoreReady().
        mainComponent = std::make_unique<MainComponent>(std::move(ipcSocketPath), webPort);

        // Parse any standalone project file argument from commandLine
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
        std::exit(0);
    }

private:
    bool isQuitting = false;
    std::unique_ptr<MainComponent> mainComponent;
};

juce::JUCEApplicationBase* juce_CreateApplication();
juce::JUCEApplicationBase* juce_CreateApplication() { return new ResoStageApplication(); }

} // namespace resostage

#if JUCE_WINDOWS
// Windows: JUCE drives a WinMain entry point (the app is built with
// /subsystem:windows, no console main). The hand-rolled main() below is for
// the Unix/macOS hosts where a normal C entry point exists. juce_CreateApplication
// is already defined above, matching JUCE's JUCE_CREATE_APPLICATION_DEFINE.
int __stdcall WinMain(void*, void*, char*, int) {
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
