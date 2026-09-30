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
[[maybe_unused]] static int getCurrentProcessId() {
    return static_cast<int>(::GetCurrentProcessId());
}
#else
#include <unistd.h>
[[maybe_unused]] static int getCurrentProcessId() {
    return static_cast<int>(::getpid());
}
#endif

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <vector>

namespace resostage {
namespace {

class OfflinePluginSession final : public OfflineProcessorSession {
public:
    OfflinePluginSession(std::shared_ptr<PluginProcessorBank> bankIn,
                         std::shared_ptr<PluginDelayBank> delayBankIn,
                         std::vector<std::string> warningsIn)
        : bank(std::move(bankIn)), delayBank(std::move(delayBankIn)),
          buildWarnings(std::move(warningsIn)) {}

    MixProcessorView processorView() const noexcept override {
        return bank != nullptr
            ? bank->processorView(delayBank.get()) : MixProcessorView{};
    }

    void publishTransport(
        const OfflineProcessorTransport& transport) noexcept override {
        if (bank == nullptr)
            return;
        PluginTransportState state;
        state.sample = transport.sample;
        state.sampleRate = transport.sampleRate;
        state.bpm = transport.bpm;
        state.numerator = transport.numerator;
        state.denominator = transport.denominator;
        state.playing = transport.playing;
        state.looping = transport.looping;
        state.loopStartSample = transport.loopStartSample;
        state.loopEndSample = transport.loopEndSample;
        bank->publishTransport(state);
    }

    bool stripHasInstrument(uint32_t strip) const noexcept override {
        return bank != nullptr && bank->stripHasInstrument(strip);
    }

    void queueMidiNote(uint32_t strip, uint8_t channel, uint8_t pitch, uint8_t velocity,
                       uint8_t releaseVelocity, bool noteOn,
                       int samplePosition) noexcept override {
        if (bank == nullptr || !bank->stripHasInstrument(strip))
            return;
        const auto message = noteOn
            ? juce::MidiMessage::noteOn(static_cast<int>(channel) + 1, pitch, velocity)
            : juce::MidiMessage::noteOff(static_cast<int>(channel) + 1, pitch, releaseVelocity);
        bank->addStripMidiEvent(strip, message, samplePosition);
    }

    void queueMidiMessage(uint32_t strip, uint8_t status, uint8_t data1,
                          uint8_t data2, uint8_t dataLength,
                          int samplePosition) noexcept override {
        if (bank == nullptr || !bank->stripHasInstrument(strip) || dataLength > 2)
            return;
        uint8_t bytes[3] = { status, data1, data2 };
        const int length = static_cast<int>(dataLength) + 1;
        bank->addStripMidiEvent(strip, juce::MidiMessage(bytes, length), samplePosition);
    }

    void setPluginParameter(const std::string& slotId, int parameterIndex,
                            float normalizedValue) noexcept override {
        if (bank == nullptr || slotId.empty())
            return;
        // This session is private to the offline render worker. Unlike live
        // automation, this write never races the device callback or UI host.
        (void)bank->setPluginParameterBySlotId(
            slotId, parameterIndex, normalizedValue);
    }

    double declaredTailSeconds() const noexcept override {
        return bank != nullptr ? bank->tailSeconds() : 0.0;
    }

