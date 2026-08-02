#include "MainComponent.h"
#include "platform/MacKeyMonitor.h"
#include "platform/MacMenuBar.h"
#include "platform/MacTouchBar.h"
#include "ui/UiColors.h"
#include "web/BuilderJson.h"
#include "timing/BarSeek.h"
#include "project/ProjectJson.h"
#include "lighting/LightOutputResolver.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <optional>
#include <vector>

namespace resostage {

MainComponent::MainComponent() {
    // Rig-wide preferences (hotkeys, MIDI bindings, device setup) load once
    // here, before anything below needs them -- see AppSettings.h for why
    // these live outside the project file.
    appSettings = loadAppSettings();

    engine.initialiseDefaultDevices(0, 2);
    {
        auto setup = engine.deviceManager().getAudioDeviceSetup();
        // Saved device/channel preference wins; otherwise prefer 48 kHz for
        // stage playback (matches project schema default and most concert
        // audio interfaces). Fall back silently if the device rejects it.
        if (!appSettings.outputDeviceName.empty()) {
            setup.outputDeviceName = appSettings.outputDeviceName;
            setup.useDefaultOutputChannels = appSettings.activeOutputChannels.empty();
        }
        setup.sampleRate = appSettings.sampleRate > 0.0 ? appSettings.sampleRate : 48000.0;
        if (appSettings.bufferSize > 0)
            setup.bufferSize = appSettings.bufferSize;
        if (!appSettings.activeOutputChannels.empty()) {
            juce::BigInteger bits;
            for (int idx : appSettings.activeOutputChannels)
                bits.setBit(idx);
            setup.outputChannels = bits;
            setup.useDefaultOutputChannels = false;
        }
        (void)engine.setAudioDeviceSetup(setup, true);
    }

    alarmBanner.setJustificationType(juce::Justification::centred);
    alarmBanner.setFont(juce::Font(juce::FontOptions(14.0f, juce::Font::bold)));
    alarmBanner.setColour(juce::Label::textColourId, juce::Colours::white);
    alarmBanner.setColour(juce::Label::backgroundColourId, ui::alarm());
    alarmBanner.setText("AUDIO DEVICE DISCONNECTED -- fell back to default output",
                        juce::dontSendNotification);
    alarmBanner.setVisible(false);
    addChildComponent(alarmBanner);

    midiInput.onAction = [this](const std::string& action) {
        juce::MessageManager::callAsync([this, action] { performAction(action); });
    };
    midiInput.onRawMessage = [this](MidiTriggerType type, int channel, int number) {
        juce::MessageManager::callAsync([this, type, channel, number] {
            handleMidiLearnMessage(type, channel, number);
        });
    };

    // Restore saved MIDI in/out/virtual-port preference (best-effort -- a
    // footswitch that isn't plugged in yet just means these stay closed
    // until the user picks something in Settings).
    if (!appSettings.midiOutputName.empty()) {
        std::string err;
        (void)engine.midi().openDestination(appSettings.midiOutputName, err);
    }
    if (!appSettings.midiInputName.empty()) {
        std::string err;
        (void)midiInput.openSource(appSettings.midiInputName, err);
    }
    if (appSettings.virtualMidiPortEnabled) {
        std::string err;
        (void)engine.midi().enableVirtualSource(err);
    }

    addChildComponent(busyOverlay);
    webLoadingOverlay.startLoading();

    // Start with a real, empty, editable project rather than a "load
    // something first" placeholder -- SPA Builder is immediately usable.
    engine.newProject();
    applyGlobalBindings();
    onProjectLoaded();

    std::string webError;
    if (webServer.start(kWebPort, webError)) {
        setStatus("Ready | Remote UI http://<this-mac>:" + juce::String(kWebPort) + "/");
    } else {
        setStatus("Web server failed: " + juce::String(webError));
    }

    // SelectSong / Play / etc. used to wait for the 30 Hz timer (up to ~33 ms).
    // Wake the message thread immediately so hops feel instant.
    // Do NOT publishWebState here — full multi-view JSON rebuild is heavy and
    // was still on the hop critical path; the 30 Hz timer publishes soon after.
    webServer.setUrgentCommandHook([this] {
        juce::MessageManager::callAsync([this] { drainWebCommands(); });
    });

    // Prefer Vite dev server (:2900) when running; fall back to embedded assets.
    webView = std::make_unique<DevOrEmbeddedWebView>(
        "http://localhost:" + juce::String(kWebPort) + "/");
    webView->onPageLoaded = [this] {
        webLoadingOverlay.dismiss();
    };
    addAndMakeVisible(*webView);
    addAndMakeVisible(webLoadingOverlay);

    setWantsKeyboardFocus(true);
    setSize(1280, 800);

#if JUCE_MAC
    installMacKeyMonitor([this](const juce::KeyPress& key, uint16_t vk, int jm) -> bool {
        return matchAndPerformAction(key, vk, jm);
    });
#endif

    // Match WebServer::kTelemetryHz (30).
    startTimerHz(WebServer::kTelemetryHz);
}

MainComponent::~MainComponent() {
    stopTimer();
#if JUCE_MAC
    uninstallMacKeyMonitor();
#endif
    webServer.stop();
}

void MainComponent::paint(juce::Graphics& g) {
    g.fillAll(juce::Colours::black);
}

void MainComponent::resized() {
    auto r = getLocalBounds();
    if (alarmBanner.isVisible())
        alarmBanner.setBounds(r.removeFromTop(28));
    else
        alarmBanner.setBounds({});
    if (webView != nullptr)
        webView->setBounds(r);
    busyOverlay.setBounds(getLocalBounds());
    webLoadingOverlay.setBounds(getLocalBounds());
}

bool MainComponent::keyPressed(const juce::KeyPress& key) {
    return matchAndPerformAction(key);
}

bool MainComponent::matchAndPerformAction(const juce::KeyPress& key,
                                           uint16_t macKeyCode,
                                           int juceMods) {
    // When the SPA has an editable field focused, let keystrokes pass through
    // for normal typing rather than treating them as hotkeys.
    if (editableFieldFocused.load(std::memory_order_relaxed))
        return false;

    // Digit keys 1-9 select songs directly (0-indexed).
    {
        const auto kc = key.getKeyCode();
        if (kc >= '1' && kc <= '9') {
            goToSong(static_cast<int>(kc - '1'));
            return true;
        }
    }

    // Pass 1: standard character+modifier comparison (works for most keys
    // on all layouts -- space, escape, brackets, function keys, etc.).
    for (const auto& [action, description] : keyBindings) {
        if (key == juce::KeyPress::createFromDescription(juce::String(description))) {
            performAction(action);
            return true;
        }
    }
    // Also check extraKeyBindings (multi-key actions e.g. "0" for stop).
    for (const auto& [action, description] : extraKeyBindings) {
        if (key == juce::KeyPress::createFromDescription(juce::String(description))) {
            performAction(action);
            return true;
        }
    }
    // Pass 2: physical Mac keyCode comparison (cross-layout support).
    // Only triggered when called from the Mac NSEvent monitor
    // (macKeyCode != 0). Matches letter-key bindings by virtual keyCode
    // instead of character, so e.g. Cmd+Z on German QWERTZ (where
    // kVK_ANSI_Z = 6 produces 'y') still triggers undo.
    if (macKeyCode != 0) {
        for (const auto& [action, description] : keyBindings) {
            auto [expectedVk, expectedMods] = descriptionToMacKeyCode(description);
            if (expectedVk != 0
                && expectedVk == macKeyCode
                && expectedMods == juceMods)
            {
                performAction(action);
                return true;
            }
        }
        for (const auto& [action, description] : extraKeyBindings) {
            auto [expectedVk, expectedMods] = descriptionToMacKeyCode(description);
            if (expectedVk != 0
                && expectedVk == macKeyCode
                && expectedMods == juceMods)
            {
                performAction(action);
                return true;
            }
        }
    }

    return false;
}

// static
std::pair<uint16_t, int> MainComponent::descriptionToMacKeyCode(const std::string& desc) {
    // Parse modifiers
    int mods = 0;
    std::string keyName;
    {
        size_t start = 0;
        for (;;) {
            size_t plus = desc.find('+', start);
            if (plus == std::string::npos) {
                keyName = desc.substr(start);
                break;
            }
            std::string token = desc.substr(start, plus - start);
            // trim
            while (!token.empty() && (token.front() == ' ' || token.front() == '\t'))
                token.erase(token.begin());
            while (!token.empty() && (token.back() == ' ' || token.back() == '\t'))
                token.pop_back();

            for (char& c : token) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            if (token == "cmd" || token == "command")
                mods |= juce::ModifierKeys::commandModifier;
            else if (token == "shift")
                mods |= juce::ModifierKeys::shiftModifier;
            else if (token == "alt" || token == "option")
                mods |= juce::ModifierKeys::altModifier;
            else if (token == "ctrl" || token == "control")
                mods |= juce::ModifierKeys::ctrlModifier;

            start = plus + 1;
        }
        // trim keyName
        while (!keyName.empty() && (keyName.front() == ' ' || keyName.front() == '\t'))
            keyName.erase(keyName.begin());
        while (!keyName.empty() && (keyName.back() == ' ' || keyName.back() == '\t'))
            keyName.pop_back();
    }

    // Map key name to Apple virtual key code. Table covers all ANSI
    // letter keys (fixed physical position across every Apple keyboard)
    // plus common named keys used in default bindings.
    uint16_t vk = 0;
    if (keyName.length() == 1) {
        char c = static_cast<char>(std::tolower(static_cast<unsigned char>(keyName[0])));
        if (c >= 'a' && c <= 'z') {
            // kVK_ANSI_A..kVK_ANSI_Z
            static const uint16_t letterVk[] = {
                0x00, 0x0B, 0x08, 0x02, 0x0E, 0x03, 0x05, 0x04,
                0x22, 0x26, 0x28, 0x25, 0x2E, 0x2D, 0x1F, 0x23,
                0x0C, 0x0F, 0x01, 0x11, 0x20, 0x09, 0x0D, 0x07,
                0x10, 0x06
            }; // a b c d e f g h i j k l m n o p q r s t u v w x y z
            vk = letterVk[c - 'a'];
        } else if (c >= '0' && c <= '9') {
            static const uint16_t digitVk[] = {
                0x1D, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19
            }; // 0 1 2 3 4 5 6 7 8 9
            vk = digitVk[c - '0'];
        } else if (c == '[') vk = 33;
        else if (c == ']') vk = 30;
        else if (c == '-') vk = 27;
        else if (c == '=') vk = 24;
        else if (c == ';') vk = 41;
        else if (c == '\'') vk = 39;
        else if (c == ',') vk = 43;
        else if (c == '.') vk = 47;
        else if (c == '/') vk = 44;
        else if (c == '`') vk = 50;
        else if (c == '\\') vk = 42;
    } else {
        std::string lower;
        lower.reserve(keyName.size());
        for (char c : keyName) lower += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));

