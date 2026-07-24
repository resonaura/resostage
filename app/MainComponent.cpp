#include "MainComponent.h"

#include <algorithm>

namespace resoset {

MainComponent::MainComponent() {
    engine.deviceManager().initialiseWithDefaultDevices(0, 2);

    deviceSelector = std::make_unique<juce::AudioDeviceSelectorComponent>(
        engine.deviceManager(),
        0, 0,     // input channels: not needed for playback-only Milestone 1
        0, 32,    // output channels: allow selecting up to 32 for multi-output routing
        false,    // showMidiInputOptions
        false,    // showMidiOutputSelector
        false,    // showChannelsAsStereoPairs -- false so individual channels are pickable
        true);    // hideAdvancedOptionsWithButton
    addAndMakeVisible(*deviceSelector);

    addAndMakeVisible(loadProjectButton);
    loadProjectButton.onClick = [this] { loadProjectClicked(); };

    addAndMakeVisible(playButton);
    playButton.onClick = [this] { togglePlayback(); };

    addAndMakeVisible(stopButton);
    stopButton.onClick = [this] { engine.stop(); };

    addAndMakeVisible(nextButton);
    nextButton.onClick = [this] { nextSong(); };

    addAndMakeVisible(prevButton);
    prevButton.onClick = [this] { prevSong(); };

    addAndMakeVisible(simulateUnderrunButton);
    simulateUnderrunButton.onClick = [this] { engine.simulateUnderrun(500.0); };

    statusLabel.setJustificationType(juce::Justification::centredLeft);
    statusLabel.setText("No project loaded.", juce::dontSendNotification);
    addAndMakeVisible(statusLabel);

    playheadLabel.setJustificationType(juce::Justification::centredLeft);
    playheadLabel.setFont(juce::Font(juce::FontOptions(24.0f, juce::Font::bold)));
    addAndMakeVisible(playheadLabel);

    songListBox.setRowHeight(24);
    addAndMakeVisible(songListBox);

    setWantsKeyboardFocus(true);
    setSize(900, 700);
    startTimerHz(30);
}

MainComponent::~MainComponent() {
    stopTimer();
}

void MainComponent::resized() {
    auto area = getLocalBounds().reduced(8);

    deviceSelector->setBounds(area.removeFromTop(260));
    area.removeFromTop(8);

    auto controls = area.removeFromTop(32);
    loadProjectButton.setBounds(controls.removeFromLeft(160));
    controls.removeFromLeft(4);
    playButton.setBounds(controls.removeFromLeft(120));
    controls.removeFromLeft(4);
    stopButton.setBounds(controls.removeFromLeft(80));
    controls.removeFromLeft(4);
    prevButton.setBounds(controls.removeFromLeft(120));
    controls.removeFromLeft(4);
    nextButton.setBounds(controls.removeFromLeft(120));
    controls.removeFromLeft(4);
    simulateUnderrunButton.setBounds(controls.removeFromLeft(220));

    area.removeFromTop(8);
    statusLabel.setBounds(area.removeFromTop(24));
    playheadLabel.setBounds(area.removeFromTop(36));
    area.removeFromTop(8);

    auto listArea = area.removeFromLeft(area.getWidth() / 2);
    songListBox.setBounds(listArea);
    area.removeFromLeft(8);
    meterArea = area;
}

void MainComponent::paint(juce::Graphics& g) {
    g.fillAll(juce::Colours::black);
    paintBusMeters(g);
}

void MainComponent::paintBusMeters(juce::Graphics& g) {
    g.setColour(juce::Colours::white);
    g.drawText("Bus meters (peak dB / short-term LUFS)", meterArea.removeFromTop(20), juce::Justification::left);

    const int n = static_cast<int>(engine.busCount());
    if (n == 0)
        return;

    auto area = meterArea;
    const int rowHeight = juce::jmax(20, area.getHeight() / juce::jmax(1, n));

    for (int i = 0; i < n; ++i) {
        auto row = area.removeFromTop(rowHeight).reduced(2);
        const auto* meter = engine.busMeterAt(static_cast<size_t>(i));
        MeterFrame frame;
        const bool ok = meter != nullptr && meter->read(frame);

        auto label = row.removeFromLeft(160);
        g.setColour(juce::Colours::lightgrey);
        g.drawText(juce::String(engine.busIdAt(static_cast<size_t>(i))), label, juce::Justification::left);

        if (!ok)
            continue;

        // Peak bar: map [-60dB, 0dB] onto the row width.
        const float normPeak = juce::jlimit(0.0f, 1.0f, (frame.peakDb + 60.0f) / 60.0f);
        auto bar = row.reduced(0, 4);
        g.setColour(juce::Colours::darkgrey);
        g.fillRect(bar);
        g.setColour(juce::Colours::limegreen);
        g.fillRect(bar.removeFromLeft(static_cast<int>(bar.getWidth() * normPeak)));

        g.setColour(juce::Colours::white);
        juce::String text = juce::String(frame.peakDb, 1) + " dB   " + juce::String(frame.shortTermLufs, 1) + " LUFS";
        g.drawText(text, row.reduced(4, 0), juce::Justification::centredRight);
    }
}

bool MainComponent::keyPressed(const juce::KeyPress& key) {
    if (key == juce::KeyPress::spaceKey) {
        togglePlayback();
        return true;
    }
    if (key.getTextCharacter() == 'n' || key.getTextCharacter() == 'N') {
        nextSong();
        return true;
    }
    if (key.getTextCharacter() == 'p' || key.getTextCharacter() == 'P') {
        prevSong();
        return true;
    }
    return false;
}

void MainComponent::timerCallback() {
    const auto& transport = engine.transport();
    const double seconds = transport.playheadSeconds.load(std::memory_order_relaxed);
    const bool running = transport.running.load(std::memory_order_relaxed);
    const double drift = transport.driftFactor.load(std::memory_order_relaxed);

    const int mins = static_cast<int>(seconds) / 60;
    const double secs = seconds - mins * 60;
    playheadLabel.setText(
        (running ? juce::String("PLAYING  ") : juce::String("STOPPED  ")) +
            juce::String::formatted("%02d:%06.3f   (drift x%.5f)", mins, secs, drift),
        juce::dontSendNotification);

    repaint(meterArea);
}

int MainComponent::getNumRows() {
    return static_cast<int>(engine.project().songs.size());
}

void MainComponent::paintListBoxItem(int rowNumber, juce::Graphics& g, int width, int height, bool rowIsSelected) {
    const auto& songs = engine.project().songs;
    if (rowNumber < 0 || rowNumber >= static_cast<int>(songs.size()))
        return;

    if (rowIsSelected)
        g.fillAll(juce::Colours::darkslateblue);

    g.setColour(juce::Colours::white);
    const auto& song = songs[static_cast<size_t>(rowNumber)];
    juce::String text = juce::String(rowNumber + 1) + ". " + song.name + "   (" + juce::String(song.bpm, 1) + " bpm)";
    g.drawText(text, 4, 0, width - 8, height, juce::Justification::centredLeft);
}

void MainComponent::selectedRowsChanged(int lastRowSelected) {
    if (lastRowSelected < 0)
        return;
    if (static_cast<size_t>(lastRowSelected) == engine.currentSongIndex())
        return;
    goToSong(lastRowSelected);
}

void MainComponent::loadProjectClicked() {
    fileChooser = std::make_unique<juce::FileChooser>(
        "Select a .rsnraset project", juce::File(), "*.rsnraset");

    const auto flags = juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles;

    fileChooser->launchAsync(flags, [this](const juce::FileChooser& fc) {
        const auto file = fc.getResult();
        if (file == juce::File())
            return;

        std::string error;
        if (!engine.loadProject(file.getFullPathName().toStdString(), error)) {
            setStatus("Load failed: " + juce::String(error));
            return;
        }

        songListBox.updateContent();
        setStatus("Loaded '" + juce::String(engine.project().name) + "', " +
                   juce::String(engine.project().songs.size()) + " song(s), " +
                   juce::String(engine.busCount()) + " bus(es).");

        if (!engine.project().songs.empty())
            goToSong(0);
    });
}

void MainComponent::goToSong(int index) {
    std::string error;
    if (!engine.selectSong(static_cast<size_t>(index), error)) {
        setStatus("Song select failed: " + juce::String(error));
        return;
    }
    songListBox.selectRow(index);
    setStatus("Song: " + juce::String(engine.project().songs[static_cast<size_t>(index)].name));
}

void MainComponent::nextSong() {
    const int count = getNumRows();
    if (count == 0)
        return;
    const int next = std::min(count - 1, static_cast<int>(engine.currentSongIndex()) + 1);
    goToSong(next);
}

void MainComponent::prevSong() {
    const int count = getNumRows();
    if (count == 0)
        return;
    const int prev = std::max(0, static_cast<int>(engine.currentSongIndex()) - 1);
    goToSong(prev);
}

void MainComponent::togglePlayback() {
    if (engine.isPlaying())
        engine.stop();
    else
        engine.play();
}

void MainComponent::setStatus(const juce::String& text) {
    statusLabel.setText(text, juce::dontSendNotification);
}

} // namespace resoset