    std::vector<std::string> warnings() const override {
        return buildWarnings;
    }

private:
    std::shared_ptr<PluginProcessorBank> bank;
    std::shared_ptr<PluginDelayBank> delayBank;
    std::vector<std::string> buildWarnings;
};

} // namespace

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

// ── Electron shell mode ──────────────────────────────────────────────────
// Settings > UI = "electron" routes the on-screen window through the
// Electron shell (electron/ in the repo root) instead of a plain browser
// tab. The shell talks to the same backend (REST + WS on kWebPort) any
// remote browser tab would, builds its native menu bar / Touch Bar from
// GET /api/v1/ui/menu (MenuModel → JSON; Electron builds the real NSMenu),
// and dispatches menu clicks via POST /api/v1/action (PerformAction →
// performAction()). The JUCE process stays alive headlessly to keep the
// audio/lighting/transport engine and web server running.

namespace {
// electron executable for the given package dir, or an invalid File.
juce::File findElectronBinary(const juce::File& packageDir) {
    // Prefer the branded copy (electron/scripts/brand-mac-app.mjs, run as
    // part of `pnpm build` in electron/) so macOS shows "ResoStage" with the
    // real icns icon in the Dock/⌘-Tab instead of stock "Electron" -- falls
    // back to the raw node_modules copy if branding hasn't run yet.
    const auto branded = packageDir
        .getChildFile("dist-app/ResoStage.app/Contents/MacOS/Electron");
    if (branded.existsAsFile())
        return branded;
    const auto dist = packageDir
        .getChildFile("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
    if (dist.existsAsFile())
        return dist;
    const auto bin = packageDir.getChildFile("node_modules/.bin/electron");
    if (bin.existsAsFile())
        return bin;
    return {};
}

// The app is often launched via `open` (CWD = "/") from a staged/packaged
// layout, so resolve the electron/ package by walking up from BOTH the
// working directory and the app bundle location until a directory holding
// electron/package.json turns up.
juce::File findElectronPackageDir() {
    if (const char* dir = std::getenv("RESOSTAGE_ELECTRON_DIR");
        dir != nullptr && dir[0] != '\0') {
        const juce::File explicitDir(juce::String::fromUTF8(dir));
        if (explicitDir.isDirectory())
            return explicitDir;
    }
    auto containsElectronPkg = [](const juce::File& dir) {
        return dir.getChildFile("electron/package.json").existsAsFile();
    };
    // Walk up from the working directory (dev: `pnpm` runs from repo root).
    juce::File cwd = juce::File::getCurrentWorkingDirectory();
    while (cwd.exists()) {
        if (containsElectronPkg(cwd))
            return cwd.getChildFile("electron");
        if (cwd.isRoot())
            break;
        cwd = cwd.getParentDirectory();
    }
    // Walk up from the app bundle (open/LaunchServices: CWD = "/").
    juce::File bundle = juce::File::getSpecialLocation(juce::File::currentApplicationFile);
    while (bundle.exists()) {
        if (containsElectronPkg(bundle))
            return bundle.getChildFile("electron");
        if (bundle.isRoot())
            break;
        bundle = bundle.getParentDirectory();
    }
    return {};
}
} // namespace

void MainComponent::launchElectronShell() {
    const juce::File packageDir = findElectronPackageDir();
    if (!packageDir.isDirectory()) {
        setStatus("Electron package not found -- run `pnpm install` at the repo root "
                  "(or set RESOSTAGE_ELECTRON_DIR), then restart in Electron mode");
#if JUCE_MAC
        restoreForegroundShell();
#endif
        return;
    }

    juce::File binary;
    if (const char* bin = std::getenv("RESOSTAGE_ELECTRON_BIN");
        bin != nullptr && bin[0] != '\0')
        binary = juce::File(juce::String::fromUTF8(bin));
    else
        binary = findElectronBinary(packageDir);

    if (!binary.existsAsFile()) {
        setStatus("Electron shell not found in " + packageDir.getFullPathName()
                  + " -- run `pnpm install` at the repo root "
                  "(or set RESOSTAGE_ELECTRON_DIR), then restart in Electron mode");
#if JUCE_MAC
        restoreForegroundShell();
#endif
        return;
    }

    // The shell is TypeScript; electron loads dist/main.mjs per package.json.
    if (!packageDir.getChildFile("dist/main.mjs").existsAsFile()) {
        setStatus("Electron shell not built in " + packageDir.getFullPathName()
                  + " -- run `pnpm --dir electron build` at the repo root, then restart "
                  "in Electron mode");
#if JUCE_MAC
        restoreForegroundShell();
#endif
        return;
    }

    juce::StringArray args;
    args.add(binary.getFullPathName());
    args.add(packageDir.getFullPathName());
    args.add("--backend-port=" + juce::String(webPort_));

    electronProcess = std::make_unique<juce::ChildProcess>();
    if (!electronProcess->start(args)) {
        setStatus("Failed to launch the Electron shell (see console output)");
        electronProcess.reset();
#if JUCE_MAC
        restoreForegroundShell();
#endif
        return;
    }

    setStatus("Electron shell launched (UI engine: Electron)");
    // Drop out of the foreground once the shell is up: accessory policy so
    // Electron is the only visible ResoStage (no Dock icon for Core).
#if JUCE_MAC
    juce::MessageManager::callAsync([] { backOffToHeadlessShell(); });
#endif
}

void MainComponent::terminateElectronShell() {
    if (electronProcess != nullptr) {
        if (electronProcess->isRunning())
            electronProcess->kill();
        electronProcess.reset();
    }
#if JUCE_WINDOWS
    juce::File exeDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile).getParentDirectory();
    juce::File kaishakuExe = exeDir.getChildFile("kaishaku.exe");
    if (kaishakuExe.existsAsFile()) {
        auto selfPid = getCurrentProcessId();
        juce::ChildProcess killer;
        killer.start("\"" + kaishakuExe.getFullPathName() + "\" " + juce::String(selfPid));
    } else {
        const juce::String killCmd = "cmd.exe /c \"taskkill /IM resostage.exe /F /T >NUL 2>&1 & taskkill /IM ResoStage.exe /F /T >NUL 2>&1\"";
        juce::ChildProcess killer;
        killer.start(killCmd);
    }
#endif
}

void MainComponent::launchBrowserTab() {
    // Default "browser" engine: open the SPA in the system browser against the
    // embedded backend. Plain browser tab = remote UI, so NO ?embedded=1
    // marker (that flag is what tells the SPA to drive native file dialogs,
    // which only the Electron shell / on-screen window can; a browser tab
    // uses its own upload/download flow). Then back off to headless so the
    // Core stops being the visible face of ResoStage.
    const juce::String url =
        "http://localhost:" + juce::String(kWebPort) + "/";
    juce::URL(url).launchInDefaultBrowser();

#if JUCE_MAC
    juce::MessageManager::callAsync([] { backOffToHeadlessShell(); });
#endif
}

void MainComponent::paint(juce::Graphics&) {
    // Never on-desktop (headless host) -- nothing to paint.
}

void MainComponent::resized() {}

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

void MainComponent::openProjectFromIpc(const std::string& path) {
    // path may be .rsnrasetmeta file or .rsnraset folder/package
    juce::File f(path);
    if (!f.exists()) {
        setStatus("Project not found: " + juce::String(path));
        return;
    }

    juce::File projectDir = f;
    if (f.existsAsFile() || f.hasFileExtension("rsnrasetmeta")) {
        projectDir = f.getParentDirectory();
    }

    if (!projectDir.exists()) {
        setStatus("Project folder not found: " + projectDir.getFullPathName());
        return;
    }

    // If the current project has unsaved changes, ask first (same Save/Don't
    // Save/Cancel prompt as quitting). Await the answer before loading so we
    // don't silently discard work by opening the external project.
    if (engine.hasUnsavedChanges()) {
        if (awaitingOpenDecision) return; // already prompting
        awaitingOpenDecision = true;
        pendingOpenPath = path;
        publishWebState();
        return;
    }

    // Load the project (reuse existing logic)
    loadProjectFromPath(projectDir);
    // Bring Electron window to front if needed
    if (juce::JUCEApplication::getInstance()) {
        // Trigger UI to show
        publishWebState();
    }
}

void MainComponent::saveProjectToPath(const std::string& path, std::function<void(bool)> onDone) {
    if (engine.isBusy()) {
        setStatus("Project operation in progress; retry when it finishes");
        if (onDone) onDone(false);
        if (pendingSaveAsCallback) {
            auto cb = std::move(pendingSaveAsCallback);
            pendingSaveAsCallback = nullptr;
            cb(false);
        }
        return;
    }
    if (!engine.isProjectLoaded()) {
        setStatus("Nothing to save -- load a project first");
        if (onDone) onDone(false);
        if (pendingSaveAsCallback) {
            auto cb = std::move(pendingSaveAsCallback);
            pendingSaveAsCallback = nullptr;
            cb(false);
        }
        return;
    }
    juce::File target(path);
    if (!target.hasFileExtension(".rsnraset"))
        target = target.withFileExtension(".rsnraset");

    setStatus("Saving " + target.getFileName() + "…");
    publishWebState();

    auto cb = onDone;
    if (!cb && pendingSaveAsCallback) {
        cb = std::move(pendingSaveAsCallback);
        pendingSaveAsCallback = nullptr;
    }

    engine.saveProjectAsync(target.getFullPathName().toStdString(),
        [this, cb, target, name = target.getFileName()](bool ok, std::string error) {
            if (!ok) {
                setStatus("Save failed: " + juce::String(error));
                publishWebState();
                if (cb) cb(false);
                return;
            }
            ensureProjectFolderIcon(target);
            setStatus("Saved " + name);
            rememberRecentProject(target);
            publishWebState();
            if (cb) cb(true);
        });
}

void MainComponent::importSongFolderFromPath(const std::string& path) {
    juce::File file(path);
    if (!file.exists() || !file.isDirectory()) {
        setStatus("Invalid song folder: " + juce::String(path));
        return;
    }
    const std::string songName = file.getFileName().toStdString();
    setStatus("Importing " + file.getFileName() + "…");
    engine.importSongFromFolderAsync(
        file.getFullPathName().toStdString(), songName, 120.0, 4, 4,
        [this, name = file.getFileName()](bool ok, std::string error) {
            if (!ok) {
                setStatus("Song import failed: " + juce::String(error));
                return;
            }
            notifyProjectStructureChanged();
            setStatus("Imported song '" + name + "'");
        });
}

void MainComponent::ensureProjectFolderIcon(const juce::File& projectFile) {
    if (!projectFile.isDirectory())
        return;

    // Service-resources subfolder, named in the same capitalized style as the
    // container's own Audio/ / Peaks/ / Autosave/ / Backups/ folders. Holds the
    // project-folder icon so the folder always carries it regardless of how the
    // app is installed (it is embedded in the Core binary, not read from disk).
    juce::File resDir = projectFile.getChildFile("Resources");
    if (!resDir.exists() && !resDir.createDirectory().wasOk())
        return;

    // Write all platform-specific icon / shell-integration files unconditionally
    // so a project saved on any OS contains the full set and is identical to one
    // saved on another. The WinAPI attribute call is the only part that stays
    // platform-guarded (it needs windows.h types).

    // ── Windows: folder.ico + desktop.ini ───────────────────────────────────
    // Explorer uses desktop.ini to paint the folder with a custom icon.
    // Written on every platform so a Mac-saved project opens correctly on Windows.
    const char* ico = reinterpret_cast<const char*>(BinaryData::folder_ico);
    const int icoSize = BinaryData::folder_icoSize;
    if (ico != nullptr && icoSize > 0) {
        const juce::File icoFile = resDir.getChildFile("folder.ico");
        if (!icoFile.existsAsFile()) { // don't stomp a manually-customised icon
            juce::FileOutputStream os(icoFile);
            if (os.openedOk()) {
                os.write(ico, static_cast<size_t>(icoSize));
                os.flush();
            }
        }
    }

    // desktop.ini: written with CRLF line endings as required by Explorer.
    const juce::File iniFile = projectFile.getChildFile("desktop.ini");
    if (!iniFile.existsAsFile()) {
        iniFile.replaceWithText(
            "[.ShellClassInfo]\r\n"
            "IconResource=Resources\\folder.ico,0\r\n"
            "IconFile=Resources\\folder.ico\r\n"
            "IconIndex=0\r\n");
    }

#if JUCE_WINDOWS
    // System attribute makes Explorer read desktop.ini for the custom icon.
    // Only possible on Windows (WinAPI call).
    const std::wstring wpath = projectFile.getFullPathName().toWideCharPointer();
    DWORD attrs = ::GetFileAttributesW(wpath.c_str());
    if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_SYSTEM) == 0)
        ::SetFileAttributesW(wpath.c_str(), attrs | FILE_ATTRIBUTE_SYSTEM);