        if (lower == "space")                vk = 49;
        else if (lower == "escape" || lower == "esc") vk = 53;
        else if (lower == "f1")              vk = 122;
        else if (lower == "f2")              vk = 120;
        else if (lower == "f3")              vk = 99;
        else if (lower == "f4")              vk = 118;
        else if (lower == "f5")              vk = 96;
        else if (lower == "f6")              vk = 97;
        else if (lower == "f7")              vk = 98;
        else if (lower == "f8")              vk = 100;
        else if (lower == "f9")              vk = 101;
        else if (lower == "f10")             vk = 109;
        else if (lower == "f11")             vk = 103;
        else if (lower == "f12")             vk = 111;
        else if (lower == "end")             vk = 119;
        else if (lower == "home")            vk = 115;
        else if (lower == "pageup" || lower == "pgup") vk = 116;
        else if (lower == "pagedown" || lower == "pgdn") vk = 121;
        else if (lower == "left")            vk = 123;
        else if (lower == "right")           vk = 124;
        else if (lower == "down")            vk = 125;
        else if (lower == "up")              vk = 126;
        else if (lower == "return" || lower == "enter") vk = 36;
        else if (lower == "tab")             vk = 48;
        else if (lower == "backspace" || lower == "delete") vk = 51;
        else if (lower == "forwarddelete")   vk = 117; // Fn+Delete / ForwardDelete
    }

    return {vk, mods};
}

void MainComponent::setTouchBarPeer(void* nsViewPeer) {
    touchBarPeer = nsViewPeer;
    touchBarActiveTab.clear(); // force next sync to paint
    lastSeenSpaView.clear();
    // Prefer live SPA view if already reported; else leave unhighlighted until
    // the first {"view":...} (do NOT force "player" — that stuck the highlight).
    const std::string v = webServer.lastClientView();
    if (!v.empty())
        syncTouchBarToTab(v);
}

void MainComponent::syncTouchBarToTab(const std::string& tabId) {
    if (touchBarPeer == nullptr)
        return;
    std::string id = tabId;
    if (id == "builder")
        id = "editor";
    if (id != "player" && id != "mixer" && id != "editor" && id != "settings")
        return;
    if (id == touchBarActiveTab)
        return;
    touchBarActiveTab = id;
#if JUCE_MAC
    setMacTouchBarActiveTab(touchBarPeer, id);
#endif
}

void MainComponent::handleTouchBarTab(const std::string& tabId) {
    if (tabId == "player" || tabId == "mixer" || tabId == "editor" || tabId == "settings"
        || tabId == "builder") {
        const std::string id = tabId == "builder" ? "editor" : tabId;
        lastSeenSpaView = id;
        syncTouchBarToTab(id);
        webServer.noteClientView(id);
        requestUiTab(id);
    }
}

void MainComponent::requestUiTab(const std::string& tab) {
    uiTabRequest = tab;
    ++uiTabSeq;
    std::string id = tab;
    if (id == "builder")
        id = "editor";
    lastSeenSpaView = id;
    webServer.noteClientView(id);
    syncTouchBarToTab(id);
}

