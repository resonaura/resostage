#include "MainComponent.h"
#include "ui/legacy/UiColors.h"
#include "web/BuilderJson.h"

#include <algorithm>
#include <cstdio>

namespace resoset {

MainComponent::MainComponent()
    : playerPanel(engine),
      mixerPanel(engine),
      builderPanel(engine),
      settingsPanel(engine, midiInput) {
    engine.deviceManager().initialiseWithDefaultDevices(0, 2);

    appTitle.setText("RESOSTAGE", juce::dontSendNotification);
    appTitle.setFont(juce::Font(juce::FontOptions(16.0f, juce::Font::bold)));
    appTitle.setColour(juce::Label::textColourId, ui::accent());
    addAndMakeVisible(appTitle);

    projectTitle.setText("No project", juce::dontSendNotification);
    projectTitle.setColour(juce::Label::textColourId, ui::text());
    projectTitle.setFont(juce::Font(juce::FontOptions(14.0f)));
    addAndMakeVisible(projectTitle);

    newButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
    newButton.setColour(juce::TextButton::textColourOffId, ui::text());
    newButton.onClick = [this] { newProjectClicked(); };
    addAndMakeVisible(newButton);

    loadButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
    loadButton.setColour(juce::TextButton::textColourOffId, ui::text());
    loadButton.onClick = [this] { loadProjectClicked(); };
    addAndMakeVisible(loadButton);

    saveButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
    saveButton.setColour(juce::TextButton::textColourOffId, ui::text());
    saveButton.onClick = [this] { saveProjectClicked(false); };
    addAndMakeVisible(saveButton);

    saveAsButton.setColour(juce::TextButton::buttonColourId, ui::panelAlt());
    saveAsButton.setColour(juce::TextButton::textColourOffId, ui::text());
    saveAsButton.onClick = [this] { saveProjectClicked(true); };
    addAndMakeVisible(saveAsButton);

    styleModeTab(webTab, Mode::Web);
    styleModeTab(playerTab, Mode::Player);
    styleModeTab(mixerTab, Mode::Mixer);
    styleModeTab(builderTab, Mode::Builder);
    styleModeTab(settingsTab, Mode::Settings);
    webTab.setRadioGroupId(7);
    playerTab.setRadioGroupId(7);
    mixerTab.setRadioGroupId(7);
    builderTab.setRadioGroupId(7);
    settingsTab.setRadioGroupId(7);
    webTab.setClickingTogglesState(true);
    playerTab.setClickingTogglesState(true);
    mixerTab.setClickingTogglesState(true);
    builderTab.setClickingTogglesState(true);
    settingsTab.setClickingTogglesState(true);
    webTab.setToggleState(true, juce::dontSendNotification);
    webTab.onClick = [this] { setMode(Mode::Web); };
    playerTab.onClick = [this] { setMode(Mode::Player); };
    mixerTab.onClick = [this] { setMode(Mode::Mixer); };
    builderTab.onClick = [this] { setMode(Mode::Builder); };
    settingsTab.onClick = [this] { setMode(Mode::Settings); };
    addAndMakeVisible(webTab);
    addAndMakeVisible(playerTab);
    addAndMakeVisible(mixerTab);
    addAndMakeVisible(builderTab);
    addAndMakeVisible(settingsTab);

    statusLabel.setColour(juce::Label::textColourId, ui::muted());
    statusLabel.setFont(juce::Font(juce::FontOptions(12.0f)));
    addAndMakeVisible(statusLabel);

    alarmBanner.setJustificationType(juce::Justification::centred);
    alarmBanner.setFont(juce::Font(juce::FontOptions(14.0f, juce::Font::bold)));
    alarmBanner.setColour(juce::Label::textColourId, juce::Colours::white);
    alarmBanner.setColour(juce::Label::backgroundColourId, ui::alarm());
    alarmBanner.setText("AUDIO DEVICE DISCONNECTED -- fell back to default output", juce::dontSendNotification);
    alarmBanner.setVisible(false);
    addAndMakeVisible(alarmBanner);

    // Transport wiring for Player
    playerPanel.onPlay = [this] { togglePlayback(); };
    playerPanel.onStop = [this] { engine.stop(); };
    playerPanel.onNext = [this] { nextSong(); };
    playerPanel.onPrev = [this] { prevSong(); };
    playerPanel.onSelectSong = [this](int i) { goToSong(i); };

    builderPanel.onSelectSong = [this](int i) { goToSong(i); };
    builderPanel.onRequestSaveAs = [this](std::function<void(bool)> onDone) {
        saveProjectClicked(true, std::move(onDone));
    };
    builderPanel.onProjectEdited = [this] {
        engine.rebuildBussesFromProject();
        ensureSongSelected(); // e.g. importing the first song into an empty project
        playerPanel.refreshProject();
        mixerPanel.refreshStructure();
        builderPanel.refresh();
        setStatus("Project structure updated");
    };
    builderPanel.onRoutingEdited = [this] {
        mixerPanel.refreshStructure();
        setStatus("Routing updated");
    };

    settingsPanel.onSimulateUnderrun = [this] { engine.simulateUnderrun(500.0); };
    settingsPanel.onBindingsChanged = [this] { applyProjectBindings(); };

    midiInput.onAction = [this](const std::string& action) {
        juce::MessageManager::callAsync([this, action] { performAction(action); });
    };
    midiInput.onRawMessage = [this](MidiTriggerType type, int channel, int number) {
        juce::MessageManager::callAsync([this, type, channel, number] {
            settingsPanel.handleMidiLearn(type, channel, number);
        });
    };

    addChildComponent(mixerPanel);
    addChildComponent(playerPanel);
    addChildComponent(builderPanel);
    addChildComponent(settingsPanel);
    addChildComponent(busyOverlay);

    // Start with a real, empty, editable project rather than a "load
    // something first" placeholder state -- the Builder is immediately
    // usable to add songs/tracks/busses, and Save As creates the .rsnraset
    // the first time it's needed.
    engine.newProject();

    // Seed engine.project().keybindings with the compiled-in defaults (so
    // SettingsPanel's rebind UI has something real to show) and sync the
    // MIDI mapping table.
    applyProjectBindings();
    settingsPanel.refreshBindings();
    onProjectLoaded();

    std::string webError;
    if (webServer.start(kWebPort, webError)) {
        setStatus("Ready | Remote UI http://<this-mac>:" + juce::String(kWebPort) + "/");
    } else {
        setStatus("Web server failed: " + juce::String(webError));
    }

    // Web UI is the default landing view -- always prefers the Vite dev
    // server (webui/, :2900) when it's running, falls back to the embedded
    // build the line above just started serving otherwise.
    webView = std::make_unique<DevOrEmbeddedWebView>(
        "http://localhost:" + juce::String(kWebPort) + "/");
    addChildComponent(*webView);

    setWantsKeyboardFocus(true);
    setSize(1280, 800);
    setMode(Mode::Web);
    startTimerHz(30);
}

MainComponent::~MainComponent() {
    stopTimer();
    webServer.stop();
}

void MainComponent::styleModeTab(juce::TextButton& b, Mode /*m*/) {
    b.setColour(juce::TextButton::buttonColourId, ui::panel());
    b.setColour(juce::TextButton::buttonOnColourId, ui::accent());
    b.setColour(juce::TextButton::textColourOffId, ui::muted());
    b.setColour(juce::TextButton::textColourOnId, juce::Colours::white);
}

void MainComponent::setMode(Mode m) {
    mode = m;
    const bool isWeb = (m == Mode::Web);
    if (webView != nullptr)
        webView->setVisible(isWeb);
    playerPanel.setVisible(m == Mode::Player);
    mixerPanel.setVisible(m == Mode::Mixer);
    builderPanel.setVisible(m == Mode::Builder);
    settingsPanel.setVisible(m == Mode::Settings);

    const bool showNativeHeader = !isWeb;
    appTitle.setVisible(showNativeHeader);
    projectTitle.setVisible(showNativeHeader);
    newButton.setVisible(showNativeHeader);
    loadButton.setVisible(showNativeHeader);
    saveButton.setVisible(showNativeHeader);
    saveAsButton.setVisible(showNativeHeader);
    webTab.setVisible(showNativeHeader);
    playerTab.setVisible(showNativeHeader);
    mixerTab.setVisible(showNativeHeader);
    builderTab.setVisible(showNativeHeader);
    settingsTab.setVisible(showNativeHeader);
    statusLabel.setVisible(showNativeHeader);

    webTab.setToggleState(isWeb, juce::dontSendNotification);
    playerTab.setToggleState(m == Mode::Player, juce::dontSendNotification);
    mixerTab.setToggleState(m == Mode::Mixer, juce::dontSendNotification);
    builderTab.setToggleState(m == Mode::Builder, juce::dontSendNotification);
    settingsTab.setToggleState(m == Mode::Settings, juce::dontSendNotification);

    if (m == Mode::Mixer)
        mixerPanel.refreshStructure();
    if (m == Mode::Builder)
        builderPanel.refresh();
    if (m == Mode::Player)
        playerPanel.refreshProject();
    if (m == Mode::Settings)
        settingsPanel.refreshMidiLists();

    resized();
    repaint();
    if (isShowing())
        grabKeyboardFocus();
}

void MainComponent::paint(juce::Graphics& g) {
    g.fillAll(ui::bg());
    if (mode == Mode::Web) {
        return;
    }
    // Top bar background
    g.setColour(ui::panel());
    g.fillRect(0, 0, getWidth(), 52);
    g.setColour(ui::border());
    g.drawHorizontalLine(52, 0.0f, static_cast<float>(getWidth()));
    // Bottom status bar
    g.setColour(ui::panel());
    g.fillRect(0, getHeight() - 28, getWidth(), 28);
    g.setColour(ui::border());
    g.drawHorizontalLine(getHeight() - 28, 0.0f, static_cast<float>(getWidth()));
}

void MainComponent::resized() {
    busyOverlay.setBounds(getLocalBounds());

    if (mode == Mode::Web) {
        if (webView != nullptr)
            webView->setBounds(getLocalBounds());
        return;
    }

    auto r = getLocalBounds();

    auto top = r.removeFromTop(52).reduced(10, 8);
    appTitle.setBounds(top.removeFromLeft(120));
    top.removeFromLeft(12);
    saveAsButton.setBounds(top.removeFromRight(90));
    top.removeFromRight(4);
    saveButton.setBounds(top.removeFromRight(64));
    top.removeFromRight(4);
    loadButton.setBounds(top.removeFromRight(72));
    top.removeFromRight(4);
    newButton.setBounds(top.removeFromRight(56));
    top.removeFromRight(8);
    settingsTab.setBounds(top.removeFromRight(84));
    top.removeFromRight(4);
    builderTab.setBounds(top.removeFromRight(84));
    top.removeFromRight(4);
    mixerTab.setBounds(top.removeFromRight(84));
    top.removeFromRight(4);
    playerTab.setBounds(top.removeFromRight(84));
    top.removeFromRight(4);
    webTab.setBounds(top.removeFromRight(84));
    top.removeFromRight(16);
    projectTitle.setBounds(top);

    auto bottom = r.removeFromBottom(28).reduced(10, 4);
    statusLabel.setBounds(bottom);

    if (alarmBanner.isVisible())
        alarmBanner.setBounds(r.removeFromTop(28));
    else
        alarmBanner.setBounds({});

    if (webView != nullptr)
        webView->setBounds(r);
    playerPanel.setBounds(r);
    mixerPanel.setBounds(r);
    builderPanel.setBounds(r);
    settingsPanel.setBounds(r);
}

bool MainComponent::keyPressed(const juce::KeyPress& key) {
    // Global transport bindings work in every mode.
    for (const auto& [action, description] : keyBindings) {
        if (key == juce::KeyPress::createFromDescription(juce::String(description))) {
            performAction(action);
            return true;
        }
    }
    // Quick mode switches
    if (key.getTextCharacter() == '1') { setMode(Mode::Player); return true; }
    if (key.getTextCharacter() == '2') { setMode(Mode::Mixer); return true; }
    if (key.getTextCharacter() == '3') { setMode(Mode::Builder); return true; }
    if (key.getTextCharacter() == '4') { setMode(Mode::Settings); return true; }
    return false;
}

void MainComponent::performAction(const std::string& action) {
    if (action == "play")
        togglePlayback();
    else if (action == "stop")
        engine.stop();
    else if (action == "next")
        nextSong();
    else if (action == "prev")
        prevSong();
}

void MainComponent::timerCallback() {
    const bool busyNow = engine.isBusy();
    if (busyNow != wasBusyLastTick) {
        busyOverlay.setVisible(busyNow);
        if (busyNow)
            busyOverlay.toFront(false);
        wasBusyLastTick = busyNow;
    }
    if (busyNow) {
        busyOverlay.advanceSpinner(12.0f); // ~30Hz timer -> one full turn in ~1s
        return; // nothing underneath should update while blocked/mid-import
    }

    const auto& transport = engine.transport();
    alarmBanner.setVisible(transport.hardwareAlarm.load(std::memory_order_relaxed));

    playerPanel.refreshTransport();
    if (mode == Mode::Mixer)
        mixerPanel.refreshMeters();

    // Gapless AutoplayNext: audio thread freezes at song end and queues the
    // next index; we promote the precached song without a Stop/Play round-trip.
    size_t gaplessNext = 0;
    if (engine.consumeGaplessAdvance(gaplessNext)) {
        std::string error;
        if (engine.switchToSongGapless(gaplessNext, error)) {
            playerPanel.selectSongRow(static_cast<int>(gaplessNext));
            playerPanel.refreshProject();
            mixerPanel.refreshStructure();
            builderPanel.refresh();
            setStatus("Gapless -> " + juce::String(engine.project().songs[gaplessNext].name));
        } else {
            setStatus("Gapless switch failed: " + juce::String(error));
            engine.stop();
        }
        (void)engine.consumeAutoAdvancePending(); // clear legacy flag if set
    } else if (engine.consumeAutoAdvancePending()) {
        // Fallback (e.g. older path): stop/select/play.
        const size_t next = engine.currentSongIndex() + 1;
        goToSong(static_cast<int>(next));
        engine.play();
    }

    drainWebCommands();
    publishWebState();
    maybePublishPeaks();
    maybePublishAllPeaks();
}

void MainComponent::drainWebCommands() {
    WebCommand cmd;
    while (webServer.pollCommand(cmd)) {
        const size_t idx = static_cast<size_t>(cmd.arg);
        switch (cmd.kind) {
            case WebCommandKind::Play: engine.play(); break;
            case WebCommandKind::Stop: engine.stop(); break;
            case WebCommandKind::Next: nextSong(); break;
            case WebCommandKind::Prev: prevSong(); break;
            case WebCommandKind::SelectSong: goToSong(cmd.arg); break;
            // Mixer parity commands -- same calls MixerPanel/MixerStrip make
            // natively, just routed from the web client instead of a mouse
            // drag. Track commands are always relative to whichever song is
            // currently staged (matching MixerPanel's own convention).
            case WebCommandKind::SetTrackGain:
                engine.setTrackGainDb(engine.currentSongIndex(), idx, cmd.value);
                break;
            case WebCommandKind::SetTrackPan:
                engine.setTrackPan(engine.currentSongIndex(), idx, cmd.value);
                break;
            case WebCommandKind::SetTrackMute:
                engine.setTrackMute(engine.currentSongIndex(), idx, cmd.value != 0.0);
                break;
            case WebCommandKind::SetTrackSolo:
                engine.setTrackSolo(engine.currentSongIndex(), idx, cmd.value != 0.0);
                break;
            case WebCommandKind::SetBusGain:
                engine.setBusGainDb(idx, cmd.value);
                break;
            case WebCommandKind::SetBusMute:
                engine.setBusMute(idx, cmd.value != 0.0);
                break;
            case WebCommandKind::SetBusSolo:
                engine.setBusSolo(idx, cmd.value != 0.0);
                break;
            case WebCommandKind::SetTrackSend: setTrackSendFromJson(cmd.json); break;
            // Project lifecycle parity -- see WebCommandKind's doc comment.
            // New/Load-dialog/Save/Save-As go through the exact same methods
            // the native top-bar buttons call; any native dialog they pop
            // shows in this same on-screen app window, which is correct
            // whether the click originated from the embedded webview or the
            // physical top-bar (same window either way).
            case WebCommandKind::NewProject:
                engine.newProject();
                applyProjectBindings();
                settingsPanel.refreshBindings();
                onProjectLoaded();
                setStatus("New project -- add songs in Builder, then Save As to create the .rsnraset file");
                break;
            case WebCommandKind::OpenLoadDialog:
                loadProjectClicked();
                break;
            case WebCommandKind::SaveProject:
                saveProjectClicked(false);
                break;
            case WebCommandKind::SaveProjectAs:
                saveProjectClicked(true);
                break;
            case WebCommandKind::LoadProjectFromPath: {
                // Plain-browser upload path: bytes already landed in cmd.path
                // (a temp file written by WebServer's upload handler) --
                // load it exactly like a FileChooser result. Unlike WAV
                // import, this temp file IS the working archive from now on
                // (ProjectLoader streams tracks/peaks from it on demand, same
                // as any user-picked .rsnraset) -- must NOT delete it on
                // success, only if the load itself failed and it's dead weight.
                std::string error;
                const bool loaded = engine.loadProject(cmd.path, error);
                if (loaded) {
                    applyProjectBindings();
                    settingsPanel.refreshBindings();
                    onProjectLoaded();
                    setStatus("Loaded '" + juce::String(engine.project().name) + "' (uploaded from browser)");
                    if (!engine.project().songs.empty())
                        goToSong(0);
                } else {
                    std::remove(cmd.path.c_str());
                    setStatus("Upload load failed: " + juce::String(error));
                }
                break;
            }
            case WebCommandKind::ExportProjectForDownload: {
                // Plain-browser download path: write the current project to a
                // temp file and hand it to WebServer so a polling GET
                // .../export-status / .../download can pick it up -- avoids
                // blocking the lws service thread on this (message-thread
                // only) save.
                if (!engine.isProjectLoaded()) {
                    webServer.failExport();
                    setStatus("Nothing to export -- no project loaded");
                    break;
                }
                const auto tempFile = juce::File::getSpecialLocation(juce::File::tempDirectory)
                                          .getNonexistentChildFile("resostage-export", ".rsnraset");
                std::string error;
                if (engine.saveProject(tempFile.getFullPathName().toStdString(), error)) {
                    juce::String safeName = juce::String(engine.project().name)
                        .retainCharacters("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-");
                    if (safeName.isEmpty())
                        safeName = "Project";
                    webServer.completeExport(tempFile.getFullPathName().toStdString(),
                                             safeName.toStdString() + ".rsnraset");
                    setStatus("Export ready for download");
                } else {
                    webServer.failExport();
                    setStatus("Export failed: " + juce::String(error));
                }
                break;
            }
            // Builder structural-edit parity -- see MainComponentBuilder.cpp.
            case WebCommandKind::BuilderSongAdd: builderSongAdd(cmd.json); break;
            case WebCommandKind::BuilderSongImportFolder: builderPanel.importSongFolderClicked(); break;
            case WebCommandKind::BuilderSongRemove: builderSongRemove(cmd.json); break;
            case WebCommandKind::BuilderSongMove: builderSongMove(cmd.json); break;
            case WebCommandKind::BuilderSongUpdate: builderSongUpdate(cmd.json); break;
            case WebCommandKind::BuilderTrackAdd: builderTrackAdd(cmd.json); break;
            case WebCommandKind::BuilderTrackRemove: builderTrackRemove(cmd.json); break;
            case WebCommandKind::BuilderTrackMove: builderTrackMove(cmd.json); break;
            case WebCommandKind::BuilderTrackUpdate: builderTrackUpdate(cmd.json); break;
            case WebCommandKind::BuilderTrackImportWavBegin:
                break; // bookkeeping only -- see WebServer::beginTrackImport()
            case WebCommandKind::BuilderTrackImportWavUpload:
                builderTrackImportWavUpload(cmd.arg, static_cast<int>(cmd.value), cmd.path);
                break;
            case WebCommandKind::BuilderBusAdd: builderBusAdd(); break;
            case WebCommandKind::BuilderBusRemove: builderBusRemove(cmd.json); break;
            case WebCommandKind::BuilderBusMove: builderBusMove(cmd.json); break;
            case WebCommandKind::BuilderBusUpdate: builderBusUpdate(cmd.json); break;
            case WebCommandKind::BuilderEventAdd: builderEventAdd(cmd.json); break;
            case WebCommandKind::BuilderEventRemove: builderEventRemove(cmd.json); break;
            case WebCommandKind::BuilderEventMove: builderEventMove(cmd.json); break;
            case WebCommandKind::BuilderEventUpdate: builderEventUpdate(cmd.json); break;
            // Settings parity -- see MainComponentSettings.cpp.
            case WebCommandKind::SetAudioOutputDevice: settingsSetAudioOutputDevice(cmd.json); break;
            case WebCommandKind::SetSampleRate: settingsSetSampleRate(cmd.json); break;
            case WebCommandKind::SetBufferSize: settingsSetBufferSize(cmd.json); break;
            case WebCommandKind::SetMidiOutput: settingsSetMidiOutput(cmd.json); break;
            case WebCommandKind::SetMidiInput: settingsSetMidiInput(cmd.json); break;
            case WebCommandKind::SetKeybinding: settingsSetKeybinding(cmd.json); break;
            case WebCommandKind::SetOutputChannels: settingsSetOutputChannels(cmd.json); break;
            // Timeline parity -- see MainComponentTimeline.cpp.
            case WebCommandKind::Seek: transportSeek(cmd.json); break;
        }
    }
}

void MainComponent::publishWebState() {
    WebUiState state;
    const auto& transport = engine.transport();
    const auto health = engine.health().sample();

    state.playheadSeconds = transport.playheadSeconds.load(std::memory_order_relaxed);
    state.sampleRate = transport.sampleRate.load(std::memory_order_relaxed);
    state.driftFactor = transport.driftFactor.load(std::memory_order_relaxed);
    state.playing = transport.running.load(std::memory_order_relaxed);
    state.hardwareAlarm = transport.hardwareAlarm.load(std::memory_order_relaxed);

    const Project& proj = engine.project();
    state.projectName = proj.name;
    state.songCount = static_cast<int>(proj.songs.size());
    state.songIndex = (engine.currentSongIndex() == static_cast<size_t>(-1))
                          ? -1
                          : static_cast<int>(engine.currentSongIndex());
    state.statusMessage = statusLabel.getText().toStdString();
    state.busy = engine.isBusy();

    state.songs.reserve(proj.songs.size());
    for (const SongDef& song : proj.songs) {
        WebUiState::SongRow row;
        row.name = song.name;
        row.bpm = song.bpm;
        row.autoplay = (song.playbackMode == PlaybackMode::AutoplayNext);
        row.tsNum = song.timeSignature.numerator;
        row.tsDen = song.timeSignature.denominator;
        row.click = song.builtInClickEnabled;
        row.clickBusId = song.builtInClickBusId;
        for (const TrackSendDef& cs : song.builtInClickSends) {
            WebUiState::SongRow::ClickSendRow csr;
            csr.busId = cs.busId;
            csr.gainDb = cs.gainDb;
            csr.enabled = cs.enabled;
            row.clickSends.push_back(std::move(csr));
        }

        row.tracks.reserve(song.tracks.size());
        for (const TrackDef& t : song.tracks) {
            WebUiState::SongRow::TrackRow tr;
            tr.id = t.id;
            tr.name = t.name;
            tr.busId = t.busId;
            tr.file = t.file;
            tr.gainDb = t.gainDb;
            tr.pan = t.pan;
            tr.mute = t.mute;
            tr.solo = t.solo;
            tr.sendsCount = static_cast<int>(t.sends.size());
            row.tracks.push_back(std::move(tr));
        }

        row.events.reserve(song.events.size());
        for (const TimelineEvent& e : song.events) {
            WebUiState::SongRow::EventRow er;
            er.id = e.id;
            er.type = builder_json::eventTypeToWebString(e.type);
            er.timeSeconds = e.timeSeconds;
            er.triggerOnLoad = e.triggerOnLoad;
            er.latencyMs = e.latencyCompensationMs;
            er.midiChannel = e.midiChannel;
            er.midiProgram = e.midiProgram;
            er.midiCC = e.midiCC;
            er.midiCCValue = e.midiCCValue;
            er.midiNote = e.midiNote;
            er.midiVelocity = e.midiVelocity;
            er.httpUrl = e.httpUrl;
            row.events.push_back(std::move(er));
        }

        state.songs.push_back(std::move(row));
    }

    if (state.songIndex >= 0 && static_cast<size_t>(state.songIndex) < proj.songs.size()) {
        const SongDef& song = proj.songs[static_cast<size_t>(state.songIndex)];
        state.songName = song.name;
        state.bpm = song.bpm;
    }

    state.meters.reserve(engine.busCount());
    for (size_t i = 0; i < engine.busCount(); ++i) {
        WebUiState::MeterRow m;
        m.id = engine.busIdAt(i);
        if (const auto* meter = engine.busMeterAt(i)) {
            MeterFrame frame;
            if (meter->read(frame)) {
                m.peakDb = frame.peakDb;
                m.shortTermLufs = frame.shortTermLufs;
            }
        }
        state.meters.push_back(std::move(m));
    }

    state.tracks.reserve(engine.trackCount());
    for (size_t i = 0; i < engine.trackCount(); ++i) {
        WebUiState::TrackRow tr;
        tr.id = engine.trackIdAt(i);
        if (const TrackDef* def = engine.trackDefAt(i)) {
            tr.name = def->name.empty() ? def->id : def->name;
            tr.busId = def->busId;
            tr.gainDb = def->gainDb;
            tr.pan = def->pan;
            tr.mute = def->mute;
            tr.solo = def->solo;
            for (const auto& send : def->sends)
                tr.sends.push_back({send.busId, send.gainDb});
        }
        if (const auto* meter = engine.trackMeterAt(i)) {
            MeterFrame frame;
            if (meter->read(frame))
                tr.peakDb = frame.peakDb;
        }
        state.tracks.push_back(std::move(tr));
    }

    state.busses.reserve(engine.busCount());
    for (size_t i = 0; i < engine.busCount(); ++i) {
        WebUiState::BusRow br;
        br.id = engine.busIdAt(i);
        br.name = engine.busNameAt(i);
        br.gainDb = engine.busGainDb(i);
        br.mute = engine.isBusMuted(i);
        br.solo = engine.isBusSoloed(i);
        if (i < proj.busses.size()) {
            br.isAux = proj.busses[i].isAux;
            br.startChannel = proj.busses[i].output.startChannel;
            br.channels = proj.busses[i].channels;
        }
        if (const auto* meter = engine.busMeterAt(i)) {
            MeterFrame frame;
            if (meter->read(frame))
                br.peakDb = frame.peakDb;
        }
        state.busses.push_back(std::move(br));
    }

    state.cpuPercent = health.processCpuPercent;
    state.rssBytes = health.processRssBytes;
    state.freeBytes = health.systemFreeBytes;
    state.underrunCount = health.underrunCount;
    state.audioCallbackCount = health.audioCallbackCount;
    state.webClientCount = webServer.clientCount();
    engine.health().setWebClientCount(state.webClientCount);

    populateSettingsState(state.settings);

    webServer.publishState(state);
}

void MainComponent::applyProjectBindings() {
    // engine.project().keybindings is the single source of truth that
    // SettingsPanel's rebind UI reads/writes directly. Backfill any action
    // missing from it (fresh project, or one saved before a given action
    // existed) with the compiled-in default so the Settings panel never
    // shows "(unbound)" for something that's actually working via fallback.
    for (const auto& [action, description] : keyBindings)
        engine.project().keybindings.try_emplace(action, description);

    for (const auto& [action, description] : engine.project().keybindings)
        keyBindings[action] = description;
    midiInput.setMappings(engine.project().midiMappings);
}

void MainComponent::newProjectClicked() {
    auto doNew = [this] {
        engine.newProject();
        applyProjectBindings();
        settingsPanel.refreshBindings();
        onProjectLoaded();
        setStatus("New project -- add songs in Builder, then Save As to create the .rsnraset file");
    };

    // Not destructive to click accidentally when nothing meaningful has
    // happened yet (no songs, never saved for real) -- skip the confirm nag
    // in that case. A draft archive doesn't count as "saved" here (every
    // fresh project auto-creates one; that's an implementation detail, not
    // something the user did on purpose), only a real user-chosen save
    // location does. Otherwise this discards in-memory edits with no undo,
    // so confirm first (there's no dirty-flag tracking to know precisely
    // what would be lost).
    const bool hasSomethingToLose =
        !engine.project().songs.empty() || (!engine.projectPath().empty() && !engine.isDraftProject());
    if (!hasSomethingToLose) {
        doNew();
        return;
    }

    auto options = juce::MessageBoxOptions::makeOptionsOkCancel(
        juce::MessageBoxIconType::WarningIcon,
        "Start a new project?",
        "This discards the current project's unsaved state in memory (the file on disk, if any, is untouched). Continue?",
        "New Project", "Cancel", this);
    juce::NativeMessageBox::showAsync(options, [doNew](int result) {
        if (result == 1)
            doNew();
    });
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

        applyProjectBindings();
        settingsPanel.refreshBindings();
        onProjectLoaded();
        setStatus("Loaded '" + juce::String(engine.project().name) + "' | "
                  + juce::String(static_cast<int>(engine.project().songs.size())) + " songs | "
                  + juce::String(static_cast<int>(engine.busCount())) + " busses");

        if (!engine.project().songs.empty())
            goToSong(0);
    });
}