#endif

    // ── macOS: folder.icns ───────────────────────────────────────────────────
    // Finder uses the .icns to paint the folder. Written on every platform so
    // a Windows-saved project carries the icon file when opened on a Mac.
    const char* icns = reinterpret_cast<const char*>(BinaryData::folder_icns);
    const int icnsSize = BinaryData::folder_icnsSize;
    if (icns != nullptr && icnsSize > 0) {
        const juce::File icnsFile = resDir.getChildFile("folder.icns");
        if (!icnsFile.existsAsFile()) {
            juce::FileOutputStream os(icnsFile);
            if (os.openedOk()) {
                os.write(icns, static_cast<size_t>(icnsSize));
                os.flush();
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
    publishWebState();
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


void MainComponent::startAudioRender(const std::string& json) {
    if (audioRenderRunning.exchange(true, std::memory_order_acq_rel)) {
        webServer.failAudioRender("Another audio render is already running");
        return;
    }
    if (audioRenderThread.joinable())
        audioRenderThread.join();

    OfflineRenderRequest request;
    glz::generic doc;
    if (!builder_json::parseJson(json, doc)) {
        audioRenderRunning.store(false, std::memory_order_release);
        webServer.failAudioRender("Invalid render options");
        return;
    }

    std::string scope = "song";
    std::string legacyTarget = "master";
    std::string legacyTargetId;
    std::string namingPattern = "{project}_{song}_{stem}";
    std::string tailPolicy = "cut";
    std::string dither = "none";
    std::string normalization = "off";
    int songIndex = static_cast<int>(engine.currentSongIndex());
    int sampleRate = static_cast<int>(std::lround(std::max(8000.0, engine.project().sampleRate)));
    int bitDepth = 24;
    double rangeStart = 0.0;
    double rangeEnd = 0.0;
    double tailThresholdDb = -96.0;
    double tailQuietSeconds = 0.5;
    double maxTailSeconds = 30.0;
    double normalizationCeilingDb = -0.1;
    bool trimOutputLatency = true;
    (void)builder_json::getString(doc, "scope", scope);
    (void)builder_json::getString(doc, "target", legacyTarget);
    (void)builder_json::getString(doc, "targetId", legacyTargetId);
    if (!builder_json::getString(doc, "fileNamePattern", namingPattern))
        (void)builder_json::getString(doc, "fileName", namingPattern);
    (void)builder_json::getString(doc, "tailPolicy", tailPolicy);
    (void)builder_json::getString(doc, "dither", dither);
    (void)builder_json::getString(doc, "normalization", normalization);
    (void)builder_json::getInt(doc, "songIndex", songIndex);
    (void)builder_json::getInt(doc, "sampleRate", sampleRate);
    (void)builder_json::getInt(doc, "bitDepth", bitDepth);
    (void)builder_json::getDouble(doc, "rangeStartSeconds", rangeStart);
    (void)builder_json::getDouble(doc, "rangeEndSeconds", rangeEnd);
    (void)builder_json::getDouble(doc, "tailThresholdDb", tailThresholdDb);
    (void)builder_json::getDouble(doc, "tailQuietSeconds", tailQuietSeconds);
    (void)builder_json::getDouble(doc, "maxTailSeconds", maxTailSeconds);
    (void)builder_json::getDouble(doc, "normalizationCeilingDb", normalizationCeilingDb);
    (void)builder_json::getBool(doc, "trimOutputLatency", trimOutputLatency);

    request.songIndex = scope == "project" ? -1 : songIndex;
    request.sampleRate = sampleRate;
    request.bitDepth = bitDepth;
    request.rangeStartSeconds = std::max(0.0, rangeStart);
    request.rangeEndSeconds = std::max(0.0, rangeEnd);
    request.tailPolicy = tailPolicy == "leave" ? RenderTailPolicy::Leave
        : (tailPolicy == "wrap" ? RenderTailPolicy::Wrap : RenderTailPolicy::Cut);
    request.dither = dither == "tpdf" ? RenderDither::Tpdf : RenderDither::None;
    request.normalization = normalization == "overload" ? RenderNormalization::OverloadProtection
        : (normalization == "peak" ? RenderNormalization::Peak : RenderNormalization::Off);
    request.normalizationCeilingDb = std::clamp(normalizationCeilingDb, -12.0, 0.0);
    request.trimOutputLatency = trimOutputLatency;
    request.tailThresholdDb = std::clamp(tailThresholdDb, -144.0, -24.0);
    request.tailQuietSeconds = std::clamp(tailQuietSeconds, 0.05, 10.0);
    request.maxTailSeconds = std::clamp(maxTailSeconds, 0.0, 60.0);

    auto kindFromWire = [](const std::string& kind) {
        if (kind == "track") return RenderTargetKind::Track;
        if (kind == "bus") return RenderTargetKind::Bus;
        if (kind == "click") return RenderTargetKind::Click;
        return RenderTargetKind::Master;
    };
    if (const auto* targetRows = builder_json::getArray(doc, "targets")) {
        for (const auto& row : *targetRows) {
            if (request.targets.size() >= 256) break;
            std::string kind;
            std::string id;
            if (!builder_json::getString(row, "kind", kind)) continue;
            (void)builder_json::getString(row, "id", id);
            request.targets.push_back({kindFromWire(kind), std::move(id), {}});
        }
    }
    if (request.targets.empty())
        request.targets.push_back({kindFromWire(legacyTarget), legacyTargetId, {}});

    const Project& liveProject = engine.project();
    auto stemName = [&liveProject](const OfflineRenderTarget& target) -> juce::String {
        if (target.kind == RenderTargetKind::Master) return "Main";
        if (target.kind == RenderTargetKind::Click) return "Click";
        if (target.kind == RenderTargetKind::Track) {
            for (const auto& track : liveProject.tracks)
                if (track.id == target.id) return juce::String(track.name);
            return "Track";
        }
        for (const auto& bus : liveProject.sends)
            if (bus.id == target.id) return juce::String(bus.name);
        return "Bus";
    };

    juce::File base(engine.projectPath());
    juce::File exportDir = base.getParentDirectory().getChildFile("Exports");
    if (engine.projectPath().empty())
        exportDir = juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
                        .getChildFile("ResoStage Exports");
    exportDir.createDirectory();

    const juce::String projectToken = juce::String(liveProject.name).isNotEmpty()
        ? juce::String(liveProject.name) : juce::String("Project");
    juce::String songToken = "Project";
    if (request.songIndex >= 0 && request.songIndex < static_cast<int>(liveProject.songs.size()))
        songToken = juce::String(liveProject.songs[static_cast<size_t>(request.songIndex)].name);
    std::vector<std::string> plannedOutputPaths;
    for (auto& target : request.targets) {
        juce::String expanded(namingPattern);
        expanded = expanded.replace("{project}", projectToken)
                           .replace("{song}", songToken)
                           .replace("{stem}", stemName(target))
                           .replace("{sampleRate}", juce::String(request.sampleRate))
                           .replace("{bitDepth}", juce::String(request.bitDepth));
        juce::String safeName = expanded.retainCharacters(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-.()");
        if (safeName.endsWithIgnoreCase(".wav"))
            safeName = safeName.dropLastCharacters(4);
        safeName = safeName.trim();
        if (safeName.isEmpty()) safeName = "ResoStage Render";
        juce::File output = exportDir.getChildFile(safeName + ".wav");
        int copy = 2;
        while (output.exists()
               || std::find(plannedOutputPaths.begin(), plannedOutputPaths.end(),
                            output.getFullPathName().toStdString()) != plannedOutputPaths.end()) {
            output = exportDir.getChildFile(safeName + " " + juce::String(copy++) + ".wav");
        }
        target.outputPath = output.getFullPathName().toStdString();
        plannedOutputPaths.push_back(target.outputPath);
    }
    request.outputPath = request.targets.front().outputPath;

    const Project projectSnapshot = engine.project();
    const std::string projectPath = engine.projectPath();
    cancelAudioRender.store(false, std::memory_order_release);
    setStatus("Rendering audio in background…");
    const juce::Component::SafePointer<MainComponent> safeThis(this);
    audioRenderThread = std::thread([this, safeThis, projectSnapshot, projectPath, request]() {
        OfflineRenderer renderer;
        const OfflineRenderer::ProcessorFactory processorFactory =
            [projectPath](const Project& project, const MixGraph& graph,
                          double renderSampleRate, int maximumBlockSize,
                          std::string& error)
                -> std::unique_ptr<OfflineProcessorSession> {
                ProjectLoader resourceLoader;
                const ProjectLoader* resources = nullptr;
                if (!projectPath.empty()) {
                    std::string openError;
                    if (resourceLoader.open(projectPath, openError))
                        resources = &resourceLoader;
                }
                auto built = PluginProcessorBank::build(
                    project, graph, resources, pluginRegistryFile(), renderSampleRate,
                    maximumBlockSize, /*nonRealtime=*/true);
                if (built.bank == nullptr) {
                    error = "Could not create offline plug-in bank";
                    return nullptr;
                }
                return std::make_unique<OfflinePluginSession>(
                    std::move(built.bank), std::move(built.delayBank),
                    std::move(built.warnings));
            };
        const OfflineRenderResult result = renderer.render(
            projectSnapshot, projectPath, request,
            [this, renderSampleRate = request.sampleRate](const OfflineRenderProgress& progress) {
                webServer.updateAudioRenderProgress(
                    progress.progress, progress.processedFrames,
                    progress.estimatedTotalFrames, renderSampleRate, progress.phase);
            },
            &cancelAudioRender, processorFactory);
        if (result.ok)
            webServer.completeAudioRender(result.outputPaths, result.warnings);
        else
            webServer.failAudioRender(result.error);
        audioRenderRunning.store(false, std::memory_order_release);
        juce::MessageManager::callAsync([safeThis, result]() {
            if (safeThis == nullptr) return;
            safeThis->setStatus(result.ok
                ? "Render complete: " + juce::String(result.outputPath)
                : "Render failed: " + juce::String(result.error));
        });
    });
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

void MainComponent::handleOpenDecision(int choice) {
    if (!awaitingOpenDecision)
        return;
    const std::string path = pendingOpenPath;
    awaitingOpenDecision = false;
    pendingOpenPath.clear();

    auto doOpen = [this, path]() {
        juce::File f(path);
        juce::File projectDir;
        if (f.hasFileExtension("rsnrasetmeta"))
            projectDir = f.getParentDirectory();
        else
            projectDir = f;
        loadProjectFromPath(projectDir);
    };

    if (choice == 1) { // Save, then open
        saveProjectClicked(engine.isDraftProject(), [this, doOpen](bool ok) {
            if (ok) {
                engine.clearDirty();
                doOpen();
            }
        });
    } else if (choice == 2) { // Don't Save, open anyway
        doOpen();
    } else { // Cancel
        setStatus("Open cancelled.");
    }
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

void MainComponent::newProjectClicked() {
    auto doNew = [this] {
        if (engine.isBusy()) {
            setStatus("Project operation in progress; retry when it finishes");
            return;
        }
        closeAllPluginEditors();
        engine.newProject();
        applyGlobalBindings();
        onProjectLoaded();
        setStatus("New project -- start editing or add songs in Builder, then Save As to create the .rsnraset file");
    };

    // Not destructive to click accidentally when nothing meaningful has
    // happened yet (only empty default song, never saved for real) -- skip the
    // confirm nag in that case. A draft archive doesn't count as "saved" here
    // (every fresh project auto-creates one; that's an implementation detail,
    // not something the user did on purpose), only a real user-chosen save
    // location does. Otherwise this discards in-memory edits with no undo,
    // so confirm first.
    bool hasContent = false;
    if (engine.project().songs.size() > 1) {
        hasContent = true;
    } else if (engine.project().songs.size() == 1) {
        const auto& s = engine.project().songs[0];
        if (!s.regions.empty() || !s.midiRegions.empty() || !s.events.empty()
            || !s.lightCues.empty() || !s.sections.empty() || !s.automationLanes.empty()
            || (s.name != "New Song" && s.name != "Song 1")) {
            hasContent = true;
        }
    }
    const bool hasSomethingToLose =
        hasContent || engine.canUndoTimeline() || (!engine.projectPath().empty() && !engine.isDraftProject());
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
    if (engine.isBusy()) {
        setStatus("Project operation in progress; retry when it finishes");
        return false;
    }
    if (!file.exists())
        return false;

    juce::File target = file;
    if (target.existsAsFile()) {
        target = target.getParentDirectory();
    }

    closeAllPluginEditors();

    std::string error;
    if (!engine.loadProject(target.getFullPathName().toStdString(), error)) {
        setStatus("Load failed: " + juce::String(error));
        return false;
    }

    applyGlobalBindings();
    onProjectLoaded();
    setStatus("Loaded '" + juce::String(engine.project().name) + "' | "
              + juce::String(static_cast<int>(engine.project().songs.size())) + " songs | "
              + juce::String(static_cast<int>(engine.busCount())) + " busses");
    rememberRecentProject(target);

    if (!engine.project().songs.empty())
        goToSong(0);

    return true;
}

static void prepareNativeDialogForeground() {
#if JUCE_WINDOWS
    ::AllowSetForegroundWindow(ASFW_ANY);
    HWND fg = ::GetForegroundWindow();
    if (fg != NULL) {
        DWORD fgThread = ::GetWindowThreadProcessId(fg, NULL);
        DWORD myThread = ::GetCurrentThreadId();
        ::AttachThreadInput(fgThread, myThread, TRUE);
        ::SetForegroundWindow(fg);
        ::AttachThreadInput(fgThread, myThread, FALSE);
    }
#endif
}

void MainComponent::loadProjectClicked() {
    if (engine.isBusy()) {
        setStatus("Project operation in progress; retry when it finishes");
        return;
    }
    prepareNativeDialogForeground();

#if JUCE_WINDOWS
    const auto browserFlags = juce::FileBrowserComponent::openMode
                               | juce::FileBrowserComponent::canSelectDirectories;
    fileChooser = std::make_unique<juce::FileChooser>(
        "Select a .rsnraset project folder", juce::File(), "*");
#else
    const auto browserFlags = juce::FileBrowserComponent::openMode
                               | juce::FileBrowserComponent::canSelectFiles
                               | juce::FileBrowserComponent::canSelectDirectories;
    fileChooser = std::make_unique<juce::FileChooser>(
        "Select a .rsnraset project", juce::File(), "*.rsnraset;*.rsnrasetmeta;project.rsnrasetmeta");
#endif
    fileChooser->launchAsync(browserFlags, [this](const juce::FileChooser& fc) {
        const auto file = fc.getResult();
        if (file == juce::File())
            return;
        if (engine.isBusy()) {
            setStatus("Project operation in progress; retry when it finishes");
            return;
        }

        std::string error;
        closeAllPluginEditors();
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
    if (engine.isBusy()) {
        setStatus("Project operation in progress; retry when it finishes");
        if (onDone) onDone(false);
        return;
    }
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
        if (engine.isBusy()) {
            setStatus("Project operation in progress; retry when it finishes");
            if (onDone) onDone(false);
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
                // The single data file (project.rsnrasetmeta) is written by
                // saveAsWithExtras itself; here we only drop the folder icon
                // into the project's Resources/ and stamp desktop.ini.
                ensureProjectFolderIcon(target);
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

    const bool isElectron = (std::getenv("RESOSTAGE_SPAWNED_BY_SHELL") != nullptr);
    if (isElectron) {
        pendingSaveAsCallback = onDone;
        publishWebState();
        return;
    }

    prepareNativeDialogForeground();

#if JUCE_WINDOWS
    const auto browserFlags = juce::FileBrowserComponent::saveMode
                               | juce::FileBrowserComponent::canSelectDirectories
                               | juce::FileBrowserComponent::warnAboutOverwriting;
    fileChooser = std::make_unique<juce::FileChooser>(
        "Save .rsnraset project folder",
        hasRealSaveLocation ? juce::File(engine.projectPath()) : juce::File(),
        "*");
#else
    const auto browserFlags = juce::FileBrowserComponent::saveMode
                               | juce::FileBrowserComponent::canSelectDirectories
                               | juce::FileBrowserComponent::canSelectFiles
                               | juce::FileBrowserComponent::warnAboutOverwriting;
    fileChooser = std::make_unique<juce::FileChooser>(
        "Save .rsnraset project",
        hasRealSaveLocation ? juce::File(engine.projectPath()) : juce::File(),
        "*.rsnraset");
#endif
    fileChooser->launchAsync(browserFlags, [doSave](const juce::FileChooser& fc) {
        doSave(fc.getResult());
    });
}

void MainComponent::onProjectLoaded() {
    ensureSongSelected();
    const auto& proj = engine.project();
    if (!proj.activeTrackId.empty()) {
        for (size_t i = 0; i < proj.tracks.size(); ++i) {
            if (proj.tracks[i].id == proj.activeTrackId) {
                engine.setFocusedTrack(static_cast<int>(i));
                break;
            }
        }
    }
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