void MainComponent::performAction(const std::string& action) {
    // Covers native hotkey, MIDI, and menu bar dispatch alike (see field
    // doc comment) -- publishWebState() mirrors this into WebUiState so
    // SettingsScreen can flash the one binding row that actually fired.
    lastAction_ = action;
    ++lastActionNonce_;
#if JUCE_MAC
    flashMacMenuAction(action);
#endif

    if (action == "play")
        togglePlayback();
    else if (action == "stop")
        engine.stop();
    else if (action == "stop_to_start")
        engine.stopToStart();
    else if (action == "next")
        nextSong();
    else if (action == "prev")
        prevSong();
    else if (action == "mode_player")
        requestUiTab("player");
    else if (action == "mode_mixer")
        requestUiTab("mixer");
    else if (action == "mode_editor")
        requestUiTab("editor");
    else if (action == "mode_settings")
        requestUiTab("settings");
    else if (action == "section_prev")
        jumpToSectionRelative(-1);
    else if (action == "section_next")
        jumpToSectionRelative(+1);
    else if (action == "section_last")
        jumpToLastSection();
    else if (action == "bar_prev")
        jumpToBarRelative(-1);
    else if (action == "bar_next")
        jumpToBarRelative(+1);
    else if (action == "undo")
        performTimelineUndo();
    else if (action == "redo")
        performTimelineRedo();
    else if (action == "new_project")
        newProjectClicked();
    else if (action == "open_project")
        loadProjectClicked();
    else if (action == "save_project")
        saveProjectClicked(false);
    else if (action == "save_project_as")
        saveProjectClicked(true);
    else if (action == "import_song_folder")
        importSongFolderNative();
    else if (action == "clear_recent_projects") {
        appSettings.recentProjects.clear();
        saveAppSettingsToDisk();
        syncMacMenuRecentProjects();
    }
    else if (action.rfind("open_recent:", 0) == 0) {
        const std::string path = action.substr(std::string("open_recent:").size());
        if (!loadProjectFromPath(juce::File(path))) {
            // Stale entry -- the file moved/was deleted since it was recorded.
            removeRecentProject(appSettings.recentProjects, path);
            saveAppSettingsToDisk();
            syncMacMenuRecentProjects();
        }
    }
}

void MainComponent::jumpToSectionRelative(int delta) {
    if (!engine.isProjectLoaded() || delta == 0)
        return;
    const Project& proj = engine.project();
    const size_t songIdx = engine.currentSongIndex();
    if (songIdx >= proj.songs.size())
        return;
    const auto& sections = proj.songs[songIdx].sections;
    if (sections.empty())
        return;

    // Sorted copy by start time -- markers aren't required to be authored
    // in order, and "prev/next" only make sense along the timeline.
    std::vector<const SongSection*> ordered;
    ordered.reserve(sections.size());
    for (const auto& s : sections)
        ordered.push_back(&s);
    std::sort(ordered.begin(), ordered.end(),
              [](const SongSection* a, const SongSection* b) {
                  return a->startSeconds < b->startSeconds;
              });

    const double playhead = engine.transport().playheadSeconds.load(std::memory_order_relaxed);
    // Small epsilon so landing exactly on a marker still counts as "at" it
    // (prev then jumps to the previous one rather than re-seeking here).
    constexpr double kEps = 0.05;

    int at = -1;
    for (int i = 0; i < static_cast<int>(ordered.size()); ++i) {
        if (playhead + kEps >= ordered[static_cast<size_t>(i)]->startSeconds)
            at = i;
    }

    int target = at + delta;
    if (delta < 0 && at < 0)
        target = 0; // before first marker: prev snaps to the first
    if (target < 0 || target >= static_cast<int>(ordered.size()))
        return;

    std::string error;
    if (!engine.seekToSeconds(ordered[static_cast<size_t>(target)]->startSeconds, error))
        setStatus("Section seek failed: " + juce::String(error));
    else
        setStatus("Section: " + juce::String(ordered[static_cast<size_t>(target)]->name));
}

void MainComponent::jumpToLastSection() {
    if (!engine.isProjectLoaded())
        return;
    const Project& proj = engine.project();
    const size_t songIdx = engine.currentSongIndex();
    if (songIdx >= proj.songs.size())
        return;
    const auto& sections = proj.songs[songIdx].sections;
    if (sections.empty())
        return;

    const SongSection* last = &sections.front();
    for (const auto& s : sections) {
        if (s.startSeconds >= last->startSeconds)
            last = &s;
    }
    std::string error;
    if (!engine.seekToSeconds(last->startSeconds, error))
        setStatus("Section seek failed: " + juce::String(error));
    else
        setStatus("Section: " + juce::String(last->name));
}

void MainComponent::jumpToBarRelative(int direction) {
    if (!engine.isProjectLoaded() || direction == 0)
        return;
    const Project& proj = engine.project();
    const size_t songIdx = engine.currentSongIndex();
    if (songIdx >= proj.songs.size())
        return;
    const SongDef& song = proj.songs[songIdx];

    const double playhead = engine.transport().playheadSeconds.load(std::memory_order_relaxed);
    const double target = barSeekTargetSeconds(playhead, song.bpm, song.timeSignature.numerator, direction);

    std::string error;
    if (!engine.seekToSeconds(target, error))
        setStatus("Bar seek failed: " + juce::String(error));
}

void MainComponent::rememberRecentProject(const juce::File& file) {
    // Don't record the invisible draft archive under Application Support --
    // it's an implementation detail auto-created for every fresh project,
    // not something the user chose to open/save.
    if (engine.isDraftProject())
        return;

    RecentProjectEntry entry;
    entry.path = file.getFullPathName().toStdString();
    entry.displayName = engine.project().name.empty()
        ? file.getFileNameWithoutExtension().toStdString()
        : engine.project().name;
    entry.lastOpenedIso = juce::Time::getCurrentTime().toISO8601(true).toStdString();

    touchRecentProject(appSettings.recentProjects, std::move(entry));
    saveAppSettingsToDisk();
    syncMacMenuRecentProjects();
}

void MainComponent::syncMacMenuRecentProjects() {
#if JUCE_MAC
    std::vector<std::pair<std::string, std::string>> recents;
    recents.reserve(appSettings.recentProjects.size());
    for (const auto& rp : appSettings.recentProjects)
        recents.emplace_back(rp.path, rp.displayName);
    updateMacMenuRecentProjects(recents);
#endif
}

void MainComponent::handleMidiLearnMessage(MidiTriggerType type, int channel1to16, int number) {
    // Web UI learn: one-shot arm for a named action.
    if (midiLearnAction.empty())
        return;
    const std::string action = midiLearnAction;
    midiLearnAction.clear();

    auto& mappings = appSettings.midiMappings;
    MidiMapping* existing = nullptr;
    for (auto& m : mappings) {
        if (m.action == action) {
            existing = &m;
            break;
        }
    }
    if (existing == nullptr) {
        mappings.push_back(MidiMapping{});
        existing = &mappings.back();
        existing->action = action;
    }
    existing->triggerType = type;
    existing->channel = channel1to16;
    existing->number = number;
    applyGlobalBindings();
    saveAppSettingsToDisk();
    setStatus("MIDI learn: " + juce::String(action)
              + " <- ch" + juce::String(channel1to16)
              + (type == MidiTriggerType::ControlChange ? " CC" : " note")
              + juce::String(number));
}

