#include "ui/legacy/SettingsPanel.h"

namespace resoset {

namespace {

void styleCombo(juce::ComboBox& c) {
    c.setColour(juce::ComboBox::backgroundColourId, ui::panelAlt());
    c.setColour(juce::ComboBox::textColourId, ui::text());
    c.setColour(juce::ComboBox::outlineColourId, ui::border());
}

void styleEdit(juce::TextEditor& e) {
    e.setColour(juce::TextEditor::backgroundColourId, ui::panelAlt());
    e.setColour(juce::TextEditor::textColourId, ui::text());
    e.setColour(juce::TextEditor::outlineColourId, ui::border());
    e.setJustification(juce::Justification::centred);
}

constexpr int kActionCount = 11; // must match SettingsPanel::kActions length

} // namespace

SettingsPanel::SettingsPanel(AudioEngine& engineRef, CoreMidiInputListener& midiInRef)
    : engine(engineRef), midiInput(midiInRef) {
    header.setText("SETTINGS  --  audio interface, MIDI, keybindings, diagnostics", juce::dontSendNotification);
    header.setColour(juce::Label::textColourId, ui::muted());
    header.setFont(juce::Font(juce::FontOptions(12.0f, juce::Font::bold)));
    addAndMakeVisible(header);

    deviceSelector = std::make_unique<juce::AudioDeviceSelectorComponent>(
        engine.deviceManager(),
        0, 0,
        0, 32,
        false, false, false, true);
    addAndMakeVisible(*deviceSelector);

    themeToggle.setColour(juce::ToggleButton::textColourId, ui::text());
    themeToggle.setToggleState(ui::currentTheme() == ui::Theme::Light, juce::dontSendNotification);
    themeToggle.onClick = [this] {
        ui::setTheme(themeToggle.getToggleState() ? ui::Theme::Light : ui::Theme::Dark);
        if (auto* top = getTopLevelComponent())
            top->repaint();
    };
    addAndMakeVisible(themeToggle);

    midiOutLabel.setText("MIDI output (Live Stage / hardware)", juce::dontSendNotification);
    midiOutLabel.setColour(juce::Label::textColourId, ui::text());
    addAndMakeVisible(midiOutLabel);
    addAndMakeVisible(midiOutputSelector);
    midiOutputSelector.onChange = [this] {
        const int selected = midiOutputSelector.getSelectedId();
        if (selected <= 0)
            return;
        const auto names = engine.midi().availableDestinationNames();
        const size_t idx = static_cast<size_t>(selected - 1);
        if (idx >= names.size())
            return;
        std::string error;
        engine.midi().openDestination(names[idx], error);
    };

    midiInLabel.setText("MIDI remote input (footswitch / pads)", juce::dontSendNotification);
    midiInLabel.setColour(juce::Label::textColourId, ui::text());
    addAndMakeVisible(midiInLabel);
    addAndMakeVisible(midiInputSelector);
    midiInputSelector.onChange = [this] {
        const int selected = midiInputSelector.getSelectedId();
        if (selected <= 0)
            return;
        const auto names = midiInput.availableSourceNames();
        const size_t idx = static_cast<size_t>(selected - 1);
        if (idx >= names.size())
            return;
        std::string error;
        midiInput.openSource(names[idx], error);
    };

    underrunButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
    underrunButton.onClick = [this] {
        if (onSimulateUnderrun)
            onSimulateUnderrun();
        else
            engine.simulateUnderrun(500.0);
    };
    addAndMakeVisible(underrunButton);

    remoteLabel.setColour(juce::Label::textColourId, ui::muted());
    remoteLabel.setText("Remote UI: http://<this-mac>:2899/", juce::dontSendNotification);
    addAndMakeVisible(remoteLabel);

    keybindHeader.setText("KEYBOARD SHORTCUTS  --  click, then press a key to rebind (Esc cancels)",
                           juce::dontSendNotification);
    keybindHeader.setColour(juce::Label::textColourId, ui::muted());
    keybindHeader.setFont(juce::Font(juce::FontOptions(11.0f, juce::Font::bold)));
    lowerContent.addAndMakeVisible(keybindHeader);

    mappingHeader.setText("MIDI REMOTE MAPPING  --  footswitch / pad -> action", juce::dontSendNotification);
    mappingHeader.setColour(juce::Label::textColourId, ui::muted());
    mappingHeader.setFont(juce::Font(juce::FontOptions(11.0f, juce::Font::bold)));
    lowerContent.addAndMakeVisible(mappingHeader);

    addMappingButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
    addMappingButton.onClick = [this] { addMapping(); };
    lowerContent.addAndMakeVisible(addMappingButton);

    lowerViewport.setViewedComponent(&lowerContent, false);
    lowerViewport.setScrollBarsShown(true, false);
    addAndMakeVisible(lowerViewport);

    rebuildKeybindRows();
    rebuildMappingRows();
    refreshMidiLists();
}

void SettingsPanel::paint(juce::Graphics& g) {
    g.fillAll(ui::bg());
}

void SettingsPanel::resized() {
    auto r = getLocalBounds().reduced(12);
    auto headerRow = r.removeFromTop(18);
    themeToggle.setBounds(headerRow.removeFromRight(110));
    header.setBounds(headerRow);
    r.removeFromTop(8);
    deviceSelector->setBounds(r.removeFromTop(280));
    r.removeFromTop(12);
    midiOutLabel.setBounds(r.removeFromTop(20));
    midiOutputSelector.setBounds(r.removeFromTop(28));
    r.removeFromTop(8);
    midiInLabel.setBounds(r.removeFromTop(20));
    midiInputSelector.setBounds(r.removeFromTop(28));
    r.removeFromTop(12);
    underrunButton.setBounds(r.removeFromTop(32).removeFromLeft(240));
    r.removeFromTop(12);
    remoteLabel.setBounds(r.removeFromTop(24));
    r.removeFromTop(12);

    lowerViewport.setBounds(r);
    layoutLowerContent();
}

void SettingsPanel::layoutLowerContent() {
    const int width = juce::jmax(200, lowerViewport.getWidth() - lowerViewport.getScrollBarThickness());
    int y = 0;

    keybindHeader.setBounds(0, y, width, 18);
    y += 22;
    for (auto& row : keybindRows) {
        row->actionLabel.setBounds(0, y, 140, 26);
        row->keyButton.setBounds(148, y, 200, 26);
        y += 30;
    }

    y += 14;
    mappingHeader.setBounds(0, y, width, 18);
    y += 22;

    for (auto& row : mappingRows) {
        int x = 0;
        row->actionBox.setBounds(x, y, 90, 26);
        x += 96;
        row->triggerBox.setBounds(x, y, 90, 26);
        x += 96;
        row->channelEdit.setBounds(x, y, 60, 26);
        x += 66;
        row->numberEdit.setBounds(x, y, 60, 26);
        x += 66;
        row->learnButton.setBounds(x, y, 70, 26);
        x += 76;
        row->removeButton.setBounds(x, y, 76, 26);
        y += 32;
    }

    addMappingButton.setBounds(0, y, 160, 28);
    y += 40;

    lowerContent.setBounds(0, 0, width, y);
}

void SettingsPanel::refreshMidiLists() {
    midiOutputSelector.clear(juce::dontSendNotification);
    const auto outs = engine.midi().availableDestinationNames();
    for (int i = 0; i < static_cast<int>(outs.size()); ++i)
        midiOutputSelector.addItem(juce::String(outs[static_cast<size_t>(i)]), i + 1);
    midiOutputSelector.setTextWhenNothingSelected("Select MIDI output...");

    midiInputSelector.clear(juce::dontSendNotification);
    const auto ins = midiInput.availableSourceNames();
    for (int i = 0; i < static_cast<int>(ins.size()); ++i)
        midiInputSelector.addItem(juce::String(ins[static_cast<size_t>(i)]), i + 1);
    midiInputSelector.setTextWhenNothingSelected("Select MIDI remote...");
}

void SettingsPanel::refreshBindings() {
    rebuildKeybindRows();
    rebuildMappingRows();
}

// ---------------------------------------------------------------------------
// Keybindings

void SettingsPanel::rebuildKeybindRows() {
    keybindRows.clear();
    for (const char* action : kActions) {
        auto row = std::make_unique<KeybindRow>();
        row->action = action;
        row->actionLabel.setText(juce::String(action), juce::dontSendNotification);
        row->actionLabel.setColour(juce::Label::textColourId, ui::text());
        lowerContent.addAndMakeVisible(row->actionLabel);

        row->keyButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
        KeybindRow* rowPtr = row.get();
        row->keyButton.onClick = [this, rowPtr] {
            rebindingAction = rowPtr->action;
            rowPtr->keyButton.setButtonText("Press a key...");
            setWantsKeyboardFocus(true);
            grabKeyboardFocus();
        };
        lowerContent.addAndMakeVisible(row->keyButton);

        const auto& bindings = engine.project().keybindings;
        const auto it = bindings.find(action);
        const std::string description = (it != bindings.end()) ? it->second : "(unbound)";
        row->keyButton.setButtonText(juce::String(description));

        keybindRows.push_back(std::move(row));
    }
    layoutLowerContent();
}

bool SettingsPanel::keyPressed(const juce::KeyPress& key) {
    if (rebindingAction.empty())
        return false;

    const std::string action = rebindingAction;
    rebindingAction.clear();

    // Escape cancels the capture without changing the binding.
    if (key == juce::KeyPress::escapeKey) {
        rebuildKeybindRows();
        return true;
    }

    engine.project().keybindings[action] = key.getTextDescription().toStdString();
    rebuildKeybindRows();
    persistAndNotify();
    return true;
}

// ---------------------------------------------------------------------------
// MIDI remote mapping

void SettingsPanel::rebuildMappingRows() {
    mappingRows.clear();
    auto& mappings = engine.project().midiMappings;

    for (size_t i = 0; i < mappings.size(); ++i) {
        auto row = std::make_unique<MappingRow>();
        const MidiMapping& m = mappings[i];

        styleCombo(row->actionBox);
        int id = 1;
        for (const char* action : kActions)
            row->actionBox.addItem(juce::String(action), id++);
        row->actionBox.setSelectedId(1, juce::dontSendNotification);
        for (int a = 0; a < kActionCount; ++a) {
            if (m.action == kActions[static_cast<size_t>(a)]) {
                row->actionBox.setSelectedId(a + 1, juce::dontSendNotification);
                break;
            }
        }
        lowerContent.addAndMakeVisible(row->actionBox);

        styleCombo(row->triggerBox);
        row->triggerBox.addItem("Note On", 1);
        row->triggerBox.addItem("CC", 2);
        row->triggerBox.setSelectedId(m.triggerType == MidiTriggerType::ControlChange ? 2 : 1,
                                       juce::dontSendNotification);
        lowerContent.addAndMakeVisible(row->triggerBox);

        styleEdit(row->channelEdit);
        row->channelEdit.setText(juce::String(m.channel), juce::dontSendNotification);
        row->channelEdit.setInputRestrictions(3, "0123456789");
        lowerContent.addAndMakeVisible(row->channelEdit);

        styleEdit(row->numberEdit);
        row->numberEdit.setText(juce::String(m.number), juce::dontSendNotification);
        row->numberEdit.setInputRestrictions(3, "0123456789");
        lowerContent.addAndMakeVisible(row->numberEdit);

        MappingRow* rowPtr = row.get();
        const size_t index = i;

        row->actionBox.onChange = [this, index] { commitMappingRow(index); };
        row->triggerBox.onChange = [this, index] { commitMappingRow(index); };
        row->channelEdit.onTextChange = [this, index] { commitMappingRow(index); };
        row->numberEdit.onTextChange = [this, index] { commitMappingRow(index); };

        row->learnButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
        row->learnButton.onClick = [this, rowPtr, index] {
            learningMappingIndex = static_cast<int>(index);
            rowPtr->learnButton.setButtonText("Listening...");
        };
        lowerContent.addAndMakeVisible(row->learnButton);

        row->removeButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
        row->removeButton.onClick = [this, index] { removeMapping(index); };
        lowerContent.addAndMakeVisible(row->removeButton);

        mappingRows.push_back(std::move(row));
    }
    layoutLowerContent();
}

void SettingsPanel::commitMappingRow(size_t index) {
    auto& mappings = engine.project().midiMappings;
    if (index >= mappings.size() || index >= mappingRows.size())
        return;

    MidiMapping& m = mappings[index];
    MappingRow& row = *mappingRows[index];

    const int actionIdx = row.actionBox.getSelectedId() - 1;
    if (actionIdx >= 0 && actionIdx < kActionCount)
        m.action = kActions[static_cast<size_t>(actionIdx)];

    m.triggerType = row.triggerBox.getSelectedId() == 2 ? MidiTriggerType::ControlChange
                                                         : MidiTriggerType::NoteOn;
    m.channel = juce::jlimit(0, 16, row.channelEdit.getText().getIntValue());
    m.number = juce::jlimit(0, 127, row.numberEdit.getText().getIntValue());

    persistAndNotify();
}

void SettingsPanel::addMapping() {
    engine.project().midiMappings.push_back(MidiMapping{});
    rebuildMappingRows();
    persistAndNotify();
}

void SettingsPanel::removeMapping(size_t index) {
    auto& mappings = engine.project().midiMappings;
    if (index >= mappings.size())
        return;
    mappings.erase(mappings.begin() + static_cast<long>(index));
    learningMappingIndex = -1;
    rebuildMappingRows();
    persistAndNotify();
}

void SettingsPanel::handleMidiLearn(MidiTriggerType type, int channel1to16, int number) {
    if (learningMappingIndex < 0)
        return;
    const size_t index = static_cast<size_t>(learningMappingIndex);
    learningMappingIndex = -1;

    auto& mappings = engine.project().midiMappings;
    if (index >= mappings.size())
        return;

    MidiMapping& m = mappings[index];
    m.triggerType = type;
    m.channel = channel1to16;
    m.number = number;

    rebuildMappingRows();
    persistAndNotify();
}

void SettingsPanel::persistAndNotify() {
    if (onBindingsChanged)
        onBindingsChanged();
}

} // namespace resoset
