#include "ui/PlayerPanel.h"

#include <cmath>

namespace resoset {

PlayerPanel::PlayerPanel(AudioEngine& engineRef) : engine(engineRef), timeline(engineRef) {
    projectLabel.setFont(juce::Font(juce::FontOptions(14.0f, juce::Font::bold)));
    projectLabel.setColour(juce::Label::textColourId, ui::muted());
    projectLabel.setText("No project loaded", juce::dontSendNotification);
    addAndMakeVisible(projectLabel);

    playheadLabel.setFont(juce::Font(juce::FontOptions(44.0f, juce::Font::bold)));
    playheadLabel.setColour(juce::Label::textColourId, ui::text());
    playheadLabel.setJustificationType(juce::Justification::centredLeft);
    playheadLabel.setText("00:00.000", juce::dontSendNotification);
    addAndMakeVisible(playheadLabel);

    // Musical position (bar/beat), derived from the current song's BPM and
    // time signature -- the raw mm:ss playhead above is tempo-agnostic, but
    // a performer on stage thinks in bars, not seconds.
    barBeatLabel.setFont(juce::Font(juce::FontOptions(18.0f, juce::Font::bold)));
    barBeatLabel.setColour(juce::Label::textColourId, ui::accent());
    barBeatLabel.setJustificationType(juce::Justification::centredLeft);
    barBeatLabel.setText("--", juce::dontSendNotification);
    addAndMakeVisible(barBeatLabel);

    songMetaLabel.setColour(juce::Label::textColourId, ui::muted());
    addAndMakeVisible(songMetaLabel);

    healthLabel.setColour(juce::Label::textColourId, ui::muted());
    healthLabel.setFont(juce::Font(juce::FontOptions(12.0f)));
    addAndMakeVisible(healthLabel);

    alarmLabel.setJustificationType(juce::Justification::centred);
    alarmLabel.setFont(juce::Font(juce::FontOptions(16.0f, juce::Font::bold)));
    alarmLabel.setColour(juce::Label::textColourId, juce::Colours::white);
    alarmLabel.setColour(juce::Label::backgroundColourId, ui::alarm());
    alarmLabel.setText("AUDIO DEVICE DISCONNECTED", juce::dontSendNotification);
    alarmLabel.setVisible(false);
    addAndMakeVisible(alarmLabel);

    auto styleBtn = [](juce::TextButton& b, juce::Colour bg, juce::Colour fg) {
        b.setColour(juce::TextButton::buttonColourId, bg);
        b.setColour(juce::TextButton::textColourOffId, fg);
    };
    styleBtn(playButton, ui::play(), juce::Colour(0xff062416));
    styleBtn(stopButton, juce::Colour(0xff3a1820), ui::stop());
    styleBtn(prevButton, ui::panelAlt(), ui::text());
    styleBtn(nextButton, ui::panelAlt(), ui::text());

    playButton.onClick = [this] { if (onPlay) onPlay(); };
    stopButton.onClick = [this] { if (onStop) onStop(); };
    prevButton.onClick = [this] { if (onPrev) onPrev(); };
    nextButton.onClick = [this] { if (onNext) onNext(); };

    addAndMakeVisible(playButton);
    addAndMakeVisible(stopButton);
    addAndMakeVisible(prevButton);
    addAndMakeVisible(nextButton);

    setlist.setRowHeight(40);
    setlist.setColour(juce::ListBox::backgroundColourId, ui::panel());
    setlist.setColour(juce::ListBox::outlineColourId, ui::border());
    addAndMakeVisible(setlist);

    timeline.onSeekRequest = [this](double seconds) {
        std::string error;
        if (!engine.seekToSeconds(seconds, error)) {
            // Non-fatal; transport labels will keep showing the previous position.
            juce::ignoreUnused(error);
        }
        refreshTransport();
        timeline.refreshStructure();
    };
    addAndMakeVisible(timeline);
}

void PlayerPanel::paint(juce::Graphics& g) {
    g.fillAll(ui::bg());

    auto body = getLocalBounds().reduced(12);
    body.removeFromBottom(juce::jmax(160, body.getHeight() * 32 / 100) + 8);

    auto left = body.removeFromLeft(juce::jmax(320, body.getWidth() * 55 / 100));
    g.setColour(ui::panel());
    g.fillRoundedRectangle(left.toFloat(), 12.0f);
    body.removeFromLeft(12);
    g.fillRoundedRectangle(body.toFloat(), 12.0f);

    paintMeters(g);
}

void PlayerPanel::resized() {
    auto bounds = getLocalBounds().reduced(12);

    auto timelineBounds = bounds.removeFromBottom(juce::jmax(160, bounds.getHeight() * 32 / 100));
    timeline.setBounds(timelineBounds);
    bounds.removeFromBottom(8);

    auto left = bounds.removeFromLeft(juce::jmax(320, bounds.getWidth() * 55 / 100)).reduced(16);
    bounds.removeFromLeft(12);
    auto right = bounds.reduced(16);

    projectLabel.setBounds(left.removeFromTop(22));
    left.removeFromTop(4);
    playheadLabel.setBounds(left.removeFromTop(52));
    barBeatLabel.setBounds(left.removeFromTop(24));
    songMetaLabel.setBounds(left.removeFromTop(22));
    left.removeFromTop(6);
    alarmLabel.setBounds(left.removeFromTop(26));
    left.removeFromTop(6);

    auto transport = left.removeFromTop(44);
    const int bw = transport.getWidth() / 4 - 4;
    prevButton.setBounds(transport.removeFromLeft(bw));
    transport.removeFromLeft(4);
    playButton.setBounds(transport.removeFromLeft(bw));
    transport.removeFromLeft(4);
    stopButton.setBounds(transport.removeFromLeft(bw));
    transport.removeFromLeft(4);
    nextButton.setBounds(transport);

    left.removeFromTop(10);
    healthLabel.setBounds(left.removeFromTop(36));
    left.removeFromTop(6);
    meterArea = left;

    setlist.setBounds(right);
}

void PlayerPanel::refreshTransport() {
    const auto& t = engine.transport();
    const double seconds = t.playheadSeconds.load(std::memory_order_relaxed);
    const bool running = t.running.load(std::memory_order_relaxed);
    const double drift = t.driftFactor.load(std::memory_order_relaxed);
    const double length = engine.currentSongLengthSeconds();

    const int mins = static_cast<int>(seconds) / 60;
    const double secs = seconds - mins * 60;
    juce::String ph = juce::String::formatted("%02d:%06.3f", mins, secs);
    if (length > 0.0) {
        const int lm = static_cast<int>(length) / 60;
        const double ls = length - lm * 60;
        ph += juce::String::formatted("  /  %02d:%05.2f", lm, ls);
    }
    playheadLabel.setText(ph, juce::dontSendNotification);

    playButton.setButtonText(running ? "Pause" : "Play");
    playButton.setColour(juce::TextButton::buttonColourId, running ? ui::warn() : ui::play());

    alarmLabel.setVisible(t.hardwareAlarm.load(std::memory_order_relaxed));

    const auto health = engine.health().sample();
    healthLabel.setText(
        juce::String::formatted("CPU %.1f%%   RAM %.0f MB   Underruns %llu   Drift x%.5f   Clients %d",
                                health.processCpuPercent,
                                static_cast<double>(health.processRssBytes) / (1024.0 * 1024.0),
                                static_cast<unsigned long long>(health.underrunCount),
                                drift,
                                health.webClientCount),
        juce::dontSendNotification);

    if (engine.isProjectLoaded() && engine.currentSongIndex() < engine.project().songs.size()) {
        const auto& song = engine.project().songs[engine.currentSongIndex()];
        const char* mode = song.playbackMode == PlaybackMode::AutoplayNext ? "Autoplay next" : "Wait for trigger";
        songMetaLabel.setText(
            juce::String(song.name) + "   |   " + juce::String(song.bpm, 1) + " bpm   |   "
                + juce::String(song.timeSignature.numerator) + "/"
                + juce::String(song.timeSignature.denominator) + "   |   " + mode
                + (running ? "   |   PLAYING" : "   |   STOPPED"),
            juce::dontSendNotification);

        // Musical position relative to THIS song's tempo/time signature, not
        // wall-clock seconds -- e.g. "Bar 12  Beat 3".
        const double bpm = song.bpm > 0.0 ? song.bpm : 120.0;
        const int beatsPerBar = song.timeSignature.numerator > 0 ? song.timeSignature.numerator : 4;
        const double secondsPerBeat = 60.0 / bpm;
        const double totalBeats = seconds / secondsPerBeat;
        const int barIndex = static_cast<int>(std::floor(totalBeats / beatsPerBar)) + 1;
        const int beatInBar = static_cast<int>(std::floor(totalBeats)) % beatsPerBar + 1;
        barBeatLabel.setText(
            "Bar " + juce::String(barIndex) + "  Beat " + juce::String(beatInBar),
            juce::dontSendNotification);
    } else {
        songMetaLabel.setText("--", juce::dontSendNotification);
        barBeatLabel.setText("--", juce::dontSendNotification);
    }

    timeline.refreshPlayhead();
    repaint(meterArea);
}

void PlayerPanel::refreshProject() {
    if (engine.isProjectLoaded())
        projectLabel.setText(juce::String(engine.project().name), juce::dontSendNotification);
    else
        projectLabel.setText("No project loaded", juce::dontSendNotification);

    setlist.updateContent();
    if (engine.currentSongIndex() != static_cast<size_t>(-1))
        setlist.selectRow(static_cast<int>(engine.currentSongIndex()), false);
    timeline.refreshStructure();
    repaint();
}

void PlayerPanel::selectSongRow(int index) {
    setlist.selectRow(index, false);
}

void PlayerPanel::paintMeters(juce::Graphics& g) {
    auto area = meterArea;
    if (area.isEmpty())
        return;

    g.setColour(ui::muted());
    g.setFont(juce::Font(juce::FontOptions(11.0f)));
    g.drawText("BUS METERS", area.removeFromTop(16), juce::Justification::left);

    const int n = static_cast<int>(engine.busCount());
    if (n == 0) {
        g.setColour(ui::muted());
        g.drawText("Load a project to see meters", area, juce::Justification::centredLeft);
        return;
    }

    const int rowH = juce::jmax(22, area.getHeight() / juce::jmax(1, n));
    for (int i = 0; i < n; ++i) {
        auto row = area.removeFromTop(rowH).reduced(0, 2);
        g.setColour(ui::text());
        g.drawText(juce::String(engine.busNameAt(static_cast<size_t>(i))),
                   row.removeFromLeft(100), juce::Justification::centredLeft);

        MeterFrame frame;
        const auto* m = engine.busMeterAt(static_cast<size_t>(i));
        const bool ok = m != nullptr && m->read(frame);
        if (!ok)
            continue;

        const float norm = juce::jlimit(0.0f, 1.0f, (frame.peakDb + 60.0f) / 60.0f);
        auto bar = row.reduced(0, 4);
        g.setColour(ui::meterBg());
        g.fillRoundedRectangle(bar.toFloat(), 3.0f);
        auto fill = bar.removeFromLeft(static_cast<int>(static_cast<float>(bar.getWidth()) * norm));
        juce::Colour c = ui::meter();
        if (frame.peakDb > -3.0f)
            c = ui::alarm();
        else if (frame.peakDb > -9.0f)
            c = ui::warn();
        g.setColour(c);
        g.fillRoundedRectangle(fill.toFloat(), 3.0f);

        g.setColour(ui::muted());
        g.drawText(juce::String(frame.peakDb, 1) + " dB  " + juce::String(frame.shortTermLufs, 1) + " LUFS",
                   row.reduced(6, 0), juce::Justification::centredRight);
    }
}

int PlayerPanel::getNumRows() {
    return static_cast<int>(engine.project().songs.size());
}

void PlayerPanel::paintListBoxItem(int row, juce::Graphics& g, int w, int h, bool selected) {
    const auto& songs = engine.project().songs;
    if (row < 0 || row >= static_cast<int>(songs.size()))
        return;

    if (selected)
        g.fillAll(ui::panelAlt().brighter(0.15f));
    else if (row % 2)
        g.fillAll(ui::panel().brighter(0.03f));

    const auto& song = songs[static_cast<size_t>(row)];
    g.setColour(ui::text());
    g.setFont(juce::Font(juce::FontOptions(15.0f, juce::Font::bold)));
    g.drawText(juce::String(row + 1) + ".  " + song.name, 12, 4, w - 24, h / 2, juce::Justification::centredLeft);

    g.setColour(ui::muted());
    g.setFont(juce::Font(juce::FontOptions(12.0f)));
    const char* mode = song.playbackMode == PlaybackMode::AutoplayNext ? "auto" : "wait";
    g.drawText(juce::String(song.bpm, 1) + " bpm  |  " + mode + "  |  "
                   + juce::String(static_cast<int>(song.tracks.size())) + " tracks  |  "
                   + juce::String(static_cast<int>(song.events.size())) + " events",
               12, h / 2, w - 24, h / 2 - 2, juce::Justification::centredLeft);

    if (static_cast<size_t>(row) == engine.currentSongIndex() && engine.isPlaying()) {
        g.setColour(ui::play());
        g.fillEllipse(static_cast<float>(w - 22), static_cast<float>(h / 2 - 4), 8.0f, 8.0f);
    }
}

void PlayerPanel::selectedRowsChanged(int lastRowSelected) {
    if (lastRowSelected < 0)
        return;
    if (static_cast<size_t>(lastRowSelected) == engine.currentSongIndex())
        return;
    if (onSelectSong)
        onSelectSong(lastRowSelected);
}

} // namespace resoset
