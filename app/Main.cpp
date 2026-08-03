#include <juce_gui_basics/juce_gui_basics.h>

#include "MainComponent.h"
#include "cef/CefLifecycle.h"
#include "platform/MacMenuBar.h"
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

        // No-op unless RESOSTAGE_ENABLE_CEF is compiled in AND the user has
        // selected the Chromium engine in Settings > UI -- see
        // cef/CefLifecycle.h. Deliberately deferred via callAsync to run
        // *after* our own NSWindow/NSView peer is fully created and the
        // message loop has had a chance to settle: calling CefInitialize()
        // synchronously before that point crashed JUCE's own AppKit window
        // creation moments later (corrupted Objective-C method dispatch
        // inside NSView's layer-backing setup) during hands-on testing --
        // CEF's mac browser-process bootstrap does enough of its own deep
        // AppKit/Cocoa setup that it cannot safely run interleaved with the
        // host app's first-window creation in the same call stack.
        juce::MessageManager::callAsync([] { cef_lifecycle::initializeIfLoaded(); });

#if JUCE_MAC
        // Defer menu installation: JUCE's own initialiseApp() calls
        // initialiseMacMainMenu() right after our initialise() returns,
        // which would replace our custom menu with a default Apple-only
        // one.  callAsync ensures we install AFTER that JUCE setup.
        juce::MessageManager::callAsync([this] {
            const auto* bindings = (mainWindow && mainWindow->getMainComponent())
                ? &mainWindow->getMainComponent()->getKeyBindings()
                : nullptr;
            installMacMenuBar([this](const std::string& action) {
                if (action == "quit") {
                    if (auto* mc = mainWindow->getMainComponent())
                        mc->confirmQuitIfUnsaved([](bool canQuit) {
                            if (canQuit) juce::JUCEApplication::quit();
                        });
                } else {
                    if (auto* mc = mainWindow->getMainComponent())
                        mc->performAction(action);
                }
            }, bindings);

            if (auto* mc = mainWindow->getMainComponent()) {
                std::vector<std::pair<std::string, std::string>> recents;
                recents.reserve(mc->getRecentProjects().size());
                for (const auto& rp : mc->getRecentProjects())
                    recents.emplace_back(rp.path, rp.displayName);
                updateMacMenuRecentProjects(recents);
            }
        });
#endif

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
        cef_lifecycle::shutdownIfInitialized();
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

juce::JUCEApplicationBase* juce_CreateApplication();
juce::JUCEApplicationBase* juce_CreateApplication() { return new ResoStageApplication(); }

} // namespace resostage

// Hand-inlined expansion of JUCE's START_JUCE_APPLICATION macro (see
// JUCE_CREATE_APPLICATION_DEFINE/JUCE_MAIN_FUNCTION_DEFINITION in
// juce_events/messages/juce_Initialisation.h for the macro this mirrors) --
// needed so cef_lifecycle::bootstrapIfSelected() can run as the literal
// first statement in main(), before JUCEApplicationBase::main() creates its
// own NSApplication. CEF's docs require its entry-point check to happen
// before any of that host-application setup.
int main(int argc, char* argv[]) {
    resostage::cef_lifecycle::bootstrapIfSelected(argc, argv);

    juce::JUCEApplicationBase::createInstance = &resostage::juce_CreateApplication;
    return juce::JUCEApplicationBase::main(argc, const_cast<const char**>(argv));
}
