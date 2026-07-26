#pragma once

#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include "AudioEngine.h"
#include "midi/CoreMidiInputListener.h"
#include "ui/legacy/UiColors.h"

#include <functional>
#include <memory>

namespace resoset {

// Audio device selector + MIDI I/O + keybinding/MIDI-remote mapping + debug tools.
class SettingsPanel final : public juce::Component {
public:
    SettingsPanel(AudioEngine& engineRef, CoreMidiInputListener& midiInRef);

    void paint(juce::Graphics&) override;
    void resized() override;
    void refreshMidiLists();

    // Re-reads engine.project().keybindings/midiMappings and rebuilds the
    // row widgets. Call after project load or after any *external* change
    // to those maps. Do NOT call this from the middle of a row edit (e.g.
    // reacting to onBindingsChanged for a text-field keystroke) -- it
    // destroys and recreates the row components, which would yank keyboard
    // focus out from under a TextEditor the user is actively typing into.
    void refreshBindings();

    std::function<void()> onSimulateUnderrun;

    // Fired after keybindings/midiMappings are edited so MainComponent can
    // refresh its live key-lookup cache and CoreMidiInputListener's table.
    std::function<void()> onBindingsChanged;

    // MainComponent forwards CoreMidiInputListener::onRawMessage here
    // (already marshaled to the message thread) to feed MIDI-learn mode.
    void handleMidiLearn(MidiTriggerType type, int channel1to16, int number);

    // Global rebind-capture: active only while a keybinding row is
    // "listening" for the next keypress. Returns true (consuming the event,
    // so it never reaches MainComponent's transport shortcuts) only in that
    // state; otherwise defers to normal focus-chain handling.
    bool keyPressed(const juce::KeyPress& key) override;

private:
    AudioEngine& engine;
    CoreMidiInputListener& midiInput;

    juce::Label header;
    std::unique_ptr<juce::AudioDeviceSelectorComponent> deviceSelector;
    juce::Label midiOutLabel;
    juce::ComboBox midiOutputSelector;
    juce::Label midiInLabel;
    juce::ComboBox midiInputSelector;
    juce::TextButton underrunButton{"Simulate 500ms underrun"};
    juce::Label remoteLabel;
    juce::ToggleButton themeToggle{"Light mode"};

    // Lower, scrollable section: keybindings + MIDI remote mappings. Grows
    // with the number of mappings, so it lives in a Viewport rather than
    // fighting for a fixed slice of the panel.
    juce::Viewport lowerViewport;
    juce::Component lowerContent;

    static constexpr const char* kActions[] = {"play", "stop", "next", "prev"};

    juce::Label keybindHeader;
    struct KeybindRow {
        std::string action;
        juce::Label actionLabel;
        juce::TextButton keyButton;
    };
    std::vector<std::unique_ptr<KeybindRow>> keybindRows;
    std::string rebindingAction; // non-empty while capturing the next keypress

    juce::Label mappingHeader;
    struct MappingRow {
        juce::ComboBox actionBox;
        juce::ComboBox triggerBox;
        juce::TextEditor channelEdit;
        juce::TextEditor numberEdit;
        juce::TextButton learnButton{"Learn"};
        juce::TextButton removeButton{"Remove"};
    };
    std::vector<std::unique_ptr<MappingRow>> mappingRows;
    juce::TextButton addMappingButton{"+ Add mapping"};
    int learningMappingIndex = -1; // -1 = not learning

    void rebuildKeybindRows();
    void rebuildMappingRows();
    void layoutLowerContent();
    void commitMappingRow(size_t index);
    void addMapping();
    void removeMapping(size_t index);
    void persistAndNotify();
};

} // namespace resoset
