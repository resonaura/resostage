#include "ui/legacy/BuilderPanel.h"

#include <algorithm>

namespace resoset {

namespace {
void styleSectionLabel(juce::Label& l) {
    l.setColour(juce::Label::textColourId, ui::muted());
    l.setFont(juce::Font(juce::FontOptions(11.0f, juce::Font::bold)));
}
void styleEdit(juce::TextEditor& e) {
    e.setColour(juce::TextEditor::backgroundColourId, ui::panelAlt());
    e.setColour(juce::TextEditor::textColourId, ui::text());
    e.setColour(juce::TextEditor::outlineColourId, ui::border());
}
} // namespace

BuilderPanel::BuilderPanel(AudioEngine& engineRef) : engine(engineRef) {
    header.setText("BUILDER  --  edit set structure (songs, tracks, events, busses)", juce::dontSendNotification);
    header.setColour(juce::Label::textColourId, ui::muted());
    header.setFont(juce::Font(juce::FontOptions(12.0f, juce::Font::bold)));
    addAndMakeVisible(header);

    auto wireTab = [this](juce::TextButton& b, ListTarget t) {
        b.setClickingTogglesState(true);
        b.setRadioGroupId(42);
        b.setColour(juce::TextButton::buttonOnColourId, ui::accent());
        b.setColour(juce::TextButton::textColourOnId, juce::Colours::white);
        b.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
        b.setColour(juce::TextButton::textColourOffId, ui::text());
        b.onClick = [this, t] { setListTarget(t); };
        addAndMakeVisible(b);
    };
    wireTab(songsTab, ListTarget::Songs);
    wireTab(tracksTab, ListTarget::Tracks);
    wireTab(eventsTab, ListTarget::Events);
    wireTab(bussesTab, ListTarget::Busses);
    songsTab.setToggleState(true, juce::dontSendNotification);

    list.setRowHeight(28);
    list.setColour(juce::ListBox::backgroundColourId, ui::panel());
    list.setColour(juce::ListBox::outlineColourId, ui::border());
    addAndMakeVisible(list);

    auto styleTool = [](juce::TextButton& b) {
        b.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
        b.setColour(juce::TextButton::textColourOffId, ui::text());
    };
    styleTool(addButton);
    styleTool(removeButton);
    styleTool(moveUpButton);
    styleTool(moveDownButton);
    addButton.onClick = [this] { addItem(); };
    removeButton.onClick = [this] { removeItem(); };
    moveUpButton.onClick = [this] { moveItem(-1); };
    moveDownButton.onClick = [this] { moveItem(1); };
    addAndMakeVisible(addButton);
    addAndMakeVisible(removeButton);
    addAndMakeVisible(moveUpButton);
    addAndMakeVisible(moveDownButton);

    styleTool(importSongFolderButton);
    importSongFolderButton.onClick = [this] { importSongFolderClicked(); };
    addAndMakeVisible(importSongFolderButton);

    songContextLabel.setText("Song:", juce::dontSendNotification);
    songContextLabel.setColour(juce::Label::textColourId, ui::muted());
    songContextLabel.setFont(juce::Font(juce::FontOptions(11.0f)));
    addAndMakeVisible(songContextLabel);

    songContextBox.setColour(juce::ComboBox::backgroundColourId, ui::panelAlt());
    songContextBox.setColour(juce::ComboBox::textColourId, ui::text());
    songContextBox.setColour(juce::ComboBox::outlineColourId, ui::border());
    songContextBox.onChange = [this] {
        const int sel = songContextBox.getSelectedItemIndex();
        if (sel < 0)
            return;
        // Pure editing-context switch -- deliberately does NOT stage/restage
        // playback (unlike clicking a row in the Songs tab list, which does).
        selectedSongRow = sel;
        selectedItemRow = -1;
        refresh();
    };
    addAndMakeVisible(songContextBox);

    // Song editor widgets
    styleSectionLabel(songNameLabel);
    songNameLabel.setText("Song name", juce::dontSendNotification);
    styleEdit(songNameEdit);
    styleSectionLabel(bpmLabel);
    bpmLabel.setText("BPM", juce::dontSendNotification);
    bpmSlider.setRange(40.0, 300.0, 0.1);
    bpmSlider.setValue(120.0);
    bpmSlider.setTextBoxStyle(juce::Slider::TextBoxLeft, false, 60, 20);
    styleSectionLabel(modeLabel);
    modeLabel.setText("End mode", juce::dontSendNotification);
    modeBox.addItem("Wait for trigger", 1);
    modeBox.addItem("Autoplay next", 2);
    styleSectionLabel(tsLabel);
    tsLabel.setText("Time sig", juce::dontSendNotification);
    tsNumSlider.setRange(1, 16, 1);
    tsNumSlider.setValue(4);
    tsNumSlider.setTextBoxStyle(juce::Slider::TextBoxLeft, false, 40, 20);
    tsDenSlider.setRange(1, 16, 1);
    tsDenSlider.setValue(4);
    tsDenSlider.setTextBoxStyle(juce::Slider::TextBoxLeft, false, 40, 20);
    clickToggle.setColour(juce::ToggleButton::textColourId, ui::text());
    applySongButton.setColour(juce::TextButton::buttonColourId, ui::accent());
    applySongButton.onClick = [this] { applySongSettings(); };

    addAndMakeVisible(songNameLabel);
    addAndMakeVisible(songNameEdit);
    addAndMakeVisible(bpmLabel);
    addAndMakeVisible(bpmSlider);
    addAndMakeVisible(modeLabel);
    addAndMakeVisible(modeBox);
    addAndMakeVisible(tsLabel);
    addAndMakeVisible(tsNumSlider);
    addAndMakeVisible(tsDenSlider);
    addAndMakeVisible(clickToggle);
    addAndMakeVisible(clickBusBox);
    addAndMakeVisible(applySongButton);

    // Track editor
    styleSectionLabel(trackNameLabel);
    trackNameLabel.setText("Track name", juce::dontSendNotification);
    styleEdit(trackNameEdit);
    styleSectionLabel(trackBusLabel);
    trackBusLabel.setText("Route to bus", juce::dontSendNotification);
    styleSectionLabel(trackGainLabel);
    trackGainLabel.setText("Gain dB", juce::dontSendNotification);
    trackGainSlider.setRange(-60.0, 12.0, 0.1);
    trackGainSlider.setValue(0.0);
    trackGainSlider.setTextBoxStyle(juce::Slider::TextBoxLeft, false, 60, 20);
    styleSectionLabel(trackPanLabel);
    trackPanLabel.setText("Pan", juce::dontSendNotification);
    trackPanSlider.setRange(-1.0, 1.0, 0.01);
    trackPanSlider.setValue(0.0);
    trackPanSlider.setTextBoxStyle(juce::Slider::TextBoxLeft, false, 60, 20);
    trackMute.setColour(juce::ToggleButton::textColourId, ui::text());
    trackSolo.setColour(juce::ToggleButton::textColourId, ui::text());
    trackFileLabel.setColour(juce::Label::textColourId, ui::muted());
    importWavButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
    importWavButton.onClick = [this] { importWavClicked(); };
    styleSectionLabel(trackTrimLabel);
    trackTrimLabel.setText("Trim (preview only -- not yet enforced during playback)", juce::dontSendNotification);
    trackTrimEditor.onTrimChanged = [this](double startSec, double endSecOrZero) {
        if (TrackDef* t = trackDefAtSelected()) {
            t->trimStartSeconds = startSec;
            t->trimEndSeconds = endSecOrZero;
        }
    };
    styleSectionLabel(trackSendsLabel);
    trackSendsLabel.setText("Aux sends", juce::dontSendNotification);
    trackSendGainSlider.setRange(-60.0, 12.0, 0.1);
    trackSendGainSlider.setValue(0.0);
    trackSendGainSlider.setTextBoxStyle(juce::Slider::TextBoxLeft, false, 50, 20);
    trackSendPre.setColour(juce::ToggleButton::textColourId, ui::text());
    trackSendAddButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
    trackSendAddButton.onClick = [this] {
        TrackDef* t = trackDefAtSelected();
        if (t == nullptr || selectedSongRow < 0 || selectedItemRow < 0)
            return;
        const int busSel = trackSendBusBox.getSelectedItemIndex();
        if (busSel < 0 || busSel >= static_cast<int>(engine.project().busses.size()))
            return;
        TrackSendDef send;
        send.busId = engine.project().busses[static_cast<size_t>(busSel)].id;
        send.gainDb = trackSendGainSlider.getValue();
        send.preFader = trackSendPre.getToggleState();
        send.enabled = true;
        engine.addTrackSend(static_cast<size_t>(selectedSongRow), static_cast<size_t>(selectedItemRow), send);
        loadTrackEditor();
        if (onRoutingEdited)
            onRoutingEdited();
    };
    trackSendRemoveButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
    trackSendRemoveButton.onClick = [this] {
        TrackDef* t = trackDefAtSelected();
        if (t == nullptr || t->sends.empty() || selectedSongRow < 0 || selectedItemRow < 0)
            return;
        const size_t last = t->sends.size() - 1;
        engine.removeTrackSend(static_cast<size_t>(selectedSongRow), static_cast<size_t>(selectedItemRow), last);
        loadTrackEditor();
        if (onRoutingEdited)
            onRoutingEdited();
    };
    trackSendsListLabel.setColour(juce::Label::textColourId, ui::muted());
    trackSendsListLabel.setJustificationType(juce::Justification::topLeft);
    applyTrackButton.setColour(juce::TextButton::buttonColourId, ui::accent());
    applyTrackButton.onClick = [this] { applyTrackSettings(); };

    addAndMakeVisible(trackNameLabel);
    addAndMakeVisible(trackNameEdit);
    addAndMakeVisible(trackBusLabel);
    addAndMakeVisible(trackBusBox);
    addAndMakeVisible(trackGainLabel);
    addAndMakeVisible(trackGainSlider);
    addAndMakeVisible(trackPanLabel);
    addAndMakeVisible(trackPanSlider);
    addAndMakeVisible(trackMute);
    addAndMakeVisible(trackSolo);
    addAndMakeVisible(trackFileLabel);
    addAndMakeVisible(importWavButton);
    addAndMakeVisible(trackTrimLabel);
    addAndMakeVisible(trackTrimEditor);
    addAndMakeVisible(trackSendsLabel);
    addAndMakeVisible(trackSendBusBox);
    addAndMakeVisible(trackSendGainSlider);
    addAndMakeVisible(trackSendPre);
    addAndMakeVisible(trackSendAddButton);
    addAndMakeVisible(trackSendRemoveButton);
    addAndMakeVisible(trackSendsListLabel);
    addAndMakeVisible(applyTrackButton);

    // Bus editor
    styleSectionLabel(busNameLabel);
    busNameLabel.setText("Bus name", juce::dontSendNotification);
    styleEdit(busNameEdit);
    styleSectionLabel(busOutLabel);
    busOutLabel.setText("Output channel(s)", juce::dontSendNotification);
    busOutBox.setColour(juce::ComboBox::backgroundColourId, ui::panelAlt());
    busOutBox.setColour(juce::ComboBox::textColourId, ui::text());
    busOutBox.setColour(juce::ComboBox::outlineColourId, ui::border());
    styleSectionLabel(busGainLabel);
    busGainLabel.setText("Gain dB", juce::dontSendNotification);
    busGainSlider.setRange(-60.0, 12.0, 0.1);
    busGainSlider.setValue(0.0);
    busGainSlider.setTextBoxStyle(juce::Slider::TextBoxLeft, false, 60, 20);
    styleSectionLabel(busChLabel);
    busChLabel.setText("Width", juce::dontSendNotification);
    busChBox.addItem("Mono", 1);
    busChBox.addItem("Stereo", 2);
    // Mono/stereo changes which physical channels make sense (single
    // channels 1..16 vs pairs 1/2, 3/4, ... 13/14) -- rebuild the picker,
    // best-effort preserving the current start channel.
    busChBox.onChange = [this] { refreshBusOutBox(); };
    busMute.setColour(juce::ToggleButton::textColourId, ui::text());
    busSolo.setColour(juce::ToggleButton::textColourId, ui::text());
    busIsAux.setColour(juce::ToggleButton::textColourId, ui::text());
    applyBusButton.setColour(juce::TextButton::buttonColourId, ui::accent());
    applyBusButton.onClick = [this] { applyBusSettings(); };

    addAndMakeVisible(busNameLabel);
    addAndMakeVisible(busNameEdit);
    addAndMakeVisible(busOutLabel);
    addAndMakeVisible(busOutBox);
    addAndMakeVisible(busGainLabel);
    addAndMakeVisible(busGainSlider);
    addAndMakeVisible(busChLabel);
    addAndMakeVisible(busChBox);
    addAndMakeVisible(busMute);
    addAndMakeVisible(busSolo);
    addAndMakeVisible(busIsAux);
    addAndMakeVisible(applyBusButton);

    styleSectionLabel(eventTypeLabel);
    eventTypeLabel.setText("Type", juce::dontSendNotification);
    eventTypeBox.addItem("Program Change", 1);
    eventTypeBox.addItem("CC", 2);
    eventTypeBox.addItem("Note On", 3);
    eventTypeBox.addItem("Note Off", 4);
    eventTypeBox.addItem("HTTP", 5);
    eventTypeBox.addItem("DMX", 6);
    styleSectionLabel(eventTimeLabel);
    eventTimeLabel.setText("Time (s)", juce::dontSendNotification);
    eventTimeSlider.setRange(0.0, 600.0, 0.001);
    eventTimeSlider.setValue(0.0);
    eventTimeSlider.setTextBoxStyle(juce::Slider::TextBoxLeft, false, 70, 20);
    eventOnLoad.setColour(juce::ToggleButton::textColourId, ui::text());
    styleSectionLabel(eventLatencyLabel);
    eventLatencyLabel.setText("Latency comp (ms)", juce::dontSendNotification);
    eventLatencySlider.setRange(0.0, 500.0, 0.1);
    eventLatencySlider.setValue(0.0);
    eventLatencySlider.setTextBoxStyle(juce::Slider::TextBoxLeft, false, 60, 20);
    styleSectionLabel(eventMidiChLabel);
    eventMidiChLabel.setText("MIDI ch / data", juce::dontSendNotification);
    eventMidiChSlider.setRange(1, 16, 1);
    eventMidiChSlider.setValue(1);
    eventMidiChSlider.setTextBoxStyle(juce::Slider::TextBoxLeft, false, 40, 20);
    eventMidiData1Slider.setRange(0, 127, 1);
    eventMidiData1Slider.setValue(0);
    eventMidiData1Slider.setTextBoxStyle(juce::Slider::TextBoxLeft, false, 50, 20);
    eventMidiData2Slider.setRange(0, 127, 1);
    eventMidiData2Slider.setValue(100);
    eventMidiData2Slider.setTextBoxStyle(juce::Slider::TextBoxLeft, false, 50, 20);
    styleSectionLabel(eventHttpUrlLabel);
    eventHttpUrlLabel.setText("HTTP URL", juce::dontSendNotification);
    styleEdit(eventHttpUrlEdit);
    applyEventButton.setColour(juce::TextButton::buttonColourId, ui::accent());
    applyEventButton.onClick = [this] { applyEventSettings(); };

    addAndMakeVisible(eventTypeLabel);
    addAndMakeVisible(eventTypeBox);
    addAndMakeVisible(eventTimeLabel);
    addAndMakeVisible(eventTimeSlider);
    addAndMakeVisible(eventOnLoad);
    addAndMakeVisible(eventLatencyLabel);
    addAndMakeVisible(eventLatencySlider);
    addAndMakeVisible(eventMidiChLabel);
    addAndMakeVisible(eventMidiChSlider);
    addAndMakeVisible(eventMidiData1Slider);
    addAndMakeVisible(eventMidiData2Slider);
    addAndMakeVisible(eventHttpUrlLabel);
    addAndMakeVisible(eventHttpUrlEdit);
    addAndMakeVisible(applyEventButton);

    emptyHint.setText("Load a .rsnraset project to edit.", juce::dontSendNotification);
    emptyHint.setColour(juce::Label::textColourId, ui::muted());
    emptyHint.setJustificationType(juce::Justification::centred);
    addAndMakeVisible(emptyHint);

    refreshBusOutBox();

    showSongEditor(true);
    showTrackEditor(false);
    showBusEditor(false);
    showEventEditor(false);
}

void BuilderPanel::paint(juce::Graphics& g) {
    g.fillAll(ui::bg());
    auto r = getLocalBounds().reduced(12);
    r.removeFromTop(52);
    auto left = r.removeFromLeft(juce::jmax(260, r.getWidth() * 40 / 100));
    g.setColour(ui::panel());
    g.fillRoundedRectangle(left.toFloat(), 10.0f);
    r.removeFromLeft(12);
    g.fillRoundedRectangle(r.toFloat(), 10.0f);
}

void BuilderPanel::resized() {
    auto r = getLocalBounds().reduced(12);
    header.setBounds(r.removeFromTop(18));
    r.removeFromTop(6);
    auto tabs = r.removeFromTop(28);
    const int tw = tabs.getWidth() / 4 - 4;
    songsTab.setBounds(tabs.removeFromLeft(tw));
    tabs.removeFromLeft(4);
    tracksTab.setBounds(tabs.removeFromLeft(tw));
    tabs.removeFromLeft(4);
    eventsTab.setBounds(tabs.removeFromLeft(tw));
    tabs.removeFromLeft(4);
    bussesTab.setBounds(tabs);

    r.removeFromTop(8);
    auto left = r.removeFromLeft(juce::jmax(260, r.getWidth() * 40 / 100)).reduced(10);
    r.removeFromLeft(12);
    auto right = r.reduced(14);

    // Same row, mutually exclusive: song-context picker (Tracks/Events tabs)
    // or the Import Song Folder button (Songs tab) -- see refresh().
    auto contextRowFull = left.removeFromTop(28);
    auto contextRow = contextRowFull;
    songContextLabel.setBounds(contextRow.removeFromLeft(46));
    songContextBox.setBounds(contextRow);
    importSongFolderButton.setBounds(contextRowFull);
    left.removeFromTop(6);

    auto tools = left.removeFromBottom(32);
    addButton.setBounds(tools.removeFromLeft(56));
    tools.removeFromLeft(4);
    removeButton.setBounds(tools.removeFromLeft(72));
    tools.removeFromLeft(8);
    moveUpButton.setBounds(tools.removeFromLeft(36));
    tools.removeFromLeft(4);
    moveDownButton.setBounds(tools.removeFromLeft(36));
    left.removeFromBottom(6);
    list.setBounds(left);
    emptyHint.setBounds(right);

    auto place = [&](juce::Component& c, int h = 24) {
        c.setBounds(right.removeFromTop(h));
        right.removeFromTop(4);
    };

    // Song editor layout
    place(songNameLabel, 16);
    place(songNameEdit, 28);
    place(bpmLabel, 16);
    place(bpmSlider, 28);
    place(modeLabel, 16);
    place(modeBox, 28);
    place(tsLabel, 16);
    auto tsRow = right.removeFromTop(28);
    tsNumSlider.setBounds(tsRow.removeFromLeft(tsRow.getWidth() / 2 - 4));
    tsRow.removeFromLeft(8);
    tsDenSlider.setBounds(tsRow);
    right.removeFromTop(4);
    place(clickToggle, 24);
    place(clickBusBox, 28);
    place(applySongButton, 32);

    // Track editor (same right column; visibility toggled)
    // Track/bus/event editors share the right column; visibility is toggled.
    auto editor2 = getLocalBounds().reduced(12);
    editor2.removeFromTop(52);
    editor2.removeFromLeft(juce::jmax(260, editor2.getWidth() * 40 / 100) + 12);
    editor2 = editor2.reduced(14);

    auto place2 = [&](juce::Component& c, int h = 24) {
        c.setBounds(editor2.removeFromTop(h));
        editor2.removeFromTop(4);
    };
    place2(trackNameLabel, 16);
    place2(trackNameEdit, 28);
    place2(trackBusLabel, 16);
    place2(trackBusBox, 28);
    place2(trackGainLabel, 16);
    place2(trackGainSlider, 28);
    place2(trackPanLabel, 16);
    place2(trackPanSlider, 28);
    place2(trackMute, 24);
    place2(trackSolo, 24);
    place2(trackFileLabel, 28);
    place2(importWavButton, 26);
    place2(trackTrimLabel, 16);
    place2(trackTrimEditor, 48);
    place2(trackSendsLabel, 16);
    place2(trackSendBusBox, 26);
    place2(trackSendGainSlider, 26);
    place2(trackSendPre, 22);
    place2(trackSendAddButton, 26);
    place2(trackSendRemoveButton, 26);
    place2(trackSendsListLabel, 48);
    place2(applyTrackButton, 28);

    auto editor3 = getLocalBounds().reduced(12);
    editor3.removeFromTop(52);
    editor3.removeFromLeft(juce::jmax(260, editor3.getWidth() * 40 / 100) + 12);
    editor3 = editor3.reduced(14);
    auto place3 = [&](juce::Component& c, int h = 24) {
        c.setBounds(editor3.removeFromTop(h));
        editor3.removeFromTop(4);
    };
    place3(busNameLabel, 16);
    place3(busNameEdit, 28);
    place3(busOutLabel, 16);
    place3(busOutBox, 28);
    place3(busGainLabel, 16);
    place3(busGainSlider, 28);
    place3(busChLabel, 16);
    place3(busChBox, 28);
    place3(busMute, 24);
    place3(busSolo, 24);
    place3(busIsAux, 24);
    place3(applyBusButton, 32);

    auto editor4 = getLocalBounds().reduced(12);
    editor4.removeFromTop(52);
    editor4.removeFromLeft(juce::jmax(260, editor4.getWidth() * 40 / 100) + 12);
    editor4 = editor4.reduced(14);
    auto place4 = [&](juce::Component& c, int h = 24) {
        c.setBounds(editor4.removeFromTop(h));
        editor4.removeFromTop(4);
    };
    place4(eventTypeLabel, 16);
    place4(eventTypeBox, 28);
    place4(eventTimeLabel, 16);
    place4(eventTimeSlider, 28);
    place4(eventOnLoad, 24);
    place4(eventLatencyLabel, 16);
    place4(eventLatencySlider, 28);
    place4(eventMidiChLabel, 16);
    auto midiRow = editor4.removeFromTop(28);
    eventMidiChSlider.setBounds(midiRow.removeFromLeft(midiRow.getWidth() / 3 - 4));
    midiRow.removeFromLeft(4);
    eventMidiData1Slider.setBounds(midiRow.removeFromLeft(midiRow.getWidth() / 2 - 2));
    midiRow.removeFromLeft(4);
    eventMidiData2Slider.setBounds(midiRow);
    editor4.removeFromTop(4);
    place4(eventHttpUrlLabel, 16);
    place4(eventHttpUrlEdit, 28);
    place4(applyEventButton, 32);
}

void BuilderPanel::refresh() {
    const bool loaded = engine.isProjectLoaded();
    emptyHint.setVisible(!loaded);
    list.setVisible(loaded);

    if (selectedSongRow < 0 && loaded && !engine.project().songs.empty())
        selectedSongRow = static_cast<int>(engine.currentSongIndex() == static_cast<size_t>(-1)
                                               ? 0
                                               : engine.currentSongIndex());
    // Clamp after possible song removal elsewhere.
    if (loaded && selectedSongRow >= static_cast<int>(engine.project().songs.size()))
        selectedSongRow = static_cast<int>(engine.project().songs.size()) - 1;

    list.updateContent();
    if (selectedItemRow >= 0)
        list.selectRow(selectedItemRow, false);

    fillBusCombo(trackBusBox);
    trackBusBox.addItem("(none - sends only)", kNoBusComboId);
    fillBusCombo(clickBusBox);
    refreshSongContextBox();

    // The song-context picker only makes sense outside the Songs tab (on
    // Songs, the list itself IS the song picker); Import Song Folder only
    // makes sense ON the Songs tab.
    const bool showSongContext = loaded && activeList != ListTarget::Songs;
    songContextLabel.setVisible(showSongContext);
    songContextBox.setVisible(showSongContext);
    importSongFolderButton.setVisible(loaded && activeList == ListTarget::Songs);

    switch (activeList) {
        case ListTarget::Songs:
            showSongEditor(loaded);
            showTrackEditor(false);
            showBusEditor(false);
            showEventEditor(false);
            loadSongEditor();
            break;
        case ListTarget::Tracks:
            showSongEditor(false);
            showTrackEditor(loaded);
            showBusEditor(false);
            showEventEditor(false);
            loadTrackEditor();
            break;
        case ListTarget::Events:
            showSongEditor(false);
            showTrackEditor(false);
            showBusEditor(false);
            showEventEditor(loaded);
            loadEventEditor();
            break;
        case ListTarget::Busses:
            showSongEditor(false);
            showTrackEditor(false);
            showBusEditor(loaded);
            showEventEditor(false);
            loadBusEditor();
            break;
    }
    emptyHint.toFront(false);
}

void BuilderPanel::setListTarget(ListTarget t) {
    activeList = t;
    selectedItemRow = -1;
    refresh();
}

void BuilderPanel::showSongEditor(bool show) {
    for (juce::Component* c : std::initializer_list<juce::Component*>{
             &songNameLabel, &songNameEdit, &bpmLabel, &bpmSlider, &modeLabel, &modeBox,
             &tsLabel, &tsNumSlider, &tsDenSlider, &clickToggle, &clickBusBox, &applySongButton})
        c->setVisible(show);
}

void BuilderPanel::showTrackEditor(bool show) {
    for (juce::Component* c : std::initializer_list<juce::Component*>{
             &trackNameLabel, &trackNameEdit, &trackBusLabel, &trackBusBox, &trackGainLabel,
             &trackGainSlider, &trackPanLabel, &trackPanSlider, &trackMute, &trackSolo,
             &trackFileLabel, &importWavButton, &trackTrimLabel, &trackTrimEditor, &trackSendsLabel,
             &trackSendBusBox, &trackSendGainSlider, &trackSendPre, &trackSendAddButton,
             &trackSendRemoveButton, &trackSendsListLabel, &applyTrackButton})
        c->setVisible(show);
}

TrackDef* BuilderPanel::trackDefAtSelected() {
    SongDef* s = currentSong();
    if (s == nullptr || selectedItemRow < 0 || selectedItemRow >= static_cast<int>(s->tracks.size()))
        return nullptr;
    return &s->tracks[static_cast<size_t>(selectedItemRow)];
}

void BuilderPanel::showBusEditor(bool show) {
    for (juce::Component* c : std::initializer_list<juce::Component*>{
             &busNameLabel, &busNameEdit, &busOutLabel, &busOutBox, &busGainLabel,
             &busGainSlider, &busChLabel, &busChBox, &busMute, &busSolo, &busIsAux,
             &applyBusButton})
        c->setVisible(show);
}

void BuilderPanel::showEventEditor(bool show) {
    for (juce::Component* c : std::initializer_list<juce::Component*>{
             &eventTypeLabel, &eventTypeBox, &eventTimeLabel, &eventTimeSlider, &eventOnLoad,
             &eventLatencyLabel, &eventLatencySlider, &eventMidiChLabel, &eventMidiChSlider,
             &eventMidiData1Slider, &eventMidiData2Slider, &eventHttpUrlLabel, &eventHttpUrlEdit,
             &applyEventButton})
        c->setVisible(show);
}

void BuilderPanel::fillBusCombo(juce::ComboBox& box) {
    box.clear(juce::dontSendNotification);
    int id = 1;
    for (const auto& b : engine.project().busses)
        box.addItem(juce::String(b.name.empty() ? b.id : b.name) + " (" + juce::String(b.id) + ")", id++);
}

void BuilderPanel::refreshBusOutBox() {
    // Preserve list POSITION (not exact channel) across a mono/stereo mode
    // toggle -- simple and predictable ("3rd item stays the 3rd item").
    const int prevIndex = busOutBox.getSelectedItemIndex();
    busOutBox.clear(juce::dontSendNotification);

    const bool stereo = busChBox.getSelectedId() != 1; // default to stereo if nothing selected yet
    if (stereo) {
        static const char* const kPairs[] = {"1/2", "3/4", "5/6", "7/8", "9/10", "11/12", "13/14"};
        for (int i = 0; i < 7; ++i)
            busOutBox.addItem(kPairs[i], i + 1);
    } else {
        for (int ch = 1; ch <= 16; ++ch)
            busOutBox.addItem("Ch " + juce::String(ch), ch);
    }

    const int restoreIndex = juce::jlimit(0, busOutBox.getNumItems() - 1, prevIndex < 0 ? 0 : prevIndex);
    busOutBox.setSelectedItemIndex(restoreIndex, juce::dontSendNotification);
}

void BuilderPanel::refreshSongContextBox() {
    songContextBox.clear(juce::dontSendNotification);
    const auto& songs = engine.project().songs;
    for (size_t i = 0; i < songs.size(); ++i) {
        const auto& s = songs[i];
        songContextBox.addItem(juce::String(static_cast<int>(i) + 1) + ". "
                                    + juce::String(s.name.empty() ? s.id : s.name),
                                static_cast<int>(i) + 1);
    }
    if (selectedSongRow >= 0 && selectedSongRow < static_cast<int>(songs.size()))
        songContextBox.setSelectedId(selectedSongRow + 1, juce::dontSendNotification);
    else
        songContextBox.setTextWhenNothingSelected("No songs yet");
}

SongDef* BuilderPanel::currentSong() {
    if (!engine.isProjectLoaded() || selectedSongRow < 0)
        return nullptr;
    auto& songs = engine.project().songs;
    if (selectedSongRow >= static_cast<int>(songs.size()))
        return nullptr;
    return &songs[static_cast<size_t>(selectedSongRow)];
}

const SongDef* BuilderPanel::currentSong() const {
    return const_cast<BuilderPanel*>(this)->currentSong();
}

void BuilderPanel::loadSongEditor() {
    const SongDef* s = currentSong();
    if (s == nullptr)
        return;
    songNameEdit.setText(s->name, juce::dontSendNotification);
    bpmSlider.setValue(s->bpm, juce::dontSendNotification);
    modeBox.setSelectedId(s->playbackMode == PlaybackMode::AutoplayNext ? 2 : 1, juce::dontSendNotification);
    tsNumSlider.setValue(s->timeSignature.numerator, juce::dontSendNotification);
    tsDenSlider.setValue(s->timeSignature.denominator, juce::dontSendNotification);
    clickToggle.setToggleState(s->builtInClickEnabled, juce::dontSendNotification);
    // click bus
    int id = 1;
    for (const auto& b : engine.project().busses) {
        if (b.id == s->builtInClickBusId) {
            clickBusBox.setSelectedId(id, juce::dontSendNotification);
            break;
        }
        ++id;
    }
}

void BuilderPanel::loadTrackEditor() {
    const SongDef* s = currentSong();
    if (s == nullptr || selectedItemRow < 0 || selectedItemRow >= static_cast<int>(s->tracks.size()))
        return;
    const TrackDef& t = s->tracks[static_cast<size_t>(selectedItemRow)];
    trackNameEdit.setText(t.name.empty() ? t.id : t.name, juce::dontSendNotification);
    trackGainSlider.setValue(t.gainDb, juce::dontSendNotification);
    trackPanSlider.setValue(t.pan, juce::dontSendNotification);
    trackMute.setToggleState(t.mute, juce::dontSendNotification);
    trackSolo.setToggleState(t.solo, juce::dontSendNotification);
    trackFileLabel.setText("File: " + juce::String(t.file), juce::dontSendNotification);
    {
        const PeakOverview* overview = engine.trackPeaksAt(static_cast<size_t>(selectedItemRow));
        const double dur = overview != nullptr ? overview->durationSeconds : 0.0;
        trackTrimEditor.setWaveform(overview, dur);
        trackTrimEditor.setTrim(t.trimStartSeconds, t.trimEndSeconds);
    }
    if (t.busId.empty()) {
        trackBusBox.setSelectedId(kNoBusComboId, juce::dontSendNotification);
    } else {
        int id = 1;
        for (const auto& b : engine.project().busses) {
            if (b.id == t.busId) {
                trackBusBox.setSelectedId(id, juce::dontSendNotification);
                break;
            }
            ++id;
        }
    }
    fillBusCombo(trackSendBusBox);
    juce::String sendsText;
    if (t.sends.empty())
        sendsText = "(no aux sends)";
    else {
        for (size_t i = 0; i < t.sends.size(); ++i) {
            const auto& send = t.sends[i];
            sendsText += juce::String(static_cast<int>(i) + 1) + ". -> " + send.busId + "  "
                         + juce::String(send.gainDb, 1) + " dB"
                         + (send.preFader ? "  pre" : "  post")
                         + (send.enabled ? "" : "  [off]") + "\n";
        }
    }
    trackSendsListLabel.setText(sendsText, juce::dontSendNotification);
}

void BuilderPanel::loadBusEditor() {
    if (selectedItemRow < 0 || selectedItemRow >= static_cast<int>(engine.project().busses.size()))
        return;
    const BusDef& b = engine.project().busses[static_cast<size_t>(selectedItemRow)];
    busNameEdit.setText(b.name.empty() ? b.id : b.name, juce::dontSendNotification);
    busGainSlider.setValue(b.gainDb, juce::dontSendNotification);
    busChBox.setSelectedId(b.channels >= 2 ? 2 : 1, juce::dontSendNotification);
    refreshBusOutBox(); // rebuild for this bus's mono/stereo mode, then select its actual channel
    {
        const int step = b.channels >= 2 ? 2 : 1;
        const int idx = juce::jlimit(0, busOutBox.getNumItems() - 1, b.output.startChannel / step);
        busOutBox.setSelectedItemIndex(idx, juce::dontSendNotification);
    }
    busMute.setToggleState(b.mute, juce::dontSendNotification);
    busSolo.setToggleState(b.solo, juce::dontSendNotification);
    busIsAux.setToggleState(b.isAux, juce::dontSendNotification);
}

void BuilderPanel::loadEventEditor() {
    const SongDef* s = currentSong();
    if (s == nullptr || selectedItemRow < 0 || selectedItemRow >= static_cast<int>(s->events.size()))
        return;
    const TimelineEvent& e = s->events[static_cast<size_t>(selectedItemRow)];
    int typeId = 1;
    if (e.type == EventType::MidiCC) typeId = 2;
    else if (e.type == EventType::MidiNoteOn) typeId = 3;
    else if (e.type == EventType::MidiNoteOff) typeId = 4;
    else if (e.type == EventType::Http) typeId = 5;
    else if (e.type == EventType::Dmx) typeId = 6;
    eventTypeBox.setSelectedId(typeId, juce::dontSendNotification);
    eventTimeSlider.setValue(e.timeSeconds, juce::dontSendNotification);
    eventOnLoad.setToggleState(e.triggerOnLoad, juce::dontSendNotification);
    eventLatencySlider.setValue(e.latencyCompensationMs, juce::dontSendNotification);
    eventMidiChSlider.setValue(e.midiChannel, juce::dontSendNotification);
    if (e.type == EventType::MidiProgramChange)
        eventMidiData1Slider.setValue(e.midiProgram, juce::dontSendNotification);
    else if (e.type == EventType::MidiCC) {
        eventMidiData1Slider.setValue(e.midiCC, juce::dontSendNotification);
        eventMidiData2Slider.setValue(e.midiCCValue, juce::dontSendNotification);
    } else if (e.type == EventType::MidiNoteOn || e.type == EventType::MidiNoteOff) {
        eventMidiData1Slider.setValue(e.midiNote, juce::dontSendNotification);
        eventMidiData2Slider.setValue(e.midiVelocity, juce::dontSendNotification);
    }
    eventHttpUrlEdit.setText(e.httpUrl, juce::dontSendNotification);
}

void BuilderPanel::applySongSettings() {
    SongDef* s = currentSong();
    if (s == nullptr)
        return;
    s->name = songNameEdit.getText().toStdString();
    s->bpm = bpmSlider.getValue();
    s->playbackMode = modeBox.getSelectedId() == 2 ? PlaybackMode::AutoplayNext : PlaybackMode::WaitForTrigger;
    s->timeSignature.numerator = static_cast<int>(tsNumSlider.getValue());
    s->timeSignature.denominator = static_cast<int>(tsDenSlider.getValue());
    s->builtInClickEnabled = clickToggle.getToggleState();
    const int busSel = clickBusBox.getSelectedItemIndex();
    if (busSel >= 0 && busSel < static_cast<int>(engine.project().busses.size()))
        s->builtInClickBusId = engine.project().busses[static_cast<size_t>(busSel)].id;

    list.updateContent();
    // Restage if this is the active song so click/BPM take effect.
    if (onSelectSong && selectedSongRow >= 0)
        onSelectSong(selectedSongRow);
    if (onProjectEdited)
        onProjectEdited();
}

void BuilderPanel::applyTrackSettings() {
    SongDef* s = currentSong();
    if (s == nullptr || selectedItemRow < 0 || selectedItemRow >= static_cast<int>(s->tracks.size()))
        return;
    TrackDef& t = s->tracks[static_cast<size_t>(selectedItemRow)];
    t.name = trackNameEdit.getText().toStdString();
    t.gainDb = trackGainSlider.getValue();
    t.pan = trackPanSlider.getValue();
    t.mute = trackMute.getToggleState();
    t.solo = trackSolo.getToggleState();
    if (trackBusBox.getSelectedId() == kNoBusComboId) {
        t.busId.clear(); // sends-only track, no main/FOH destination
    } else {
        const int busSel = trackBusBox.getSelectedItemIndex();
        if (busSel >= 0 && busSel < static_cast<int>(engine.project().busses.size()))
            t.busId = engine.project().busses[static_cast<size_t>(busSel)].id;
    }

    // These no-op on Project data beyond what was already set above and only
    // push a live routing update if selectedSongRow is the staged song --
    // safe to call unconditionally for any song, staged or not.
    const auto songIdx = static_cast<size_t>(selectedSongRow);
    const auto trackIdx = static_cast<size_t>(selectedItemRow);
    engine.setTrackGainDb(songIdx, trackIdx, t.gainDb);
    engine.setTrackPan(songIdx, trackIdx, t.pan);
    engine.setTrackMute(songIdx, trackIdx, t.mute);
    engine.setTrackSolo(songIdx, trackIdx, t.solo);
    engine.setTrackBusId(songIdx, trackIdx, t.busId);
    list.updateContent();
    if (onRoutingEdited)
        onRoutingEdited();
}

void BuilderPanel::applyBusSettings() {
    if (selectedItemRow < 0 || selectedItemRow >= static_cast<int>(engine.project().busses.size()))
        return;
    BusDef& b = engine.project().busses[static_cast<size_t>(selectedItemRow)];
    b.name = busNameEdit.getText().toStdString();
    b.channels = busChBox.getSelectedId() == 1 ? 1 : 2;
    {
        const int step = b.channels >= 2 ? 2 : 1;
        const int idx = busOutBox.getSelectedItemIndex();
        b.output.startChannel = idx >= 0 ? idx * step : 0;
    }
    b.gainDb = busGainSlider.getValue();
    b.mute = busMute.getToggleState();
    b.solo = busSolo.getToggleState();
    b.isAux = busIsAux.getToggleState();

    engine.setBusGainDb(static_cast<size_t>(selectedItemRow), b.gainDb);
    engine.setBusMute(static_cast<size_t>(selectedItemRow), b.mute);
    engine.setBusSolo(static_cast<size_t>(selectedItemRow), b.solo);
    engine.setBusOutputChannel(static_cast<size_t>(selectedItemRow), b.output.startChannel);
    list.updateContent();
    if (onRoutingEdited)
        onRoutingEdited();
}

void BuilderPanel::applyEventSettings() {
    SongDef* s = currentSong();
    if (s == nullptr || selectedItemRow < 0 || selectedItemRow >= static_cast<int>(s->events.size()))
        return;
    TimelineEvent& e = s->events[static_cast<size_t>(selectedItemRow)];
    switch (eventTypeBox.getSelectedId()) {
        case 2: e.type = EventType::MidiCC; break;
        case 3: e.type = EventType::MidiNoteOn; break;
        case 4: e.type = EventType::MidiNoteOff; break;
        case 5: e.type = EventType::Http; break;
        case 6: e.type = EventType::Dmx; break;
        default: e.type = EventType::MidiProgramChange; break;
    }
    e.timeSeconds = eventTimeSlider.getValue();
    e.triggerOnLoad = eventOnLoad.getToggleState();
    e.latencyCompensationMs = eventLatencySlider.getValue();
    e.midiChannel = static_cast<int>(eventMidiChSlider.getValue());
    if (e.type == EventType::MidiProgramChange)
        e.midiProgram = static_cast<int>(eventMidiData1Slider.getValue());
    else if (e.type == EventType::MidiCC) {
        e.midiCC = static_cast<int>(eventMidiData1Slider.getValue());
        e.midiCCValue = static_cast<int>(eventMidiData2Slider.getValue());
    } else if (e.type == EventType::MidiNoteOn || e.type == EventType::MidiNoteOff) {
        e.midiNote = static_cast<int>(eventMidiData1Slider.getValue());
        e.midiVelocity = static_cast<int>(eventMidiData2Slider.getValue());
    }
    e.httpUrl = eventHttpUrlEdit.getText().toStdString();
    list.updateContent();
    if (onProjectEdited)
        onProjectEdited();
}

void BuilderPanel::importWavClicked() {
    // importWavForTrack() operates directly on Project data for the given
    // song, independent of what's currently staged/playing -- no need to
    // force-stage this song first (that used to be a fragile hack: if
    // staging failed for any reason, or if selectedItemRow was still -1
    // because no track row was selected, the import would either silently
    // do nothing or, worse, write into the wrong track of whatever song
    // happened to be staged).
    if (selectedSongRow < 0 || selectedItemRow < 0) {
        emptyHint.setText("Select a track first, then Import WAV...", juce::dontSendNotification);
        emptyHint.setVisible(true);
        return;
    }

    const size_t songIdx = static_cast<size_t>(selectedSongRow);
    const size_t trackIdx = static_cast<size_t>(selectedItemRow);

    // importWavForTrack() needs an on-disk archive to write the audio into;
    // a brand-new never-saved project doesn't have one yet -- check (and
    // prompt to Save As if needed) BEFORE the file picker, not after, so a
    // failure here can't look like the whole import silently did nothing.
    ensureProjectSaved([this, songIdx, trackIdx] {
        fileChooser = std::make_unique<juce::FileChooser>("Import WAV stem", juce::File(), "*.wav");
        const auto flags = juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles;
        fileChooser->launchAsync(flags, [this, songIdx, trackIdx](const juce::FileChooser& fc) {
            const auto file = fc.getResult();
            if (file == juce::File())
                return;
            // Runs on a background thread inside AudioEngine; onComplete
            // fires back on the message thread. MainComponent's timer shows
            // a blocking spinner for the whole duration (see engine.isBusy()).
            engine.importWavForTrackAsync(songIdx, trackIdx, file.getFullPathName().toStdString(),
                                          [this](bool ok, std::string error) {
                if (!ok) {
                    emptyHint.setText("Import failed: " + juce::String(error), juce::dontSendNotification);
                    emptyHint.setVisible(true);
                    return;
                }
                loadTrackEditor();
                list.updateContent();
                if (onProjectEdited)
                    onProjectEdited();
            });
        });
    });
}

void BuilderPanel::importSongFolderClicked() {
    if (!engine.isProjectLoaded())
        return;

    // Same requirement as importWavForTrack: needs an on-disk archive to
    // write audio into. Check (and prompt to Save As if needed) up front,
    // before the user spends time picking a folder and confirming the
    // tempo/name dialog, only to have the actual import silently fail.
    ensureProjectSaved([this] {
        folderChooser = std::make_unique<juce::FileChooser>(
            "Select a song's stem folder (one .wav per track)", juce::File(), "*");
        const auto flags = juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectDirectories;
        folderChooser->launchAsync(flags, [this](const juce::FileChooser& fc) {
            const auto folder = fc.getResult();
            if (folder == juce::File() || !folder.isDirectory())
                return;
            promptSongFolderImport(folder);
        });
    });
}

void BuilderPanel::ensureProjectSaved(std::function<void()> onReady) {
    if (!engine.projectPath().empty()) {
        onReady();
        return;
    }
    if (!onRequestSaveAs) {
        emptyHint.setText("Save the project first (Save As...) before importing audio.",
                           juce::dontSendNotification);
        emptyHint.setVisible(true);
        return;
    }

    auto options = juce::MessageBoxOptions::makeOptionsOkCancel(
        juce::MessageBoxIconType::InfoIcon,
        "Save project first",
        "This project hasn't been saved yet. Imported audio needs an archive to live in -- "
        "save it now, and the import will continue automatically.",
        "Save As...", "Cancel", this);
    juce::NativeMessageBox::showAsync(options, [this, onReady](int result) {
        if (result != 1)
            return;
        onRequestSaveAs([onReady](bool saved) {
            if (saved)
                onReady();
        });
    });
}

void BuilderPanel::promptSongFolderImport(const juce::File& folder) {
    std::vector<std::string> wavPaths;
    double detectedBpm = 0.0;
    std::string scanError;
    if (!engine.scanFolderForImport(folder.getFullPathName().toStdString(), wavPaths, detectedBpm, scanError)) {
        emptyHint.setText("Import scan failed: " + juce::String(scanError), juce::dontSendNotification);
        emptyHint.setVisible(true);
        return;
    }

    importSongDialog = std::make_unique<juce::AlertWindow>(
        "Import Song From Folder",
        juce::String(static_cast<int>(wavPaths.size())) + " .wav file(s) found in \"" + folder.getFileName()
            + "\". One track per file.",
        juce::MessageBoxIconType::NoIcon);
    importSongDialog->addTextEditor("name", folder.getFileName(), "Song name:");
    importSongDialog->addTextEditor("bpm", juce::String(detectedBpm > 0.0 ? detectedBpm : 120.0, 1),
                                    "Tempo (BPM):");
    importSongDialog->addTextEditor("tsNum", "4", "Time signature numerator:");
    importSongDialog->addTextEditor("tsDen", "4", "Time signature denominator:");
    importSongDialog->addButton("Import", 1, juce::KeyPress(juce::KeyPress::returnKey));
    importSongDialog->addButton("Cancel", 0, juce::KeyPress(juce::KeyPress::escapeKey));

    const juce::String folderPath = folder.getFullPathName();
    importSongDialog->enterModalState(
        true,
        juce::ModalCallbackFunction::create([this, folderPath](int result) {
            if (importSongDialog == nullptr)
                return;
            if (result != 1) {
                importSongDialog.reset();
                return;
            }

            const std::string name = importSongDialog->getTextEditorContents("name").toStdString();
            const double bpm = importSongDialog->getTextEditorContents("bpm").getDoubleValue();
            const int tsNum = importSongDialog->getTextEditorContents("tsNum").getIntValue();
            const int tsDen = importSongDialog->getTextEditorContents("tsDen").getIntValue();
            importSongDialog.reset();

            // Runs on a background thread inside AudioEngine (reading every
            // WAV in the folder + rewriting the archive -- real stem folders
            // are hundreds of MB); onComplete fires back on the message
            // thread. MainComponent's timer shows a blocking spinner for the
            // whole duration (see engine.isBusy()).
            engine.importSongFromFolderAsync(folderPath.toStdString(), name, bpm, tsNum, tsDen,
                                             [this](bool ok, std::string error) {
                if (!ok) {
                    emptyHint.setText("Song import failed: " + juce::String(error), juce::dontSendNotification);
                    emptyHint.setVisible(true);
                    return;
                }
                selectedSongRow = static_cast<int>(engine.project().songs.size()) - 1;
                selectedItemRow = -1;
                refresh();
                if (onProjectEdited)
                    onProjectEdited();
            });
        }),
        false);
}

std::string BuilderPanel::makeUniqueId(const std::string& prefix, const std::vector<std::string>& used) {
    for (int n = 1; n < 10000; ++n) {
        const std::string id = prefix + "_" + std::to_string(n);
        if (std::find(used.begin(), used.end(), id) == used.end())
            return id;
    }
    return prefix + "_x";
}

void BuilderPanel::addItem() {
    if (!engine.isProjectLoaded())
        return;
    Project& proj = engine.project();

    switch (activeList) {
        case ListTarget::Songs: {
            std::vector<std::string> used;
            for (const auto& s : proj.songs)
                used.push_back(s.id);
            SongDef song;
            song.id = makeUniqueId("song", used);
            song.name = "New Song";
            song.bpm = 120.0;
            if (!proj.busses.empty())
                song.builtInClickBusId = proj.busses.front().id;
            proj.songs.push_back(std::move(song));
            selectedSongRow = static_cast<int>(proj.songs.size()) - 1;
            selectedItemRow = selectedSongRow;
            if (onSelectSong)
                onSelectSong(selectedSongRow);
            break;
        }
        case ListTarget::Tracks: {
            SongDef* s = currentSong();
            if (s == nullptr)
                break;
            std::vector<std::string> used;
            for (const auto& t : s->tracks)
                used.push_back(t.id);
            TrackDef track;
            track.id = makeUniqueId("trk", used);
            track.name = "New Track";
            track.file = ""; // no audio yet -- empty is the established "unassigned" convention,
                              // matching StreamingEngine::stageSong's skip-if-empty check. A fake
                              // non-empty path here caused "File not found in archive" failures.
            track.busId = proj.busses.empty() ? "bus_main" : proj.busses.front().id;
            s->tracks.push_back(std::move(track));
            selectedItemRow = static_cast<int>(s->tracks.size()) - 1;
            if (onSelectSong && selectedSongRow >= 0)
                onSelectSong(selectedSongRow);
            break;
        }
        case ListTarget::Events: {
            SongDef* s = currentSong();
            if (s == nullptr)
                break;
            std::vector<std::string> used;
            for (const auto& e : s->events)
                used.push_back(e.id);
            TimelineEvent ev;
            ev.id = makeUniqueId("ev", used);
            ev.type = EventType::MidiProgramChange;
            ev.timeSeconds = 0.0;
            ev.midiChannel = 1;
            ev.midiProgram = 0;
            s->events.push_back(std::move(ev));
            selectedItemRow = static_cast<int>(s->events.size()) - 1;
            break;
        }
        case ListTarget::Busses: {
            std::vector<std::string> used;
            for (const auto& b : proj.busses)
                used.push_back(b.id);
            BusDef bus;
            bus.id = makeUniqueId("bus", used);
            bus.name = "New Bus";
            bus.channels = 2;
            // Name-hint: if user is on busses tab and last bus was aux, default aux.
            bus.isAux = false;
            // Place after last bus's channels if any.
            int nextCh = 0;
            for (const auto& b : proj.busses)
                nextCh = std::max(nextCh, b.output.startChannel + b.channels);
            bus.output.startChannel = nextCh;
            proj.busses.push_back(std::move(bus));
            selectedItemRow = static_cast<int>(proj.busses.size()) - 1;
            // Rebuild engine bus list requires reload path — republish after
            // save/reload is ideal; for live session, re-open via project edit hook.
            if (onProjectEdited)
                onProjectEdited();
            break;
        }
    }
    refresh();
    if (onProjectEdited)
        onProjectEdited();
}

void BuilderPanel::removeItem() {
    if (!engine.isProjectLoaded() || selectedItemRow < 0)
        return;
    Project& proj = engine.project();

    switch (activeList) {
        case ListTarget::Songs: {
            if (selectedItemRow >= static_cast<int>(proj.songs.size()))
                return;
            proj.songs.erase(proj.songs.begin() + selectedItemRow);
            selectedSongRow = std::min(selectedItemRow, static_cast<int>(proj.songs.size()) - 1);
            selectedItemRow = selectedSongRow;
            if (selectedSongRow >= 0 && onSelectSong)
                onSelectSong(selectedSongRow);
            break;
        }
        case ListTarget::Tracks: {
            SongDef* s = currentSong();
            if (s == nullptr || selectedItemRow >= static_cast<int>(s->tracks.size()))
                return;
            s->tracks.erase(s->tracks.begin() + selectedItemRow);
            selectedItemRow = std::min(selectedItemRow, static_cast<int>(s->tracks.size()) - 1);
            if (onSelectSong && selectedSongRow >= 0)
                onSelectSong(selectedSongRow);
            break;
        }
        case ListTarget::Events: {
            SongDef* s = currentSong();
            if (s == nullptr || selectedItemRow >= static_cast<int>(s->events.size()))
                return;
            s->events.erase(s->events.begin() + selectedItemRow);
            selectedItemRow = std::min(selectedItemRow, static_cast<int>(s->events.size()) - 1);
            break;
        }
        case ListTarget::Busses: {
            if (selectedItemRow >= static_cast<int>(proj.busses.size()) || proj.busses.size() <= 1)
                return; // keep at least one bus
            const std::string removedId = proj.busses[static_cast<size_t>(selectedItemRow)].id;
            proj.busses.erase(proj.busses.begin() + selectedItemRow);
            // Retarget tracks that pointed at the removed bus.
            const std::string fallback = proj.busses.front().id;
            for (auto& song : proj.songs)
                for (auto& tr : song.tracks)
                    if (tr.busId == removedId)
                        tr.busId = fallback;
            selectedItemRow = std::min(selectedItemRow, static_cast<int>(proj.busses.size()) - 1);
            break;
        }
    }
    refresh();
    if (onProjectEdited)
        onProjectEdited();
}

void BuilderPanel::moveItem(int delta) {
    if (!engine.isProjectLoaded() || selectedItemRow < 0)
        return;
    Project& proj = engine.project();
    const int from = selectedItemRow;
    const int to = from + delta;
    if (to < 0)
        return;

    auto swapIn = [&](auto& vec) {
        if (to >= static_cast<int>(vec.size()))
            return false;
        std::swap(vec[static_cast<size_t>(from)], vec[static_cast<size_t>(to)]);
        selectedItemRow = to;
        return true;
    };

    switch (activeList) {
        case ListTarget::Songs:
            if (!swapIn(proj.songs))
                return;
            selectedSongRow = selectedItemRow;
            if (onSelectSong)
                onSelectSong(selectedSongRow);
            break;
        case ListTarget::Tracks: {
            SongDef* s = currentSong();
            if (s == nullptr || !swapIn(s->tracks))
                return;
            if (onSelectSong && selectedSongRow >= 0)
                onSelectSong(selectedSongRow);
            break;
        }
        case ListTarget::Events: {
            SongDef* s = currentSong();
            if (s == nullptr || !swapIn(s->events))
                return;
            break;
        }
        case ListTarget::Busses:
            if (!swapIn(proj.busses))
                return;
            break;
    }
    refresh();
    if (onProjectEdited)
        onProjectEdited();
}

int BuilderPanel::getNumRows() {
    if (!engine.isProjectLoaded())
        return 0;
    switch (activeList) {
        case ListTarget::Songs:
            return static_cast<int>(engine.project().songs.size());
        case ListTarget::Tracks: {
            const SongDef* s = currentSong();
            return s != nullptr ? static_cast<int>(s->tracks.size()) : 0;
        }
        case ListTarget::Events: {
            const SongDef* s = currentSong();
            return s != nullptr ? static_cast<int>(s->events.size()) : 0;
        }
        case ListTarget::Busses:
            return static_cast<int>(engine.project().busses.size());
    }
    return 0;
}

void BuilderPanel::paintListBoxItem(int row, juce::Graphics& g, int w, int h, bool selected) {
    if (selected)
        g.fillAll(ui::panelAlt().brighter(0.12f));
    else if (row % 2)
        g.fillAll(ui::panel().brighter(0.03f));

    g.setColour(ui::text());
    juce::String text = "?";
    int textIndent = 8;

    switch (activeList) {
        case ListTarget::Songs: {
            const auto& songs = engine.project().songs;
            if (row >= 0 && row < static_cast<int>(songs.size())) {
                const auto& s = songs[static_cast<size_t>(row)];
                text = juce::String(row + 1) + ". " + s.name + "  (" + juce::String(s.bpm, 1) + " bpm)";
                if (row == selectedSongRow)
                    text += "  *";
            }
            break;
        }
        case ListTarget::Tracks: {
            const SongDef* s = currentSong();
            if (s != nullptr && row >= 0 && row < static_cast<int>(s->tracks.size())) {
                const auto& t = s->tracks[static_cast<size_t>(row)];
                text = juce::String(t.name.empty() ? t.id : t.name) + "  -> " + juce::String(t.busId)
                       + "  " + juce::String(t.gainDb, 1) + " dB"
                       + (t.mute ? "  [M]" : "");
                g.setColour(ui::trackColorForIndex(row));
                g.fillRoundedRectangle(6.0f, 4.0f, 4.0f, static_cast<float>(h) - 8.0f, 2.0f);
                textIndent = 16;
            }
            break;
        }
        case ListTarget::Events: {
            const SongDef* s = currentSong();
            if (s != nullptr && row >= 0 && row < static_cast<int>(s->events.size())) {
                const auto& e = s->events[static_cast<size_t>(row)];
                text = juce::String(e.timeSeconds, 2) + "s  " + juce::String(e.id)
                       + (e.triggerOnLoad ? "  (load)" : "");
            }
            break;
        }
        case ListTarget::Busses: {
            const auto& buses = engine.project().busses;
            if (row >= 0 && row < static_cast<int>(buses.size())) {
                const auto& b = buses[static_cast<size_t>(row)];
                text = juce::String(b.name.empty() ? b.id : b.name) + "  ch "
                       + juce::String(b.output.startChannel)
                       + (b.channels > 1 ? "-" + juce::String(b.output.startChannel + b.channels - 1) : juce::String())
                       + "  " + juce::String(b.gainDb, 1) + " dB"
                       + (b.isAux ? "  [AUX]" : "");
            }
            break;
        }
    }

    g.setColour(ui::text());

    g.drawText(text, textIndent, 0, w - textIndent - 8, h, juce::Justification::centredLeft);
}

void BuilderPanel::selectedRowsChanged(int last) {
    if (last < 0)
        return;
    selectedItemRow = last;

    if (activeList == ListTarget::Songs) {
        selectedSongRow = last;
        if (onSelectSong)
            onSelectSong(last);
        loadSongEditor();
    } else if (activeList == ListTarget::Tracks) {
        loadTrackEditor();
    } else if (activeList == ListTarget::Events) {
        loadEventEditor();
    } else if (activeList == ListTarget::Busses) {
        loadBusEditor();
    }
    list.repaint();
}

} // namespace resoset
