#include "MainComponent.h"
#include "ActionCatalogue.h"
#include "engine/AudioEngineInternal.h"
#include "lighting/LightOutputResolver.h"
#include "platform/PlatformShellMode.h"
#include "platform/ThermalState.h"
#include "platform/TrayIcon.h"
#include "plugins/PluginPaths.h"
#include "plugins/PluginProcessorBank.h"
#include "project/ProjectJson.h"
#include "project/RouteId.h"
#include "timing/BarSeek.h"
#include "server/BuilderJson.h"
#include "server/WireTypes.h"
#include "BinaryData.h"

#if defined(_WIN32)
#include <windows.h>
#endif

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <vector>

namespace resostage {

MainComponent::MainComponent(std::string ipcSocketPath_, uint16_t webPort, bool enableDiscovery, std::string bindAddress) {
    ipcSocketPath = std::move(ipcSocketPath_);
    webPort_ = webPort;
    bindAddress_ = std::move(bindAddress);

    // IPC server создаётся ДО аудио-setup: Electron ждёт {"type":"ready"},
    // а notifyCoreReady() сработает только после открытия устройства. Сервер
    // слушает в фоновом потоке и сам доставит readiness клиенту, как только
    // тот подключится (возможно, раньше, чем устройство откроется).
    if (!ipcSocketPath.empty()) {
        ipcServer = std::make_unique<IpcServer>();
        if (!ipcServer->start(ipcSocketPath)) {
            std::fprintf(stderr, "[resostage-core] IPC server failed to start on %s\n",
                         ipcSocketPath.c_str());
            ipcServer.reset(); // нефатально: fallback на HTTP polling
        } else {
            std::fprintf(stderr, "[resostage-core] IPC server listening on %s\n",
                         ipcSocketPath.c_str());
            // Handle open-project requests from Electron (file associations).
            ipcServer->onOpenProject([this](const std::string& path) {
                juce::MessageManager::callAsync([this, path] { openProjectFromIpc(path); });
            });
        }
    }

#if JUCE_MAC || JUCE_WINDOWS
    // When spawned by Electron shell, Electron creates and manages the single OS
    // native tray icon. Standalone JUCE process creates its own tray icon here.
    if (std::getenv("RESOSTAGE_SPAWNED_BY_SHELL") == nullptr) {
        TrayCallbacks tray;
        tray.perform = [this](const std::string& action) { performAction(action); };
        tray.isPlaying = [this] { return engine.isPlaying(); };
        tray.currentSongName = [this]() -> std::string {
            if (!engine.isProjectLoaded())
                return {};
            const auto& proj = engine.project();
            const size_t idx = engine.currentSongIndex();
            if (idx >= proj.songs.size())
                return {};
            return proj.songs[idx].name;
        };
        tray.quit = [] { juce::JUCEApplication::getInstance()->systemRequestedQuit(); };
        trayIcon = std::make_unique<TrayIcon>(std::move(tray));
    }
#endif

    // Rig-wide preferences (hotkeys, MIDI bindings, device setup) load once
    // here, before anything below needs them -- see AppSettings.h for why
    // these live outside the project file.
    appSettings = loadAppSettings();
    engine.setCountInBars(appSettings.countInBars);

    engine.initialiseDefaultDevices(2, 2);
    {
        auto setup = engine.deviceManager().getAudioDeviceSetup();
        // Saved device/channel preference wins; otherwise prefer 48 kHz for
        // stage playback (matches project schema default and most concert
        // audio interfaces). Fall back silently if the device rejects it.
        if (!appSettings.outputDeviceName.empty()) {
            setup.outputDeviceName = appSettings.outputDeviceName;
            setup.useDefaultOutputChannels = appSettings.activeOutputChannels.empty();
        }
        if (!appSettings.inputDeviceName.empty()) {
            setup.inputDeviceName = appSettings.inputDeviceName;
            setup.useDefaultInputChannels = appSettings.activeInputChannels.empty();
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
        if (!appSettings.activeInputChannels.empty()) {
            juce::BigInteger bits;
            for (int idx : appSettings.activeInputChannels)
                bits.setBit(idx);
            setup.inputChannels = bits;
            setup.useDefaultInputChannels = false;
        }
        (void)engine.setAudioDeviceSetup(setup, true);
    }

    // The audio device is now open (setAudioDeviceSetup opens synchronously,
    // and audioDeviceAboutToStart has already fired). Signal the Electron shell
    // that the backend is ready for the UI to render.
    notifyCoreReady();

    // Derive the global Direct Output busses from the now-active device
    // output channels (settings-driven, not persisted in any project).
    engine.rebuildDirectOutBusses();

    midiInput.onAction = [this](const std::string& action) {
        juce::MessageManager::callAsync([this, action] { performAction(action); });
    };
    midiInput.onContinuousAction = [this](const std::string& target, float normalizedVal) {
        juce::MessageManager::callAsync([this, target, normalizedVal] {
            performContinuousAction(target, normalizedVal);
        });
    };
    midiInput.onMidiMessageReceived = [this](const uint8_t* data, int length) {
        engine.enqueueIncomingMidi(data, length);
    };
    midiInput.onRawMessage = [this](MidiTriggerType type, int channel, int number, int /*value*/) {
        juce::MessageManager::callAsync([this, type, channel, number] {
            handleMidiLearnMessage(type, channel, number);
        });
    };
    midiInput.onSourcesChanged = [this] {
        juce::MessageManager::callAsync([this] {
            invalidateHardwareSettingsCache();
            publishWebState();
        });
    };

    // MIDI input is opt-in. An empty persisted name means no hardware source.
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

    // Start with a real, empty, editable project rather than a "load
    // something first" placeholder -- SPA is immediately usable.
    engine.newProject();
    applyGlobalBindings();
    onProjectLoaded();

    // publishWebState() normally only runs off the 60 Hz timer started below
    // -- started AFTER webServer.start(), which begins accepting connections
    // immediately. Without this call, a GET landing in that gap (e.g.
    // Electron's very first GET /api/v1/ui/menu on a standalone launch) would
    // see `state.settings` still at its zero-value default -- recentProjects
    // (and everything else populateSettingsState() copies from appSettings)
    // included -- rather than what was just loaded above.
    publishWebState();

    // Serve the SPA from disk instead of a generated header: the packaged
    // bundle's Contents/Resources/web folder (copied in by scripts/lib.mjs
    // embedWebUi at build time), plus ui/dist for dev runs.
    webServer.addWebRoot(juce::File::getCurrentWorkingDirectory()
                             .getChildFile("ui/dist")
                             .getFullPathName()
                             .toStdString());
#if JUCE_WINDOWS
    webServer.addWebRoot(juce::File::getSpecialLocation(juce::File::currentApplicationFile)
                             .getSiblingFile("resources/web")
                             .getFullPathName()
                             .toStdString());
    auto exeDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getParentDirectory();
    for (int i = 0; i < 6; ++i) {
        webServer.addWebRoot(exeDir.getChildFile("ui/dist").getFullPathName().toStdString());
        webServer.addWebRoot(exeDir.getChildFile("build/win/x64/resources/web").getFullPathName().toStdString());
        exeDir = exeDir.getParentDirectory();
    }
#endif
    webServer.addWebRoot(juce::File::getSpecialLocation(juce::File::currentApplicationFile)
                             .getChildFile("Contents/Resources/web")
                             .getFullPathName()
                             .toStdString());

    std::string webError;
    if (webServer.start(webPort_, webError)) {
        // Resolve the primary network IP: first non-loopback, non-link-local
        // IPv4 address reported by JUCE. That is normally the address on the
        // interface the default route uses (Wi-Fi / Ethernet). Falls back to
        // getLocalAddress() if no suitable address is found.
        juce::String localIp;
        const auto addrs = juce::IPAddress::getAllAddresses(false /*IPv4 only*/);
        for (const auto& addr : addrs) {
            // Skip loopback (127.x.x.x) and link-local (169.254.x.x).
            const juce::String s = addr.toString();
            if (s.startsWith("127.")) continue;
            if (s.startsWith("169.254.")) continue;
            localIp = s;
            break;
        }
        if (localIp.isEmpty())
            localIp = juce::IPAddress::getLocalAddress().toString();

        setStatus("Ready | Remote UI http://" + localIp + ":" + juce::String(webPort_) + "/");
    } else {
        setStatus("Web server failed: " + juce::String(webError));
    }

    udpDiscovery.start(webPort_, enableDiscovery, bindAddress);
    webServer.setDiscoveredDevicesProvider([this] {
        return udpDiscovery.getDiscoveredDevices();
    });
    webServer.setDiscoveryStatusProvider([this] {
        return udpDiscovery.isDiscoveryEnabled();
    });
    webServer.setDiscoveryToggleHandler([this](bool enabled) {
        udpDiscovery.setDiscoveryEnabled(enabled, bindAddress_);
    });
    webServer.setPluginCatalogProvider([this] {
        return pluginCatalog.snapshotJson();
    });
    webServer.setPluginParametersProvider([this](const std::string& slotId) {
        wire::WPluginParameterList response;
        response.slotId = slotId;
        // The active bank is atomically held for this read. Isolated-process
        // metadata was published before its host became Ready; no vendor API
        // is called on the HTTP service thread.
        if (engine.hasCurrentPluginProcessorBank()) {
            if (const auto bank = engine.activePluginProcessorBank()) {
                for (const auto& parameter : bank->parametersForSlot(slotId)) {
                    response.parameters.push_back({parameter.index, parameter.name,
                                                   parameter.label,
                                                   parameter.defaultValue,
                                                   parameter.steps});
                }
            }
        }
        std::string json;
        (void)glz::write_json(response, json);
        return json;
    });
    webServer.setLivePeaksProvider([this](const std::string& trackId, size_t level, size_t first, size_t count) {
        return engine.getLiveRecordingPeaks(trackId, level, first, count);
    });
    webServer.setMidiInputHandler([this](const uint8_t* data, int length, int targetTrackIndex) {
        engine.enqueueIncomingMidi(data, length, targetTrackIndex);
    });
    engine.onRecordingFinished = [this] {
        notifyProjectStructureChanged();
        publishWebState();
    };
    // Do this only after the audio device and server are ready: recovery is
    // background work and must never delay the deadline-critical startup path.

    // SelectSong / Play / etc. used to wait for the 30 Hz timer (up to ~33 ms).
    // Wake the message thread immediately so hops feel instant.
    // Do NOT publishWebState here — full multi-view JSON rebuild is heavy and
    // was still on the hop critical path; the 30 Hz timer publishes soon after.
    webServer.setUrgentCommandHook([this] {
        juce::MessageManager::callAsync([this] { drainWebCommands(); });
    });

    // The Core is headless (no DocumentWindow peer -- see Main.cpp): the
    // on-screen UI comes from the engine chosen in Settings -- the Electron
    // shell (window/menu/Touch Bar) or the default browser tab. This process
    // only keeps serving the backend (audio / lighting / WebServer).
    //
    // Exception: the shipped bundle nests this Core.app inside the Electron
    // shell's own .app (Contents/Resources/) and Electron is what the user
    // actually launches -- it spawns THIS process as its backend, setting
    // RESOSTAGE_SPAWNED_BY_SHELL so we don't try to *also* spawn a shell of
    // our own (which would be circular) or pop open a browser tab. This
    // never overrides the flag for standalone/dev launches of this .app.
    const bool spawnedByShell = std::getenv("RESOSTAGE_SPAWNED_BY_SHELL") != nullptr;
    if (spawnedByShell) {
#if JUCE_MAC
        juce::MessageManager::callAsync([] { backOffToHeadlessShell(); });
#endif
    } else if (appSettings.uiRenderEngine == "electron") {
        launchElectronShell();
    } else {
        launchBrowserTab();
    }

    // Match WebServer::kTelemetryHz (60).
    startTimerHz(WebServer::kTelemetryHz);
}

void MainComponent::notifyCoreReady() {
    if (!ipcServer)
        return;
    int sampleRate = 48000;
    int blockSize = 512;
    int64_t latency = 0;
    // getActiveOutputDevice() may be null if audio failed to open -- fall back
    // to sane defaults and rely on the HTTP server for error surfacing.
    if (juce::AudioIODevice* active = engine.deviceManager().getCurrentAudioDevice()) {
        const double sr = active->getCurrentSampleRate();
        if (sr > 0.0)
            sampleRate = static_cast<int>(sr);
        const int bs = active->getCurrentBufferSizeSamples();
        if (bs > 0)
            blockSize = bs;
        latency = engine.outputLatencySamples();
    }
    ipcServer->notifyReady(sampleRate, blockSize, static_cast<int>(latency));
}

MainComponent::~MainComponent() {
    closeAllPluginEditors();
    stopTimer();
    cancelAudioRender.store(true, std::memory_order_release);
    if (audioRenderThread.joinable())
        audioRenderThread.join();
    // In electron mode the shell is our on-screen window -- kill it first so
    // quitting ResoStage never strands a visible shell with no backend.
    terminateElectronShell();
    udpDiscovery.stop();
    webServer.stop();
}

void MainComponent::requestUiTab(const std::string& tab) {
    uiTabRequest = tab;
    ++uiTabSeq;
    std::string id = tab;
    if (id == "builder")
        id = "editor";
    lastSeenSpaView = id;
    webServer.noteClientView(id);
}

void MainComponent::performAction(const std::string& action) {
    // Covers MIDI, the Electron menu bar, and web action POSTs alike (see
    // field doc comment) -- publishWebState() mirrors this into WebUiState so
    // SettingsScreen can flash the one binding row that actually fired.
    lastAction_ = action;
    ++lastActionNonce_;

    if (action == "play")
        togglePlayback();
    else if (action == "record")
        engine.toggleRecording();
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
    else if (action == "mode_light")
        requestUiTab("light");
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
    else if (action == "cancel_save_as") {
        if (pendingSaveAsCallback) {
            auto cb = std::move(pendingSaveAsCallback);
            pendingSaveAsCallback = nullptr;
            if (cb) cb(false);
        }
        publishWebState();
    }
    else if (action == "import_song_folder")
        importSongFolderNative();
    else if (action == "clear_recent_projects") {
        appSettings.recentProjects.clear();
        saveAppSettingsToDisk();
        publishWebState();
    }
    else if (action == "quit") {
        if (auto* app = juce::JUCEApplication::getInstance())
            app->systemRequestedQuit();
    }
    else if (action == "restart_app") {
        // Settings > UI engine change: relaunch the app so the new display
        // framework takes effect. `open -n` forces a fresh instance; the 1s
        // delay lets this instance quit (and flush autosaves) first.
        const juce::File bundle = juce::File::getSpecialLocation(
            juce::File::currentApplicationFile);
        if (bundle.isDirectory()) {
            const juce::String cmd = "sleep 1; /usr/bin/open -n '" + bundle.getFullPathName() + "'";
            juce::ChildProcess spawner;
            spawner.start(cmd); // shell child is orphaned after quit and keeps running
        }
        if (auto* app = juce::JUCEApplication::getInstance())
            app->systemRequestedQuit();
    }
    else if (action.rfind("open_recent:", 0) == 0) {
        const std::string path = action.substr(std::string("open_recent:").size());
        if (!loadProjectFromPath(juce::File(path))) {
            // Stale entry -- the file moved/was deleted since it was recorded.
            removeRecentProject(appSettings.recentProjects, path);
            saveAppSettingsToDisk();
        }
    }
    else if (action.rfind("open_path:", 0) == 0) {
        const std::string path = action.substr(std::string("open_path:").size());
        openProjectFromIpc(path);
    }
    else if (action.rfind("save_as_path:", 0) == 0) {
        const std::string path = action.substr(std::string("save_as_path:").size());
        saveProjectToPath(path);
    }
    else if (action.rfind("import_song_folder_path:", 0) == 0) {
        const std::string path = action.substr(std::string("import_song_folder_path:").size());
        importSongFolderFromPath(path);
    }
}

void MainComponent::performContinuousAction(const std::string& target, float normalizedVal) {
    const float val = std::clamp(normalizedVal, 0.0f, 1.0f);
    if (target.rfind("track_gain:", 0) == 0) {
        try {
            const size_t idx = static_cast<size_t>(std::stoul(target.substr(11)));
            const double gainDb = (val <= 0.001f) ? -100.0 : (val < 0.75f ? -60.0 + (val / 0.75f) * 60.0 : (val - 0.75f) / 0.25f * 6.0);
            engine.setTrackGainDb(engine.currentSongIndex(), idx, gainDb);
        } catch (...) {}
    } else if (target.rfind("track_pan:", 0) == 0) {
        try {
            const size_t idx = static_cast<size_t>(std::stoul(target.substr(10)));
            const double pan = static_cast<double>(val * 2.0f - 1.0f);
            engine.setTrackPan(engine.currentSongIndex(), idx, pan);
        } catch (...) {}
    } else if (target.rfind("track_arm:", 0) == 0) {
        try {
            const size_t idx = static_cast<size_t>(std::stoul(target.substr(10)));
            engine.setTrackRecordArmed(engine.currentSongIndex(), idx, val > 0.5f);
        } catch (...) {}
    } else if (target.rfind("track_monitor:", 0) == 0) {
        try {
            const size_t idx = static_cast<size_t>(std::stoul(target.substr(14)));
            engine.setTrackInputMonitoring(engine.currentSongIndex(), idx, val > 0.5f);
        } catch (...) {}
    } else if (target == "master_gain") {
        const double gainDb = (val <= 0.001f) ? -100.0 : (val < 0.75f ? -60.0 + (val / 0.75f) * 60.0 : (val - 0.75f) / 0.25f * 6.0);
        engine.setBusGainDb(0, gainDb);
    } else if (target == "master_pan") {
        const double pan = static_cast<double>(val * 2.0f - 1.0f);
        engine.setBusPan(0, pan);
    } else if (target.rfind("send_level:", 0) == 0) {
        try {
            const size_t busIdx = static_cast<size_t>(std::stoul(target.substr(11)));
            const double gainDb = (val <= 0.001f) ? -100.0 : (val < 0.75f ? -60.0 + (val / 0.75f) * 60.0 : (val - 0.75f) / 0.25f * 6.0);
            engine.setBusGainDb(busIdx, gainDb);
        } catch (...) {}
    } else if (target.rfind("plugin_param:", 0) == 0) {
        const std::string rest = target.substr(13);
        const auto colon1 = rest.find(':');
        if (colon1 != std::string::npos) {
            const auto colon2 = rest.find(':', colon1 + 1);
            if (colon2 != std::string::npos) {
                try {
                    const size_t stripIdx = static_cast<size_t>(std::stoul(rest.substr(0, colon1)));
                    const size_t slotIdx = static_cast<size_t>(std::stoul(rest.substr(colon1 + 1, colon2 - colon1 - 1)));
                    const int paramIdx = std::stoi(rest.substr(colon2 + 1));
                    engine.setPluginParameter(stripIdx, slotIdx, paramIdx, val);
                } catch (...) {}
            }
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
    // Vendor processors may report a new algorithmic latency from their own
    // audio callback. Their listener only flips an atomic; this message-thread
    // poll performs the bounded latest-wins bank rebuild.
    engine.servicePluginHostChanges();

    // Busy is SPA-only (state.busy); Core does not draw an overlay.
    if (engine.isBusy()) {
        drainWebCommands();
        publishWebState();
        return;
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

    // Cycle / skip-cycle seek requested by the audio thread (single engine
    // authority so every connected client hears the same loop without SPA
    // racing transport.seek against each other).
    double cycleSeekSec = 0.0;
    if (engine.consumeCycleSeek(cycleSeekSec)) {
        std::string error;
        (void)engine.seekToSeconds(cycleSeekSec, error);
    }

    drainWebCommands();

    publishWebState();
    maybePublishPeaks();
    maybePublishAllPeaks();
}




void MainComponent::applyGlobalBindings() {
    // Global (Application Support), not per-project -- see AppSettings.h.
    // Backfill missing actions with compiled-in defaults; saved settings win.
    bool migratedLegacyBarKeys = false;
    if (const auto previous = appSettings.keybindings.find("bar_prev");
        previous != appSettings.keybindings.end() && previous->second == "left") {
        previous->second = ",";
        migratedLegacyBarKeys = true;
    }
    if (const auto next = appSettings.keybindings.find("bar_next");
        next != appSettings.keybindings.end() && next->second == "right") {
        next->second = ".";
        migratedLegacyBarKeys = true;
    }
    for (const auto& [action, description] : keyBindings)
        appSettings.keybindings.try_emplace(action, description);

    const auto oldMappingCount = appSettings.midiMappings.size();
    std::erase_if(appSettings.midiMappings, [](const MidiMapping& mapping) {
        return !isMidiMappableAction(mapping.action);
    });
    if (migratedLegacyBarKeys || oldMappingCount != appSettings.midiMappings.size())
        saveAppSettingsToDisk();

    for (const auto& [action, description] : appSettings.keybindings)
        keyBindings[action] = description;
    midiInput.setMappings(appSettings.midiMappings);
}

void MainComponent::saveAppSettingsToDisk() {
    std::string error;
    if (!saveAppSettings(appSettings, error))
        setStatus("Failed to save settings: " + juce::String(error));
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
    const auto now = juce::Time::getMillisecondCounterHiRes();
    if (now - lastTogglePlaybackTime_ < 100.0)
        return;
    lastTogglePlaybackTime_ = now;

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
    engine.notifyLightEngineProjectChanged();
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


} // namespace resostage