void MainComponent::timerCallback() {
    if (!webLoadingOverlay.isDone()) {
        webLoadingOverlay.tickAnimation();
        webLoadingOverlay.toFront(false);
        if (startupTicks > 90) { // Safety fallback (~3s)
            webLoadingOverlay.dismiss();
        }
    }

    const bool busyNow = engine.isBusy();
    if (busyNow != wasBusyLastTick) {
        busyOverlay.setVisible(busyNow);
        if (busyNow)
            busyOverlay.toFront(false);
        wasBusyLastTick = busyNow;
    }
    if (busyNow) {
        busyOverlay.advanceSpinner(12.0f); // ~30Hz timer -> one full turn in ~1s
        // Still push status/busy so the web UI can show "Saving…" etc.
        drainWebCommands();
        publishWebState();
        return;
    }

    if (alarmBanner.isVisible()) {
        alarmBanner.setVisible(false);
        resized();
    }

    const bool alarm = engine.transport().hardwareAlarm.load(std::memory_order_relaxed);
    if (!wasHardwareAlarm && alarm && startupTicks > 10) {
        setStatus("AUDIO DEVICE DISCONNECTED -- fell back to default output");
    }
    wasHardwareAlarm = alarm;
    if (startupTicks <= 10) ++startupTicks;

    // Gapless AutoplayNext:
    //  1) Audio thread may already have promoted the precache in-callback
    //     (consumeGaplessUiNotify) -- SPA follows via telemetry.
    //  2) Else promote from message thread (consumeGaplessAdvance).
    size_t gaplessNext = 0;
    if (engine.consumeGaplessUiNotify(gaplessNext)) {
        if (gaplessNext < engine.project().songs.size())
            setStatus("Gapless -> " + juce::String(engine.project().songs[gaplessNext].name));
        (void)engine.consumeAutoAdvancePending();
        engine.warmNeighbourSongs();
    } else if (engine.consumeGaplessAdvance(gaplessNext)) {
        std::string error;
        if (engine.switchToSongGapless(gaplessNext, error)) {
            setStatus("Gapless -> " + juce::String(engine.project().songs[gaplessNext].name));
            engine.warmNeighbourSongs();
        } else {
            setStatus("Gapless switch failed: " + juce::String(error));
            engine.stop();
        }
        (void)engine.consumeAutoAdvancePending();
    } else if (engine.consumeAutoAdvancePending()) {
        const size_t next = engine.currentSongIndex() + 1;
        goToSong(static_cast<int>(next));
        engine.play();
    }

    drainWebCommands();
    // Touch Bar highlight follows the embedded SPA — but ONLY when the SPA
    // actually reports a *new* view. Re-applying lastClientView every tick
    // (default "player") was racing Touch Bar / hotkey switches and snapping
    // the highlight back to Player before the SPA had sent its update.
    {
        const std::string spaView = webServer.lastClientView();
        if (!spaView.empty() && (spaView != lastSeenSpaView || touchBarActiveTab.empty())) {
            lastSeenSpaView = spaView;
            syncTouchBarToTab(spaView);
        }
    }


    publishWebState();
    maybePublishPeaks();
    maybePublishAllPeaks();
}

