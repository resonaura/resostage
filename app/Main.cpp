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

        mainWindow = std::make_unique<MainWindow>(getApplicationName());

        const auto path = commandLine.unquoted().trim();
        if (!path.isEmpty() && juce::File::isAbsolutePath(path)) {
            const juce::File file(path);
            if (file.exists()) {
                if (auto* mc = mainWindow->getMainComponent()) {
                    mc->loadProjectFromPath(file);
                }
            }
        }
    }

    void anotherInstanceStarted(const juce::String& commandLine) override {
        const auto path = commandLine.unquoted().trim();
        if (!path.isEmpty() && juce::File::isAbsolutePath(path) && mainWindow != nullptr) {
            const juce::File file(path);
            if (file.exists()) {
                if (auto* mc = mainWindow->getMainComponent()) {
                    mc->loadProjectFromPath(file);
                }
            }
        }
    }

    void shutdown() override {
        mainWindow = nullptr;
    }

    void systemRequestedQuit() override {
        if (mainWindow != nullptr && mainWindow->getMainComponent() != nullptr) {
            mainWindow->getMainComponent()->confirmQuitIfUnsaved([this](bool canQuit) {
                if (canQuit)
                    quit();
            });
            return;
        }
        quit();
    }


private:
    // ResoStage Core is headless: the window exists to host the backend's
    // message loop and native dialogs, but the MainComponent hides it right
    // after it launches the on-screen UI (Electron shell or browser tab).
    class MainWindow final : public juce::DocumentWindow {
    public:
        explicit MainWindow(const juce::String& name)
            : DocumentWindow(name,
                              juce::Desktop::getInstance().getDefaultLookAndFeel().findColour(
                                  juce::ResizableWindow::backgroundColourId),
                              DocumentWindow::allButtons) {
            setUsingNativeTitleBar(true);
            setContentOwned(new MainComponent(), true);
            setResizable(true, false);
            setResizeLimits(960, 640, 10000, 10000);
            centreWithSize(getWidth(), getHeight());
            setVisible(true);
        }

        MainComponent* getMainComponent() const {
            return dynamic_cast<MainComponent*>(getContentComponent());
        }

        void closeButtonPressed() override {
            juce::JUCEApplication::getInstance()->systemRequestedQuit();
        }
    };

    std::unique_ptr<MainWindow> mainWindow;
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
