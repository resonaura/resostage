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

        // Headless host only: audio / lighting / WebServer / timers. The
        // on-screen UI is always Electron (or a browser tab). Deliberately
        // NO DocumentWindow / desktop peer -- a 1x1 black host window was
        // flashing on launch and reappearing whenever a native FileChooser
        // or Alert activated this process (orderFront of the hidden peer).
        // JUCE's message loop does not require a visible window; FileChooser
        // / NativeMessageBox / AlertWindow create their own peers when needed.
        mainComponent = std::make_unique<MainComponent>();

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

// START_JUCE_APPLICATION is expanded by hand (matching JUCE's
// JUCE_CREATE_APPLICATION_DEFINE/JUCE_MAIN_FUNCTION_DEFINITION macros) so
// main() stays a normal C++ entry point we control.
int main(int argc, char* argv[]) {
    juce::JUCEApplicationBase::createInstance = &resostage::juce_CreateApplication;
    return juce::JUCEApplicationBase::main(argc, const_cast<const char**>(argv));
}
