#include "MainComponent.h"

#include "platform/PlatformShellMode.h"
#include "project/Uuid.h"
#include "server/BuilderJson.h"

#include <algorithm>
#include <functional>

namespace resostage {
namespace {

constexpr size_t kMaximumOpenPluginEditors = 12;

class PluginEditorWindow final : public juce::DocumentWindow,
                                 public juce::KeyListener {
public:
    PluginEditorWindow(std::string slotIdIn, const juce::String& title,
                       AudioEngine& engineIn,
                       std::shared_ptr<PluginProcessorBank> bankIn,
                       std::unique_ptr<juce::AudioProcessorEditor> editorIn,
                       std::function<void(const std::string&)> onCloseRequestedIn)
        : juce::DocumentWindow(title, juce::Colours::black,
                               juce::DocumentWindow::allButtons, true),
          slotIdValue(std::move(slotIdIn)), engine(engineIn),
          bank(std::move(bankIn)), editor(std::move(editorIn)),
          onCloseRequested(std::move(onCloseRequestedIn)) {
        setUsingNativeTitleBar(true);
        setResizable(true, true);
        setWantsKeyboardFocus(true);
        setMouseClickGrabsKeyboardFocus(true);

        if (editor != nullptr) {
            editor->setWantsKeyboardFocus(true);
            editor->setMouseClickGrabsKeyboardFocus(true);
            const int edW = editor->getWidth() > 0 ? editor->getWidth() : 720;
            const int edH = editor->getHeight() > 0 ? editor->getHeight() : 520;
            editor->setSize(edW, edH);
            setContentNonOwned(editor.get(), true);
            editor->addKeyListener(this);
        }
        addKeyListener(this);

        centreWithSize(getWidth(), getHeight());
        bringWindowToFront();
    }

    ~PluginEditorWindow() override {
        removeKeyListener(this);
        if (editor != nullptr)
            editor->removeKeyListener(this);
        if (nativeHandle != nullptr)
            PlatformShellMode::getInstance().cleanupPluginWindow(nativeHandle);
        clearContentComponent();
        editor.reset();
        bank.reset();
    }

    void bringWindowToFront() {
        restoreForegroundShell();
        setAlwaysOnTop(true);
        setVisible(true);
        toFront(true);
        juce::Process::makeForegroundProcess();
        grabKeyboardFocus();
        if (editor != nullptr)
            editor->grabKeyboardFocus();
        if (auto* peer = getPeer()) {
            nativeHandle = peer->getNativeHandle();
            PlatformShellMode::getInstance().setupPluginWindow(
                nativeHandle,
                [this] {
                    if (engine.isPlaying())
                        engine.stop();
                    else
                        engine.play();
                },
                [this] {
                    closeButtonPressed();
                });
            PlatformShellMode::getInstance().makeWindowKeyAndActive(nativeHandle);
            PlatformShellMode::getInstance().forwardFocusToPluginNativeView(nativeHandle);
        }
    }

    void activeWindowStatusChanged() override {
        juce::DocumentWindow::activeWindowStatusChanged();
        if (isActiveWindow()) {
            if (auto* peer = getPeer()) {
                nativeHandle = peer->getNativeHandle();
                PlatformShellMode::getInstance().forwardFocusToPluginNativeView(nativeHandle);
            }
        }
    }

    void mouseDown(const juce::MouseEvent& e) override {
        juce::DocumentWindow::mouseDown(e);
        bringWindowToFront();
    }

    bool keyPressed(const juce::KeyPress& key, juce::Component* /*originatingComponent*/) override {
        return handleKey(key);
    }

    bool keyPressed(const juce::KeyPress& key) override {
        return handleKey(key);
    }

    bool handleKey(const juce::KeyPress& key) {
        // If user is currently typing in a native or JUCE text editor, do not intercept transport/shortcuts
        if (nativeHandle != nullptr) {
            if (PlatformShellMode::getInstance().isNativeTextInputFocused(nativeHandle))
                return false;
        }
        if (dynamic_cast<juce::TextEditor*>(juce::Component::getCurrentlyFocusedComponent()) != nullptr) {
            return false;
        }

        // Spacebar: Transport Play / Pause toggle
        if (key.getKeyCode() == juce::KeyPress::spaceKey && !key.getModifiers().isAnyModifierKeyDown()) {
            if (engine.isPlaying())
                engine.stop();
            else
                engine.play();
            return true;
        }

        // Esc or Cmd+W (Ctrl+W on Windows/Linux): close this plugin editor window
        if (key.getKeyCode() == juce::KeyPress::escapeKey
            || ((key.getKeyCode() == 'w' || key.getKeyCode() == 'W') && key.getModifiers().isCommandDown())) {
            closeButtonPressed();
            return true;
        }

        return false;
    }

    void closeButtonPressed() override {
        const std::string sid = slotIdValue;
        juce::MessageManager::callAsync([this, sid]() {
            if (onCloseRequested)
                onCloseRequested(sid);
        });
    }

    const std::string& slotId() const noexcept { return slotIdValue; }
    bool ownsBank(const std::shared_ptr<PluginProcessorBank>& candidate) const {
        return bank == candidate;
    }

private:
    std::string slotIdValue;
    AudioEngine& engine;
    std::shared_ptr<PluginProcessorBank> bank;
    std::unique_ptr<juce::AudioProcessorEditor> editor;
    std::function<void(const std::string&)> onCloseRequested;
    void* nativeHandle = nullptr;
};

std::vector<PluginSlot>* pluginChainFor(Project& project,
                                        const std::string& stripId) {
    if (stripId == "audio::main")
        return &project.main.plugins;
    if (stripId == "audio::click")
        return &project.click.plugins;
    for (auto& track : project.tracks)
        if (track.id == stripId)
            return &track.plugins;
    for (auto& send : project.sends)
        if (send.id == stripId)
            return &send.plugins;
    return nullptr;
}

size_t projectPluginCount(const Project& project) {
    size_t count = project.main.plugins.size() + project.click.plugins.size();
    for (const auto& track : project.tracks)
        count += track.plugins.size();
    for (const auto& send : project.sends)
        count += send.plugins.size();
    return count;
}

bool parseSlotTarget(const std::string& json, glz::generic& doc,
                     std::string& stripId, std::string& slotId) {
    return builder_json::parseJson(json, doc)
        && builder_json::getString(doc, "stripId", stripId)
        && builder_json::getString(doc, "slotId", slotId)
        && !stripId.empty() && !slotId.empty();
}

} // namespace

void MainComponent::pluginSlotAdd(const std::string& json) {
    glz::generic doc;
    std::string stripId;
    std::string pluginId;
    if (!builder_json::parseJson(json, doc)
        || !builder_json::getString(doc, "stripId", stripId)
        || !builder_json::getString(doc, "pluginId", pluginId)) {
        setStatus("Could not add plug-in: invalid request");
        return;
    }
    Project& project = engine.project();
    auto* chain = pluginChainFor(project, stripId);
    if (chain == nullptr) {
        setStatus("Could not add plug-in: strip no longer exists");
        return;
    }
    if (chain->size() >= 32 || projectPluginCount(project) >= 128) {
        setStatus("Could not add plug-in: insert limit reached");
        return;
    }
    const auto plugin = pluginCatalog.findPlugin(pluginId);
    if (!plugin.has_value()) {
        setStatus("Could not add plug-in: rescan or choose an available item");
        return;
    }
    bool replaceExistingInstrument = false;
    if (plugin->instrument) {
        const bool isTrack = std::any_of(project.tracks.begin(), project.tracks.end(),
            [&stripId](const auto& t) { return t.id == stripId; });
        if (!isTrack) {
            setStatus("Instrument plug-ins can only be placed on tracks");
            return;
        }
        if (!chain->empty() && chain->front().plugin.instrument) {
            replaceExistingInstrument = true;
        }
    }

    engine.projectHistoryBeginEdit("", replaceExistingInstrument ? "Replace instrument" : "Add plug-in");
    PluginSlot slot;
    slot.id = generateUuidV7();
    slot.plugin = *plugin;
    if (replaceExistingInstrument) {
        closePluginEditor(chain->front().id);
        chain->front() = std::move(slot);
    } else if (plugin->instrument) {
        chain->insert(chain->begin(), std::move(slot));
    } else {
        chain->push_back(std::move(slot));
    }
    engine.projectHistoryCommitEdit();
    engine.notifyPluginChainsChanged();
    setStatus((replaceExistingInstrument ? "Instrument replaced: " : "Plug-in added: ") + juce::String(plugin->name));
    publishWebState();
}

void MainComponent::pluginSlotRemove(const std::string& json) {
    glz::generic doc;
    std::string stripId;
    std::string slotId;
    if (!parseSlotTarget(json, doc, stripId, slotId))
        return;
    closePluginEditor(slotId);
    auto* chain = pluginChainFor(engine.project(), stripId);
    if (chain == nullptr)
        return;
    const auto found = std::find_if(chain->begin(), chain->end(),
        [&](const PluginSlot& slot) { return slot.id == slotId; });
    if (found == chain->end())
        return;
    engine.projectHistoryBeginEdit("", "Remove plug-in");
    chain->erase(found);
    engine.projectHistoryCommitEdit();
    engine.notifyPluginChainsChanged();
    setStatus("Plug-in removed");
    publishWebState();
}

void MainComponent::pluginSlotMove(const std::string& json) {
    glz::generic doc;
    std::string stripId;
    std::string slotId;
    int toIndex = -1;
    if (!parseSlotTarget(json, doc, stripId, slotId)
        || !builder_json::getInt(doc, "toIndex", toIndex))
        return;
    auto* chain = pluginChainFor(engine.project(), stripId);
    if (chain == nullptr || chain->empty())
        return;
    const auto found = std::find_if(chain->begin(), chain->end(),
        [&](const PluginSlot& slot) { return slot.id == slotId; });
    if (found == chain->end())
        return;
    const size_t from = static_cast<size_t>(std::distance(chain->begin(), found));
    const size_t to = static_cast<size_t>(std::clamp(
        toIndex, 0, static_cast<int>(chain->size() - 1)));
    if (from == to)
        return;
    engine.projectHistoryBeginEdit("", "Move plug-in");
    PluginSlot moving = std::move((*chain)[from]);
    chain->erase(chain->begin() + static_cast<std::ptrdiff_t>(from));
    chain->insert(chain->begin() + static_cast<std::ptrdiff_t>(to),
                  std::move(moving));
    engine.projectHistoryCommitEdit();
    engine.notifyPluginChainsChanged();
    publishWebState();
}

void MainComponent::pluginSlotBypass(const std::string& json) {
    glz::generic doc;
    std::string stripId;
    std::string slotId;
    bool bypassed = false;
    if (!parseSlotTarget(json, doc, stripId, slotId)
        || !builder_json::getBool(doc, "bypassed", bypassed))
        return;
    auto* chain = pluginChainFor(engine.project(), stripId);
    if (chain == nullptr)
        return;
    const auto found = std::find_if(chain->begin(), chain->end(),
        [&](const PluginSlot& slot) { return slot.id == slotId; });
    if (found == chain->end() || found->bypassed == bypassed)
        return;
    engine.projectHistoryBeginEdit("", bypassed ? "Bypass plug-in"
                                                 : "Enable plug-in");
    found->bypassed = bypassed;
    engine.projectHistoryCommitEdit();
    engine.notifyPluginChainsChanged();
    publishWebState();
}

void MainComponent::pluginSlotKeepAwake(const std::string& json) {
    glz::generic doc;
    std::string stripId;
    std::string slotId;
    bool keepAwake = false;
    if (!parseSlotTarget(json, doc, stripId, slotId)
        || !builder_json::getBool(doc, "keepAwake", keepAwake))
        return;
    auto* chain = pluginChainFor(engine.project(), stripId);
    if (chain == nullptr)
        return;
    const auto found = std::find_if(chain->begin(), chain->end(),
        [&](const PluginSlot& slot) { return slot.id == slotId; });
    if (found == chain->end())
        return;
    engine.projectHistoryBeginEdit("", keepAwake ? "Pin plug-in awake"
                                                 : "Unpin plug-in awake");
    found->keepAwake = keepAwake;
    engine.projectHistoryCommitEdit();
    if (auto bank = engine.activePluginProcessorBank()) {
        bank->setSlotKeepAwake(slotId, keepAwake);
    }
    publishWebState();
}

void MainComponent::pluginSlotPark(const std::string& json) {
    glz::generic doc;
    std::string stripId;
    std::string slotId;
    if (!parseSlotTarget(json, doc, stripId, slotId))
        return;
    if (auto bank = engine.activePluginProcessorBank()) {
        bank->parkSlot(slotId);
    }
    publishWebState();
}

void MainComponent::pluginSlotUnpark(const std::string& json) {
    glz::generic doc;
    std::string stripId;
    std::string slotId;
    if (!parseSlotTarget(json, doc, stripId, slotId))
        return;
    if (auto bank = engine.activePluginProcessorBank()) {
        bank->unparkSlot(slotId);
    }
    publishWebState();
}

void MainComponent::pluginSlotOpenEditor(const std::string& json) {
    glz::generic doc;
    std::string stripId;
    std::string slotId;
    if (!parseSlotTarget(json, doc, stripId, slotId)) {
        setStatus("Could not open plug-in editor: invalid request");
        return;
    }
    auto* chain = pluginChainFor(engine.project(), stripId);
    if (chain == nullptr) {
        setStatus("Could not open plug-in editor: strip no longer exists");
        return;
    }
    const auto slot = std::find_if(chain->begin(), chain->end(),
        [&](const PluginSlot& candidate) { return candidate.id == slotId; });
    if (slot == chain->end()) {
        setStatus("Could not open plug-in editor: insert no longer exists");
        return;
    }

    auto bank = engine.activePluginProcessorBank();
    if (bank == nullptr) {
        setStatus("Plug-in is still loading; try again in a moment");
        return;
    }
    for (auto it = pluginEditorWindows.begin(); it != pluginEditorWindows.end(); ++it) {
        if (auto* pluginWindow = dynamic_cast<PluginEditorWindow*>(it->get());
            pluginWindow != nullptr && pluginWindow->slotId() == slotId) {
            if (pluginWindow->ownsBank(bank)) {
                pluginWindow->bringWindowToFront();
                return;
            }
            pluginEditorWindows.erase(it);
            break;
        }
    }

    restoreForegroundShell();
    auto editor = bank->createEditor(slotId);
    if (editor == nullptr) {
        setStatus("Plug-in has no native editor or is still loading: "
                  + juce::String(slot->plugin.name));
        return;
    }
    if (pluginEditorWindows.size() >= kMaximumOpenPluginEditors) {
        const auto hidden = std::find_if(pluginEditorWindows.begin(),
            pluginEditorWindows.end(), [](const auto& window) {
                return !window->isVisible();
            });
        if (hidden == pluginEditorWindows.end()) {
            setStatus("Close a plug-in editor before opening another");
            return;
        }
        pluginEditorWindows.erase(hidden);
    }
    auto onCloseRequested = [this](const std::string& sid) {
        closePluginEditor(sid);
    };
    pluginEditorWindows.push_back(std::make_unique<PluginEditorWindow>(
        slotId, juce::String(slot->plugin.name), engine, std::move(bank),
        std::move(editor), std::move(onCloseRequested)));
    setStatus("Opened plug-in editor: " + juce::String(slot->plugin.name));
}

void MainComponent::closePluginEditor(const std::string& slotId) {
    for (auto it = pluginEditorWindows.begin(); it != pluginEditorWindows.end(); ) {
        if (auto* pluginWindow = dynamic_cast<PluginEditorWindow*>(it->get());
            pluginWindow != nullptr && (slotId.empty() || pluginWindow->slotId() == slotId)) {
            it = pluginEditorWindows.erase(it);
        } else {
            ++it;
        }
    }
    bool anyVisible = false;
    for (const auto& w : pluginEditorWindows) {
        if (w != nullptr && w->isVisible()) {
            anyVisible = true;
            break;
        }
    }
    if (!anyVisible) {
        backOffToHeadlessShell();
        PlatformShellMode::getInstance().activateElectronShell();
    }
}

void MainComponent::closeAllPluginEditors() {
    closePluginEditor("");
}

} // namespace resostage
