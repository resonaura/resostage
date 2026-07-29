#include <juce_gui_basics/juce_gui_basics.h>

#include "MainComponent.h"
#include "platform/MacTouchBar.h"
#include "platform/ProcessPriority.h"

namespace resostage {

class ResoStageApplication final : public juce::JUCEApplication {
public:
    const juce::String getApplicationName() override { return "ResoStage"; }
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
        if (mainWindow != nullptr)
            mainWindow->teardownTouchBar();
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

            // Touch Bar (no-op on Macs without one / non-Apple builds).
            // Install after visible so the NSWindow peer exists.
            installTouchBarIfPossible();
        }

        ~MainWindow() override { teardownTouchBar(); }

        void teardownTouchBar() {
#if JUCE_MAC
            if (touchBarPeer != nullptr) {
                uninstallMacTouchBar(touchBarPeer);
                touchBarPeer = nullptr;
            }
#endif
        }

        MainComponent* getMainComponent() const {
            return dynamic_cast<MainComponent*>(getContentComponent());
        }

        void closeButtonPressed() override {
            juce::JUCEApplication::getInstance()->systemRequestedQuit();
        }

    private:
        void* touchBarPeer = nullptr; // NSView* from JUCE peer

        void installTouchBarIfPossible() {
#if JUCE_MAC
            auto* peer = getPeer();
            if (peer == nullptr)
                return;
            touchBarPeer = peer->getNativeHandle();
            if (touchBarPeer == nullptr)
                return;

            installMacTouchBar(touchBarPeer, [this](const std::string& tabId) {
                // Hop to message thread (Touch Bar callbacks can be AppKit).
                juce::MessageManager::callAsync([this, tabId] {
                    if (auto* mc = getMainComponent())
                        mc->handleTouchBarTab(tabId);
                });
            });
            if (auto* mc = getMainComponent())
                mc->setTouchBarPeer(touchBarPeer);
#endif
        }
    };

    std::unique_ptr<MainWindow> mainWindow;
};

} // namespace resostage


START_JUCE_APPLICATION(resostage::ResoStageApplication)