void MainComponent::saveProjectClicked(bool saveAs, std::function<void(bool)> onDone) {
    if (!engine.isProjectLoaded()) {
        setStatus("Nothing to save -- load a project first");
        if (onDone)
            onDone(false);
        return;
    }

    auto doSave = [this, onDone](const juce::File& file) {
        if (file == juce::File()) {
            if (onDone)
                onDone(false);
            return;
        }
        std::string error;
        if (!engine.saveProject(file.getFullPathName().toStdString(), error)) {
            setStatus("Save failed: " + juce::String(error));
            if (onDone)
                onDone(false);
            return;
        }
        projectTitle.setText(juce::String(engine.project().name), juce::dontSendNotification);
        playerPanel.refreshProject();
        mixerPanel.refreshStructure();
        builderPanel.refresh();
        setStatus("Saved " + file.getFileName());
        if (onDone)
            onDone(true);
    };

    // A draft archive doesn't count as "already has a real save location" --
    // plain "Save" on a never-explicitly-saved project must still ask where,
    // not silently write into the invisible Application Support draft file.
    const bool hasRealSaveLocation = !engine.projectPath().empty() && !engine.isDraftProject();

    if (!saveAs && hasRealSaveLocation) {
        doSave(juce::File(engine.projectPath()));
        return;
    }

    fileChooser = std::make_unique<juce::FileChooser>(
        "Save .rsnraset project",
        hasRealSaveLocation ? juce::File(engine.projectPath()) : juce::File(),
        "*.rsnraset");
    const auto flags = juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles
                       | juce::FileBrowserComponent::warnAboutOverwriting;
    fileChooser->launchAsync(flags, [doSave](const juce::FileChooser& fc) {
        doSave(fc.getResult());
    });
}

