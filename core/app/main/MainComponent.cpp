/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

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

    // Create the IPC server before audio setup. Electron waits for
    // {"type":"ready"}, which notifyCoreReady() sends only after the device
    // opens. The listener runs in the background, so Electron can connect
    // before device startup and receive readiness once notifyCoreReady() runs.
    if (!ipcSocketPath.empty()) {
        ipcServer = std::make_unique<IpcServer>();
        if (!ipcServer->start(ipcSocketPath)) {
            std::fprintf(stderr, "[resostage-core] IPC server failed to start on %s\n",
                         ipcSocketPath.c_str());
            ipcServer.reset(); // Non-fatal: fall back to HTTP polling.
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
        auto& dm = engine.deviceManager();
        if (!appSettings.audioDeviceType.empty()) {
            const auto& types = dm.getAvailableDeviceTypes();
            const auto matchingType = std::find_if(types.begin(), types.end(), [this](auto* type) {
                return type != nullptr
                    && type->getTypeName().toStdString() == appSettings.audioDeviceType;
            });
            if (matchingType != types.end())
                dm.setCurrentAudioDeviceType((*matchingType)->getTypeName(), true);
        }

        auto setup = engine.deviceManager().getAudioDeviceSetup();
        auto* currentType = dm.getCurrentDeviceTypeObject();
        const auto hasDevice = [currentType](const std::string& name, bool wantInput) {
            if (name.empty() || currentType == nullptr)
                return false;
            return currentType->getDeviceNames(wantInput).contains(juce::String(name));
        };

        // A device remembered on another day may be unplugged now. Only ask
        // JUCE to reopen a saved name when the current host API still exposes
        // it; otherwise retain the manager's initialized default device and
        // let a later launch retry the saved preference.
        if (!appSettings.outputDeviceName.empty()) {
            if (hasDevice(appSettings.outputDeviceName, false)) {
                setup.outputDeviceName = appSettings.outputDeviceName;
                setup.useDefaultOutputChannels = appSettings.activeOutputChannels.empty();
            } else {
                if (currentType != nullptr) {
                    const int defOutIdx = currentType->getDefaultDeviceIndex(false);
                    const auto outNames = currentType->getDeviceNames(false);
                    if (defOutIdx >= 0 && defOutIdx < outNames.size())
                        setup.outputDeviceName = outNames[defOutIdx];
                    else if (!outNames.isEmpty())
                        setup.outputDeviceName = outNames[0];
                    else
                        setup.outputDeviceName.clear();
                } else {
                    setup.outputDeviceName.clear();
                }
                setup.useDefaultOutputChannels = true;
            }
        } else if (setup.outputDeviceName.isEmpty() && currentType != nullptr) {
            const int defOutIdx = currentType->getDefaultDeviceIndex(false);
            const auto outNames = currentType->getDeviceNames(false);
            if (defOutIdx >= 0 && defOutIdx < outNames.size())
                setup.outputDeviceName = outNames[defOutIdx];
            else if (!outNames.isEmpty())
                setup.outputDeviceName = outNames[0];
        }
        if (currentType != nullptr && !setup.outputDeviceName.isEmpty() && !hasDevice(setup.outputDeviceName.toStdString(), false)) {
            const int defOutIdx = currentType->getDefaultDeviceIndex(false);
            const auto outNames = currentType->getDeviceNames(false);
            if (defOutIdx >= 0 && defOutIdx < outNames.size())
                setup.outputDeviceName = outNames[defOutIdx];
            else if (!outNames.isEmpty())
                setup.outputDeviceName = outNames[0];
            else
                setup.outputDeviceName.clear();
        }

        if (appSettings.audioInputDisabled) {
            setup.inputDeviceName.clear();
            setup.inputChannels.clear();
            setup.useDefaultInputChannels = false;
        } else if (!appSettings.inputDeviceName.empty()) {
            if (hasDevice(appSettings.inputDeviceName, true)) {
                setup.inputDeviceName = appSettings.inputDeviceName;
                setup.useDefaultInputChannels = appSettings.activeInputChannels.empty();
            } else {
                setup.inputDeviceName.clear();
                setup.useDefaultInputChannels = true;
            }
        }
        if (!appSettings.audioInputDisabled && currentType != nullptr && !setup.inputDeviceName.isEmpty() && !hasDevice(setup.inputDeviceName.toStdString(), true)) {
            const int defInIdx = currentType->getDefaultDeviceIndex(true);
            const auto inNames = currentType->getDeviceNames(true);
            if (defInIdx >= 0 && defInIdx < inNames.size())
                setup.inputDeviceName = inNames[defInIdx];
            else if (!inNames.isEmpty())
                setup.inputDeviceName = inNames[0];
            else
                setup.inputDeviceName.clear();
        }
        setup.sampleRate = appSettings.sampleRate > 0.0 ? appSettings.sampleRate : 48000.0;
        if (appSettings.bufferSize > 0)
            setup.bufferSize = appSettings.bufferSize;
        if (!appSettings.activeOutputChannels.empty()
            && hasDevice(appSettings.outputDeviceName, false)) {
            juce::BigInteger bits;
            for (int idx : appSettings.activeOutputChannels)
                bits.setBit(idx);
            setup.outputChannels = bits;
            setup.useDefaultOutputChannels = false;
        }
        if (!appSettings.audioInputDisabled
            && !appSettings.activeInputChannels.empty()
            && hasDevice(appSettings.inputDeviceName, true)) {
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
    if (!appSettings.midiOutputNames.empty()) {
        std::string err;
        (void)engine.midi().openDestinations(appSettings.midiOutputNames, err);
    }
    if (!appSettings.midiInputNames.empty()) {
        std::string err;
        (void)midiInput.openSources(appSettings.midiInputNames, err);
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
    // Packaged Windows workers live under core/; web assets remain with
    // Electron's resources at the package root. Raw/legacy layouts still work.
    if (exeDir.getFileName().equalsIgnoreCase("core")
        || exeDir.getFileName().equalsIgnoreCase("helpers"))
        webServer.addWebRoot(exeDir.getParentDirectory().getChildFile("resources/web")
                                .getFullPathName().toStdString());
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
                response.loadState = bank->getSlotLoadState(slotId);
                response.loadError = bank->getSlotLoadError(slotId);
                response.truncated = bank->parameterMetadataTruncated(slotId);
                for (const auto& parameter : bank->parametersForSlot(slotId)) {
                    response.parameters.push_back({parameter.index, parameter.name,
                                                   parameter.label,
                                                   parameter.defaultValue,
                                                   parameter.steps, parameter.parameterId,
                                                   parameter.currentValue, parameter.automatable});
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
    engine.onRecordingFailed = [this](const std::string& error) {
        setStatus("Recording preparation failed: " + juce::String(error));
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
    for (const auto& command : deferredWebCommands) {
        if (command.kind == WebCommandKind::BuilderTrackImportWavUpload) {
            std::remove(command.path.c_str());
            glz::generic payload;
            std::string requestId;
            if (builder_json::parseJson(command.json, payload))
                builder_json::getString(payload, "requestId", requestId);
            webServer.finishTrackImport(requestId, false, "Core is shutting down");
        }
    }
    deferredWebCommands.clear();
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

void MainComponent::notifyProjectStructureChanged(bool contentChanged) {
    engine.rebuildBussesFromProject(contentChanged);
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
        // AudioEngine has already rebuilt routing. A second rebuild only
        // adds UI latency and can schedule redundant plug-in bank work.
        ensureSongSelected();
        engine.notifyLightEngineProjectChanged();
        setStatus("Undo: " + juce::String(label));
    } else {
        setStatus("Nothing to undo");
    }
    publishWebState();
}

void MainComponent::performTimelineRedo() {
    std::string label;
    if (engine.redoTimelineEdit(label)) {
        ensureSongSelected();
        engine.notifyLightEngineProjectChanged();
        setStatus("Redo: " + juce::String(label));
    } else {
        setStatus("Nothing to redo");
    }
    publishWebState();
}


} // namespace resostage
