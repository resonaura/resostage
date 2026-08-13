#include <juce_gui_basics/juce_gui_basics.h>

#include "MainComponent.h"
#include "platform/ProcessPriority.h"

namespace resostage {

class ResoStageApplication final : public juce::JUCEApplication {
public:
    const juce::String getApplicationName() override { return "ResoStage Core"; }
    const juce::String getApplicationVersion() override { return "0.2.0"; }
    bool moreThanOneInstanceAllowed() override { return true; }

    void initialise(const juce::String& commandLine) override {
        // Prefer high scheduling priority so audio stays solid when the
        // rest of the system is thrashing (see ProcessPriority.cpp).
        boostAppProcessPriority();

        const juce::String cli = commandLine.trim();
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

        // Headless host only: audio / lighting / WebServer / timers. The
        // on-screen UI is always Electron (or a browser tab). Deliberately
        // NO DocumentWindow / desktop peer -- a 1x1 black host window was
        // flashing on launch and reappearing whenever a native FileChooser
        // or Alert activated this process (orderFront of the hidden peer).
        // JUCE's message loop does not require a visible window; FileChooser
        // / NativeMessageBox / AlertWindow create their own peers when needed.
        mainComponent = std::make_unique<MainComponent>();
        if (mainComponent && !ipcSocketPath.empty())
            mainComponent->setIpcSocketPath(ipcSocketPath);

        const auto path = commandLine.unquoted().trim();
        if (!path.isEmpty() && juce::File::isAbsolutePath(path)) {
            const juce::File file(path);
            if (file.exists())
                mainComponent->loadProjectFromPath(file);
        }
    }

    void anotherInstanceStarted(const juce::String& commandLine) override {
        const auto path = commandLine.unquoted().trim();
        if (!path.isEmpty() && juce::File::isAbsolutePath(path) && mainComponent != nullptr) {
            const juce::File file(path);
            if (file.exists())
                mainComponent->loadProjectFromPath(file);
        }
    }

    void shutdown() override {
        mainComponent = nullptr;
    }

    void systemRequestedQuit() override {
        if (mainComponent != nullptr) {
            mainComponent->confirmQuitIfUnsaved([](bool canQuit) {
                if (canQuit)
                    quit();
            });
            return;
        }
        quit();
    }

private:
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