void MainComponent::onProjectLoaded() {
    projectTitle.setText(juce::String(engine.project().name), juce::dontSendNotification);
    ensureSongSelected();
    playerPanel.refreshProject();
    mixerPanel.refreshStructure();
    builderPanel.refresh();
    settingsPanel.refreshMidiLists();
}

void MainComponent::ensureSongSelected() {
    if (engine.currentSongIndex() != static_cast<size_t>(-1))
        return; // something's already staged -- don't yank the user away from it
    if (engine.project().songs.empty())
        return;
    std::string error;
    if (!engine.selectSong(0, error))
        return; // best-effort; UI just stays empty and the user can pick manually
    playerPanel.selectSongRow(0);
}

void MainComponent::goToSong(int index) {
    std::string error;
    if (!engine.selectSong(static_cast<size_t>(index), error)) {
        setStatus("Song select failed: " + juce::String(error));
        return;
    }
    playerPanel.selectSongRow(index);
    playerPanel.refreshProject();
    mixerPanel.refreshStructure();
    builderPanel.refresh();
    if (index >= 0 && index < static_cast<int>(engine.project().songs.size()))
        setStatus("Song: " + juce::String(engine.project().songs[static_cast<size_t>(index)].name));
}

void MainComponent::nextSong() {
    const int count = static_cast<int>(engine.project().songs.size());
    if (count == 0)
        return;
    const int next = std::min(count - 1, static_cast<int>(engine.currentSongIndex()) + 1);
    goToSong(next);
}

void MainComponent::prevSong() {
    const int count = static_cast<int>(engine.project().songs.size());
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