void MainComponent::drainWebCommands() {
    // Drain the whole queue first. Rapid setlist clicks (or Next spam) used
    // to enqueue N SelectSong commands and each did a full stageSong open —
    // hopscotch felt like ~1s of "thinking". Coalesce consecutive song-nav
    // into a single goToSong of the final target.
    std::vector<WebCommand> batch;
    {
        WebCommand cmd;
        while (webServer.pollCommand(cmd))
            batch.push_back(std::move(cmd));
    }
    if (batch.empty())
        return;

    const auto isSongNav = [](WebCommandKind k) {
        return k == WebCommandKind::SelectSong || k == WebCommandKind::Next
               || k == WebCommandKind::Prev;
    };

    auto foldSongNav = [this](const WebCommand* begin, const WebCommand* end) -> int {
        const int count = static_cast<int>(engine.project().songs.size());
        int target = static_cast<int>(engine.currentSongIndex());
        if (target < 0)
            target = 0;
        for (const WebCommand* p = begin; p != end; ++p) {
            if (p->kind == WebCommandKind::SelectSong) {
                target = p->arg;
            } else if (p->kind == WebCommandKind::Next) {
                if (count > 0)
                    target = std::min(count - 1, target + 1);
            } else if (p->kind == WebCommandKind::Prev) {
                target = std::max(0, target - 1);
            }
        }
        if (count > 0)
            target = std::clamp(target, 0, count - 1);
        return target;
    };

    auto dispatchOne = [this](const WebCommand& cmd) {
        const size_t idx = static_cast<size_t>(cmd.arg);
        switch (cmd.kind) {
            case WebCommandKind::Play: engine.play(); break;
            case WebCommandKind::Stop: engine.stop(); break;
            case WebCommandKind::StopToStart: stopToStartClicked(); break;
            case WebCommandKind::Next: nextSong(); break;
            case WebCommandKind::Prev: prevSong(); break;
            case WebCommandKind::SelectSong: goToSong(cmd.arg); break;
            case WebCommandKind::SetTrackGain: {
                engine.projectHistoryBeginEdit("tg" + std::to_string(idx), "Set Track Gain");
                engine.setTrackGainDb(engine.currentSongIndex(), idx, cmd.value);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackPan: {
                engine.projectHistoryBeginEdit("tp" + std::to_string(idx), "Set Track Pan");
                engine.setTrackPan(engine.currentSongIndex(), idx, cmd.value);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackMute: {
                engine.projectHistoryBeginEdit("", "Toggle Track Mute");
                engine.setTrackMute(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackSolo: {
                engine.projectHistoryBeginEdit("", "Toggle Track Solo");
                engine.setTrackSolo(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackMono: {
                engine.projectHistoryBeginEdit("", "Toggle Track Mono");
                engine.setTrackMono(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetBusGain: {
                engine.projectHistoryBeginEdit("bg" + std::to_string(idx), "Set Bus Gain");
                engine.setBusGainDb(idx, cmd.value);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetBusMute: {
                engine.projectHistoryBeginEdit("", "Toggle Bus Mute");
                engine.setBusMute(idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetBusSolo: {
                engine.projectHistoryBeginEdit("", "Toggle Bus Solo");
                engine.setBusSolo(idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetClickSolo: {
                engine.projectHistoryBeginEdit("", "Toggle Click Solo");
                engine.setClickSolo(cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackSend: {
                engine.projectHistoryBeginEdit("", "Set Track Send");
                setTrackSendFromJson(cmd.json);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::RemoveTrackSend: {
                engine.projectHistoryBeginEdit("", "Remove Track Send");
                removeTrackSendFromJson(cmd.json);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetProjectName: setProjectNameFromJson(cmd.json); break;
            case WebCommandKind::NewProject:
                engine.newProject();
                applyGlobalBindings();
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
                std::string error;
                const bool loaded = engine.loadProject(cmd.path, error);
                if (loaded) {
                    applyGlobalBindings();
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
            case WebCommandKind::OpenRecentProject: {
                if (!loadProjectFromPath(juce::File(cmd.path))) {
                    removeRecentProject(appSettings.recentProjects, cmd.path);
                    saveAppSettingsToDisk();
                    syncMacMenuRecentProjects();
                }
                break;
            }
            case WebCommandKind::ClearRecentProjects:
                appSettings.recentProjects.clear();
                saveAppSettingsToDisk();
                syncMacMenuRecentProjects();
                break;
            case WebCommandKind::ExportProjectForDownload: {
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
            case WebCommandKind::BuilderSongAdd: builderSongAdd(cmd.json); break;
            case WebCommandKind::BuilderSongImportFolder: builderSongImportFolder(cmd.json); break;
            case WebCommandKind::BuilderSongRemove: builderSongRemove(cmd.json); break;
            case WebCommandKind::BuilderSongMove: builderSongMove(cmd.json); break;
            case WebCommandKind::BuilderSongUpdate: builderSongUpdate(cmd.json); break;
            case WebCommandKind::BuilderTrackAdd: builderTrackAdd(cmd.json); break;
            case WebCommandKind::BuilderTrackRemove: builderTrackRemove(cmd.json); break;
            case WebCommandKind::BuilderTrackMove: builderTrackMove(cmd.json); break;
            case WebCommandKind::BuilderTrackUpdate: builderTrackUpdate(cmd.json); break;
            case WebCommandKind::BuilderTrackImportWavBegin:
                break;
            case WebCommandKind::BuilderTrackImportWavUpload:
                builderTrackImportWavUpload(cmd.arg, static_cast<int>(cmd.value), cmd.path);
                break;
            case WebCommandKind::BuilderRegionAdd: builderRegionAdd(cmd.json); break;
            case WebCommandKind::BuilderRegionRemove: builderRegionRemove(cmd.json); break;
            case WebCommandKind::BuilderRegionUpdate: builderRegionUpdate(cmd.json); break;
            case WebCommandKind::BuilderBusAdd: builderBusAdd(); break;
            case WebCommandKind::BuilderBusRemove: builderBusRemove(cmd.json); break;
            case WebCommandKind::BuilderBusMove: builderBusMove(cmd.json); break;
            case WebCommandKind::BuilderBusUpdate: builderBusUpdate(cmd.json); break;
            case WebCommandKind::BuilderEventAdd: builderEventAdd(cmd.json); break;
            case WebCommandKind::BuilderEventRemove: builderEventRemove(cmd.json); break;
            case WebCommandKind::BuilderEventMove: builderEventMove(cmd.json); break;
            case WebCommandKind::BuilderEventUpdate: builderEventUpdate(cmd.json); break;
            case WebCommandKind::BuilderSectionAdd: builderSectionAdd(cmd.json); break;
            case WebCommandKind::BuilderSectionRemove: builderSectionRemove(cmd.json); break;
            case WebCommandKind::BuilderSectionUpdate: builderSectionUpdate(cmd.json); break;
            case WebCommandKind::SetLightingConfig: lightingSetConfig(cmd.json); break;
            case WebCommandKind::LightFixtureUpdate: lightingFixtureUpdate(cmd.json); break;
            case WebCommandKind::LightTrackAdd: lightingTrackAdd(cmd.json); break;
            case WebCommandKind::LightTrackRemove: lightingTrackRemove(cmd.json); break;
            case WebCommandKind::LightTrackMove: lightingTrackMove(cmd.json); break;
            case WebCommandKind::LightTrackUpdate: lightingTrackUpdate(cmd.json); break;
            case WebCommandKind::LightCueAdd: lightingCueAdd(cmd.json); break;
            case WebCommandKind::LightCueRemove: lightingCueRemove(cmd.json); break;
            case WebCommandKind::LightCueUpdate: lightingCueUpdate(cmd.json); break;
            case WebCommandKind::TimelineUndo: performTimelineUndo(); break;
            case WebCommandKind::TimelineRedo: performTimelineRedo(); break;
            case WebCommandKind::SetAudioOutputDevice: settingsSetAudioOutputDevice(cmd.json); break;
            case WebCommandKind::SetSampleRate: settingsSetSampleRate(cmd.json); break;
            case WebCommandKind::SetBufferSize: settingsSetBufferSize(cmd.json); break;
            case WebCommandKind::SetMidiOutput: settingsSetMidiOutput(cmd.json); break;
            case WebCommandKind::SetMidiInput: settingsSetMidiInput(cmd.json); break;
            case WebCommandKind::SetMidiVirtualPort: settingsSetMidiVirtualPort(cmd.json); break;
            case WebCommandKind::SetKeybinding: settingsSetKeybinding(cmd.json); break;
            case WebCommandKind::SetOutputChannels: settingsSetOutputChannels(cmd.json); break;
            case WebCommandKind::MidiLearn: settingsMidiLearn(cmd.json); break;
            case WebCommandKind::MidiLearnCancel: settingsMidiLearnCancel(); break;
            case WebCommandKind::MidiClear: settingsMidiClear(cmd.json); break;
            case WebCommandKind::Seek: transportSeek(cmd.json); break;
            case WebCommandKind::QuitDecision: handleQuitDecision(cmd.arg); break;
            case WebCommandKind::UiFocusState:
                editableFieldFocused.store(cmd.json.find("\"focused\":true") != std::string::npos,
                                           std::memory_order_relaxed);
                break;
        }
    };

    for (size_t i = 0; i < batch.size();) {
        if (isSongNav(batch[i].kind)) {
            size_t j = i + 1;
            while (j < batch.size() && isSongNav(batch[j].kind))
                ++j;
            // One stage for the whole hopscotch run (Select/Next/Prev).
            goToSong(foldSongNav(batch.data() + i, batch.data() + j));
            i = j;
            continue;
        }
        dispatchOne(batch[i]);
        ++i;
    }
}

void MainComponent::confirmQuitIfUnsaved(std::function<void(bool)> onDecision) {
    if (!engine.hasUnsavedChanges()) {
        if (onDecision) onDecision(true);
        return;
    }

    // Ask inside the webview (React ConfirmDialog). publishWebState() mirrors
    // awaitingQuitDecision as WebUiState::quitConfirmPending; the answer comes
    // back as WebCommandKind::QuitDecision.
    awaitingQuitDecision = true;
    pendingQuitDecision = std::move(onDecision);
    publishWebState();
}

void MainComponent::handleQuitDecision(int choice) {
    if (!awaitingQuitDecision)
        return;
    awaitingQuitDecision = false;
    auto onDecision = std::move(pendingQuitDecision);
    pendingQuitDecision = nullptr;

    if (choice == 1) { // Save
        saveProjectClicked(engine.isDraftProject(), [this, onDecision](bool ok) {
            if (ok) engine.clearDirty();
            if (onDecision) onDecision(ok);
        });
    } else if (choice == 2) { // Don't Save
        if (onDecision) onDecision(true);
    } else { // Cancel
        if (onDecision) onDecision(false);
    }
}

void MainComponent::checkAndOfferAutosaveRecovery() {
    std::string timestamp;
    if (engine.isProjectLoaded() && engine.hasAutosave(timestamp)) {
        juce::AlertWindow::showAsync(
            juce::MessageBoxOptions()
                .withIconType(juce::MessageBoxIconType::QuestionIcon)
                .withTitle("Auto-Save Recovery")
                .withMessage("An auto-saved version of '" + juce::String(engine.project().name) + "' (" + juce::String(timestamp) + ") was found.\nWould you like to recover the auto-saved version or load the saved file?")

                .withButton("Load Auto-Save")
                .withButton("Load Saved Version")
                .withButton("Discard Auto-Save")
                .withAssociatedComponent(this),
            [this](int choice) {
                // AlertWindow::showAsync maps button X (0-based add order) to
                // (X + 1) % numButtons, not a plain index: "Load Auto-Save"
                // (added 1st) -> 1, "Load Saved Version" (2nd) -> 2,
                // "Discard Auto-Save" (3rd) -> (2+1)%3 -> 0.
                if (choice == 1) { // Load Auto-Save
                    std::string err;
                    if (engine.loadAutosave(err)) {
                        setStatus("Auto-save recovered successfully");
                        onProjectLoaded();
                    } else {
                        setStatus("Failed to load auto-save: " + juce::String(err));
                    }
                } else if (choice == 0) { // Discard Auto-Save
                    engine.clearAutosave();
                }
            }
        );
    }
}




void MainComponent::publishWebState() {
    WebUiState state;
    const auto& transport = engine.transport();
    const auto health = engine.health().sample();

    state.playheadSeconds = transport.playheadSeconds.load(std::memory_order_relaxed);
    state.globalPlayheadSeconds = engine.globalPlayheadSeconds();
    state.globalBeatsElapsed = engine.globalBeatsElapsed();
    state.sampleRate = transport.sampleRate.load(std::memory_order_relaxed);
    state.driftFactor = transport.driftFactor.load(std::memory_order_relaxed);
    state.playing = transport.running.load(std::memory_order_relaxed);
    state.hardwareAlarm = transport.hardwareAlarm.load(std::memory_order_relaxed);

    const Project& proj = engine.project();
    state.projectName = proj.name;
    state.clickGainDb = proj.builtInClickGainDb;
    state.clickPan = proj.builtInClickPan;
    state.clickSolo = proj.builtInClickSolo;
    // Interval max of rendered click peaks since last poll — captures every
    // audible tick even when the impulse is shorter than the UI sample period.
    {
        const MeterFrame clickFrame = engine.consumeClickMeterInterval();
        state.clickPeakDb = clickFrame.peakDb;
        state.clickPeakDbL = clickFrame.peakDbL;
        state.clickPeakDbR = clickFrame.peakDbR;
    }
    {
        const auto bh = engine.streamBufferHealth();
        state.streamBufferMinSec = bh.minBufferedSeconds;
        state.streamBufferAvgSec = bh.avgBufferedSeconds;
        state.streamResidentTracks = bh.residentTracks;
        state.streamStreamingTracks = bh.streamingTracks;
        state.streamBufferUrgent = bh.urgent;
        state.streamResidentMiB =
            static_cast<double>(bh.residentBytes) / (1024.0 * 1024.0);
    }
    state.songCount = static_cast<int>(proj.songs.size());
    state.songIndex = (engine.currentSongIndex() == static_cast<size_t>(-1))
                          ? -1
                          : static_cast<int>(engine.currentSongIndex());
    state.lastAction = lastAction_;
    state.lastActionNonce = lastActionNonce_;
    state.statusMessage = lastStatusMessage;
    state.busy = engine.isBusy();
    state.quitConfirmPending = awaitingQuitDecision;
    state.uiTab = uiTabRequest;
    state.uiTabSeq = uiTabSeq;
    state.canUndo = engine.canUndoTimeline();
    state.canRedo = engine.canRedoTimeline();
    state.undoLabel = engine.undoTimelineLabel();
    state.redoLabel = engine.redoTimelineLabel();
#if JUCE_MAC
    updateMacMenuUndoRedo(state.canUndo, state.canRedo,
                          state.undoLabel, state.redoLabel);
#endif

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
        // Global click level (same for every song row for API convenience).
        row.clickGainDb = proj.builtInClickGainDb;
        for (const TrackSendDef& cs : song.builtInClickSends) {
            WebUiState::SongRow::ClickSendRow csr;
            csr.busId = cs.busId;
            csr.gainDb = cs.gainDb;
            csr.enabled = cs.enabled;
            row.clickSends.push_back(std::move(csr));
        }

        row.regions.reserve(song.regions.size());
        for (const Region& r : song.regions) {
            WebUiState::SongRow::RegionRow rr;
            rr.id = r.id;
            rr.trackId = r.trackId;
            rr.file = r.file;
            rr.startSeconds = r.startSeconds;
            rr.sourceOffsetSeconds = r.sourceOffsetSeconds;
            rr.durationSeconds = r.durationSeconds;
            rr.gainDb = r.gainDb;
            rr.fadeInSeconds = r.fadeInSeconds;
            rr.fadeOutSeconds = r.fadeOutSeconds;
            rr.fadeInCurve = r.fadeInCurve;
            rr.fadeOutCurve = r.fadeOutCurve;
            rr.loop = r.loop;
            row.regions.push_back(std::move(rr));
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

        row.sections.reserve(song.sections.size());
        for (const SongSection& sec : song.sections) {
            WebUiState::SongRow::SectionRow sr;
            sr.id = sec.id;
            sr.name = sec.name;
            sr.startSeconds = sec.startSeconds;
            sr.colorIndex = sec.colorIndex;
            row.sections.push_back(std::move(sr));
        }

        row.lightCues.reserve(song.lightCues.size());
        for (const LightCue& lc : song.lightCues) {
            WebUiState::SongRow::LightCueRow lcr;
            lcr.id = lc.id;
            lcr.trackId = lc.trackId;
            lcr.startSeconds = lc.startSeconds;
            lcr.durationSeconds = lc.durationSeconds;
            lcr.colorR = lc.colorR;
            lcr.colorG = lc.colorG;
            lcr.colorB = lc.colorB;
            lcr.intensity = lc.intensity;
            lcr.fadeInSeconds = lc.fadeInSeconds;
            lcr.fadeOutSeconds = lc.fadeOutSeconds;
            lcr.label = lc.label;
            lcr.effectType = lc.effectType;
            lcr.effectSourceType = lc.effectSourceType;
            lcr.effectSourceId = lc.effectSourceId;
            lcr.effectIntensity = lc.effectIntensity;
            lcr.tempoSync = lc.tempoSync;
            lcr.tempoSubdiv = lc.tempoSubdiv;
            lcr.effectRateHz = lc.effectRateHz;
            lcr.gradientPreset = lc.gradientPreset;
            lcr.gradientColors = lc.gradientColors;
            lcr.blendMode = lc.blendMode;
            row.lightCues.push_back(std::move(lcr));
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
                m.peakDbL = frame.peakDbL;
                m.peakDbR = frame.peakDbR;
                m.shortTermLufs = frame.shortTermLufs;
            }
        }
        state.meters.push_back(std::move(m));
    }

    const auto& projTracks = proj.tracks;

    state.tracks.reserve(projTracks.size());
    for (size_t i = 0; i < projTracks.size(); ++i) {
        const TrackDef& def = projTracks[i];
        WebUiState::TrackRow tr;
        tr.id = def.id;
        tr.name = def.name.empty() ? def.id : def.name;
        tr.busId = def.busId;
        tr.gainDb = def.gainDb;
        tr.pan = def.pan;
        tr.mute = def.mute;
        tr.solo = def.solo;
        tr.mono = def.mono;
        for (const auto& send : def.sends)
            tr.sends.push_back({send.busId, send.gainDb});

        if (const auto* meter = engine.trackMeterAt(i)) {
            MeterFrame frame;
            if (meter->read(frame)) {
                tr.peakDb = frame.peakDb;
                tr.peakDbL = frame.peakDbL;
                tr.peakDbR = frame.peakDbR;
            }
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
            if (meter->read(frame)) {
                br.peakDb = frame.peakDb;
                br.peakDbL = frame.peakDbL;
                br.peakDbR = frame.peakDbR;
            }
        }
        state.busses.push_back(std::move(br));
    }

    state.lighting.enabled = proj.lighting.enabled;
    state.lighting.kind = lightingKindToString(proj.lighting.kind);
    state.lighting.resoLightColumns = proj.lighting.resoLightColumns;
    state.lighting.resoLightRows = proj.lighting.resoLightRows;
    state.lighting.fixtures.reserve(proj.lighting.fixtures.size());
    for (const LightFixture& f : proj.lighting.fixtures) {
        WebUiState::LightFixtureRow fr;
        fr.id = f.id;
        fr.name = f.name;
        fr.kind = lightFixtureKindToString(f.kind);
        fr.gridColumn = f.gridColumn;
        fr.gridRow = f.gridRow;
        fr.ledCount = f.ledCount;
        fr.addressable = f.addressable;
        fr.posX = f.posX;
        fr.posY = f.posY;
        fr.posZ = f.posZ;
        fr.rotationYDeg = f.rotationYDeg;
        fr.mountedHorizontally = f.mountedHorizontally;
        fr.dmxUniverse = f.dmxUniverse;
        fr.dmxStartChannel = f.dmxStartChannel;
        fr.dmxChannelCount = f.dmxChannelCount;
        state.lighting.fixtures.push_back(std::move(fr));
    }

    state.lightTracks.reserve(proj.lightTracks.size());
    for (const LightTrack& lt : proj.lightTracks) {
        WebUiState::LightTrackRow ltr;
        ltr.id = lt.id;
        ltr.name = lt.name;
        ltr.fixtureIds = lt.fixtureIds;
        state.lightTracks.push_back(std::move(ltr));
    }

    // Backend-authoritative resolved lamp state -- the exact same
    // engine/lighting/LightOutputResolver.h call LightEngine's real-time DMX
    // thread makes, so the live preview can never drift from what the real
    // hardware is doing (see RESTORE_POINT.md Feature 6's sync fix).
    if (proj.lighting.enabled && state.songIndex >= 0
        && static_cast<size_t>(state.songIndex) < proj.songs.size()) {
        const SongDef& activeSong = proj.songs[static_cast<size_t>(state.songIndex)];
        const auto& allTracks = proj.tracks;
        const auto sourceLevelDb = [this, &allTracks, &proj](const std::string& type, const std::string& id) -> float {
            if (type == "track") {
                for (size_t i = 0; i < allTracks.size(); ++i) {
                    if (allTracks[i].id != id)
                        continue;
                    if (const auto* m = engine.trackMeterAt(i)) {
                        MeterFrame f;
                        if (m->read(f))
                            return f.peakDb;
                    }
                    break;
                }
                return -144.0f;
            }
            for (size_t i = 0; i < proj.busses.size(); ++i) {
                if (!id.empty() && proj.busses[i].id != id)
                    continue;
                if (id.empty() && i != 0)
                    continue; // empty id = master mix / first bus
                if (const auto* m = engine.busMeterAt(i)) {
                    MeterFrame f;
                    if (m->read(f))
                        return f.peakDb;
                }
                break;
            }
            return -144.0f;
        };

        // Re-read the live transport position right before resolving light
        // outputs.  The playhead was first sampled at the top of
        // publishWebState() (line ~999), but by the time we reach here the
        // JSON serialisation of all structural state has already run — on a
        // loaded machine that can be several ms.  The LightEngine DMX thread
        // always reads transport.playheadSeconds.load() live, so we must too
        // in order to match its output instead of trailing behind it.
        const double livePlayheadSec =
            transport.playheadSeconds.load(std::memory_order_relaxed);
        const auto resolved = resolveLightOutputs(
            proj.lightTracks, activeSong.lightCues, livePlayheadSec, activeSong.bpm, sourceLevelDb);
        state.lightOutput.reserve(resolved.size());
        for (const auto& r : resolved) {
            WebUiState::LightOutputRow lor;
            lor.fixtureId = r.fixtureId;
            lor.r = r.value.r;
            lor.g = r.value.g;
            lor.b = r.value.b;
            lor.intensity = r.value.intensity;
            lor.meterLevel01 = r.meterLevel01;
            lor.gradientPreset = gradientPresetToString(r.gradient);
            lor.gradientColors = r.gradientColors;
            lor.effectType = effectTypeToString(r.effectType);
            lor.effectTSec = r.effectTSec;
            lor.effectRateHz = r.effectRateHz;
            state.lightOutput.push_back(std::move(lor));
        }
    }

    state.cpuPercent = health.totalCpuPercent;
    state.rssBytes = health.totalRssBytes;
    state.freeBytes = health.systemFreeBytes;
    state.underrunCount = health.underrunCount;
    state.audioCallbackCount = health.audioCallbackCount;
    state.webClientCount = webServer.clientCount();
    state.processes.clear();
    for (const auto& p : health.processes) {
        WebUiState::ProcessEntry pe;
        pe.pid = p.pid;
        pe.name = p.name;
        pe.rssBytes = p.rssBytes;
        pe.cpuPercent = p.cpuPercent;
        state.processes.push_back(std::move(pe));
    }
    engine.health().setWebClientCount(state.webClientCount);

    populateSettingsState(state.settings);

    webServer.publishState(state);
}

void MainComponent::applyGlobalBindings() {
    // Global (Application Support), not per-project -- see AppSettings.h.
    // Backfill missing actions with compiled-in defaults; saved settings win.
    for (const auto& [action, description] : keyBindings)
        appSettings.keybindings.try_emplace(action, description);

    for (const auto& [action, description] : appSettings.keybindings)
        keyBindings[action] = description;
    midiInput.setMappings(appSettings.midiMappings);
#if JUCE_MAC
    updateMacMenuKeyBindings(keyBindings);
#endif
}

void MainComponent::saveAppSettingsToDisk() {
    std::string error;
    if (!saveAppSettings(appSettings, error))
        setStatus("Failed to save settings: " + juce::String(error));
}

void MainComponent::newProjectClicked() {
    auto doNew = [this] {
        engine.newProject();
        applyGlobalBindings();
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
    // NativeMessageBox::showAsync uses ResultCodeMappingMode::plainIndex on
    // all platforms: result == button's 0-based add order, NOT "1 == OK"
    // like AlertWindow's showOkCancelBox. "New Project" was added first
    // (button index 0), "Cancel" second (index 1).
    juce::NativeMessageBox::showAsync(options, [doNew](int result) {
        if (result == 0)
            doNew();
    });
}

bool MainComponent::loadProjectFromPath(const juce::File& file) {
    if (!file.exists())
        return false;

    std::string error;
    if (!engine.loadProject(file.getFullPathName().toStdString(), error)) {
        setStatus("Load failed: " + juce::String(error));
        return false;
    }

    applyGlobalBindings();
    onProjectLoaded();
    setStatus("Loaded '" + juce::String(engine.project().name) + "' | "
              + juce::String(static_cast<int>(engine.project().songs.size())) + " songs | "
              + juce::String(static_cast<int>(engine.busCount())) + " busses");
    rememberRecentProject(file);

    if (!engine.project().songs.empty())
        goToSong(0);

    return true;
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

        applyGlobalBindings();
        onProjectLoaded();
        setStatus("Loaded '" + juce::String(engine.project().name) + "' | "
                  + juce::String(static_cast<int>(engine.project().songs.size())) + " songs | "
                  + juce::String(static_cast<int>(engine.busCount())) + " busses");
        rememberRecentProject(file);

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
        // Always write a .rsnraset path (chooser may return bare name).
        juce::File target = file;
        if (!target.hasFileExtension(".rsnraset"))
            target = target.withFileExtension(".rsnraset");

        // Immediate UI feedback -- heavy archive I/O runs off-thread so the
        // message loop (and web UI) keep painting "Saving…".
        setStatus("Saving " + target.getFileName() + "…");
        publishWebState();

        engine.saveProjectAsync(target.getFullPathName().toStdString(),
            [this, onDone, target, name = target.getFileName()](bool ok, std::string error) {
                if (!ok) {
                    setStatus("Save failed: " + juce::String(error));
                    publishWebState();
                    if (onDone)
                        onDone(false);
                    return;
                }
                setStatus("Saved " + name);
                rememberRecentProject(target);
                publishWebState();
                if (onDone)
                    onDone(true);
            });
    };

    // A draft archive doesn't count as "already has a real save location" --
    // plain "Save" on a never-explicitly-saved project must still ask where,
    // not silently write into the invisible Application Support draft file.
    const bool hasRealSaveLocation = !engine.projectPath().empty() && !engine.isDraftProject();

    if (!saveAs && hasRealSaveLocation) {
        // Overwrite the open project in place (engine.saveProject already
        // uses a temp+".new" swap so the open zip handle is safe).
        doSave(juce::File(engine.projectPath()));
        return;
    }

    fileChooser = std::make_unique<juce::FileChooser>(
        "Save .rsnraset project",
        hasRealSaveLocation ? juce::File(engine.projectPath()) : juce::File(),
        "*.rsnraset");
    // warnAboutOverwriting: OS dialog asks before replacing an existing
    // path; engine then does a safe directory-container replace.
    const auto flags = juce::FileBrowserComponent::saveMode
                       | juce::FileBrowserComponent::canSelectFiles
                       | juce::FileBrowserComponent::warnAboutOverwriting;
    fileChooser->launchAsync(flags, [doSave](const juce::FileChooser& fc) {
        doSave(fc.getResult());
    });
}

void MainComponent::onProjectLoaded() {
    ensureSongSelected();
}

void MainComponent::ensureSongSelected() {
    if (engine.currentSongIndex() != static_cast<size_t>(-1))
        return; // something's already staged -- don't yank the user away from it
    if (engine.project().songs.empty())
        return;
    std::string error;
    (void)engine.selectSong(0, error); // best-effort
}

void MainComponent::goToSong(int index) {
    std::string error;
    if (!engine.selectSong(static_cast<size_t>(index), error)) {
        setStatus("Song select failed: " + juce::String(error));
        return;
    }
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

void MainComponent::stopToStartClicked() {
    engine.stopToStart();
}

void MainComponent::setStatus(const juce::String& text) {
    lastStatusMessage = text.toStdString();
}

void MainComponent::notifyProjectStructureChanged() {
    engine.rebuildBussesFromProject();
    ensureSongSelected();
    setStatus("Project structure updated");
}

void MainComponent::notifyRoutingChanged() {
    // SPA picks up routing from the next telemetry frame.
}

void MainComponent::performTimelineUndo() {
    std::string label;
    if (engine.undoTimelineEdit(label)) {
        notifyProjectStructureChanged(); // sets its own status first; overridden below
        publishWebState();
        setStatus("Undo: " + juce::String(label));
    } else {
        setStatus("Nothing to undo");
    }
}

void MainComponent::performTimelineRedo() {
    std::string label;
    if (engine.redoTimelineEdit(label)) {
        notifyProjectStructureChanged();
        publishWebState();
        setStatus("Redo: " + juce::String(label));
    } else {
        setStatus("Nothing to redo");
    }
}

void MainComponent::importSongFolderNative() {
    if (!engine.isProjectLoaded())
        return;

    auto startPicker = [this] {
        folderChooser = std::make_unique<juce::FileChooser>(
            "Select a song's stem folder (one .wav per track)", juce::File(), "*");
        const auto flags = juce::FileBrowserComponent::openMode
                           | juce::FileBrowserComponent::canSelectDirectories;
        folderChooser->launchAsync(flags, [this](const juce::FileChooser& fc) {
            const auto folder = fc.getResult();
            if (folder == juce::File() || !folder.isDirectory())
                return;

            std::vector<std::string> wavPaths;
            double detectedBpm = 0.0;
            std::string scanError;
            if (!engine.scanFolderForImport(folder.getFullPathName().toStdString(), wavPaths,
                                            detectedBpm, scanError)) {
                setStatus("Import scan failed: " + juce::String(scanError));
                return;
            }

            importSongDialog = std::make_unique<juce::AlertWindow>(
                "Import Song From Folder",
                juce::String(static_cast<int>(wavPaths.size())) + " .wav file(s) found in \""
                    + folder.getFileName() + "\". One track per file.",
                juce::MessageBoxIconType::NoIcon);
            importSongDialog->addTextEditor("name", folder.getFileName(), "Song name:");
            importSongDialog->addTextEditor(
                "bpm", juce::String(detectedBpm > 0.0 ? detectedBpm : 120.0, 1), "Tempo (BPM):");
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
                    const std::string name =
                        importSongDialog->getTextEditorContents("name").toStdString();
                    const double bpm =
                        importSongDialog->getTextEditorContents("bpm").getDoubleValue();
                    const int tsNum =
                        importSongDialog->getTextEditorContents("tsNum").getIntValue();
                    const int tsDen =
                        importSongDialog->getTextEditorContents("tsDen").getIntValue();
                    importSongDialog.reset();

                    setStatus("Importing song folder…");
                    engine.importSongFromFolderAsync(
                        folderPath.toStdString(), name, bpm, tsNum, tsDen,
                        [this](bool ok, std::string error) {
                            if (!ok) {
                                setStatus("Song import failed: " + juce::String(error));
                                return;
                            }
                            notifyProjectStructureChanged();
                            setStatus("Song imported");
                        });
                }),
                false);
        });
    };

    if (!engine.projectPath().empty()) {
        startPicker();
        return;
    }

    // Need an on-disk archive before import can write audio.
    auto options = juce::MessageBoxOptions::makeOptionsOkCancel(
        juce::MessageBoxIconType::InfoIcon,
        "Save project first",
        "This project hasn't been saved yet. Imported audio needs an archive to live in -- "
        "save it now, and the import will continue automatically.",
        "Save As...", "Cancel", this);
    // See newProjectClicked()'s comment: showAsync's result is a plain
    // 0-based button index ("Save As..." = 0, "Cancel" = 1), not "1 == OK".
    juce::NativeMessageBox::showAsync(options, [this, startPicker](int result) {
        if (result != 0)
            return;
        saveProjectClicked(true, [startPicker](bool saved) {
            if (saved)
                startPicker();
        });
    });
}

} // namespace resostage
