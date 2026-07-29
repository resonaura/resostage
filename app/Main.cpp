#include <juce_gui_basics/juce_gui_basics.h>

#include "MainComponent.h"
#include "platform/ProcessPriority.h"

namespace resoset {

class ResoStageApplication final : public juce::JUCEApplication {
public:
    const juce::String getApplicationName() override { return "ResoStage"; }
    const juce::String getApplicationVersion() override { return "0.2.0"; }
    bool moreThanOneInstanceAllowed() override { return true; }

    void initialise(const juce::String&) override {
        // Prefer high scheduling priority so audio stays solid when the
        // rest of the system is thrashing (see ProcessPriority.cpp).
        boostAppProcessPriority();
        mainWindow = std::make_unique<MainWindow>(getApplicationName());
    }

    void shutdown() override { mainWindow = nullptr; }

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
    class MainWindow final : public juce::DocumentWindow {
    public:
        explicit MainWindow(const juce::String& name)
            : DocumentWindow(name,
                              juce::Desktop::getInstance().getDefaultLookAndFeel().findColour(
                                  juce::ResizableWindow::backgroundColourId),
                              DocumentWindow::allButtons) {
            setUsingNativeTitleBar(true);
            setContentOwned(new MainComponent(), true);
            setResizable(true, true);
            setResizeLimits(960, 640, 10000, 10000);
            centreWithSize(getWidth(), getHeight());
            setVisible(true);
        }

        MainComponent* getMainComponent() const {
            return dynamic_cast<MainComponent*>(getContentComponent());
        }

        void closeButtonPressed() override { juce::JUCEApplication::getInstance()->systemRequestedQuit(); }
    };

    std::unique_ptr<MainWindow> mainWindow;
};

} // namespace resoset


START_JUCE_APPLICATION(resoset::ResoStageApplication)
