#include "MainComponent.h"
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
    webServer.setLivePeaksProvider([this](const std::string& trackId, size_t level, size_t first, size_t count) {
        return engine.getLiveRecordingPeaks(trackId, level, first, count);
    });
    webServer.setMidiInputHandler([this](const uint8_t* data, int length) {
        engine.enqueueIncomingMidi(data, length);
    });
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
            case WebCommandKind::TransportRecord: engine.toggleRecording(); break;
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
            case WebCommandKind::SetTrackSoloSafe: {
                engine.projectHistoryBeginEdit("", "Toggle Track Solo-Safe");
                engine.setTrackSoloSafe(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackMono: {
                engine.projectHistoryBeginEdit("", "Toggle Track Mono");
                engine.setTrackMono(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackRecordArm: {
                engine.projectHistoryBeginEdit("", "Toggle Track Record Arm");
                engine.setTrackRecordArmed(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackInputMonitor: {
                engine.projectHistoryBeginEdit("", "Toggle Track Input Monitor");
                engine.setTrackInputMonitoring(engine.currentSongIndex(), idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackInputSource: {
                wire::WTrackInputSourcePayload payload;
                if (!glz::read_json(payload, cmd.json) && payload.trackIndex >= 0) {
                    engine.projectHistoryBeginEdit("", "Set Track Input Source");
                    engine.setTrackInputSource(engine.currentSongIndex(), static_cast<size_t>(payload.trackIndex), payload.inputSource, payload.midiInputChannel, payload.midiInputDevice);
                    engine.projectHistoryCommitEdit();
                }
                break;
            }
            case WebCommandKind::SetTrackTrim: {
                wire::WTrackTrimPayload payload;
                if (!glz::read_json(payload, cmd.json)) {
                    const size_t tIdx = payload.trackIndex >= 0 ? static_cast<size_t>(payload.trackIndex) : static_cast<size_t>(-1);
                    if (tIdx < engine.trackCount()) {
                        if (TrackDef* t = engine.trackDefAt(tIdx)) {
                            engine.projectHistoryBeginEdit("", "Set Track Trim");
                            t->inputTrimDb = payload.inputTrimDb;
                            t->polarity = polarityFromString(payload.polarity, payload.phaseInvert);
                            t->phaseInvert = payload.phaseInvert || (t->polarity != PolarityMask::None);
                            engine.projectHistoryCommitEdit();
                            engine.republishRouting();
                        }
                    }
                }
                break;
            }
            case WebCommandKind::SetAutoInputMonitoring: {
                wire::WAutoInputPayload payload;
                if (!glz::read_json(payload, cmd.json)) {
                    engine.setAutoInputMonitoring(payload.enabled);
                }
                break;
            }
            case WebCommandKind::SetAutoPunch: {
                wire::WAutoPunchPayload payload;
                if (!glz::read_json(payload, cmd.json)) {
                    engine.setAutoPunch(payload.enabled, payload.startSample, payload.endSample);
                }
                break;
            }
            case WebCommandKind::SetLowLatencyMonitoring: {
                wire::WLowLatencyPayload payload;
                if (!glz::read_json(payload, cmd.json)) {
                    engine.setLowLatencyMonitoring(payload.enabled, payload.limitMs);
                }
                break;
            }
            case WebCommandKind::SetBusGain: {
                engine.projectHistoryBeginEdit("bg" + std::to_string(idx), "Set Bus Gain");
                engine.setBusGainDb(idx, cmd.value);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetBusPan: {
                engine.projectHistoryBeginEdit("bp" + std::to_string(idx), "Set Bus Pan");
                engine.setBusPan(idx, cmd.value);
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
            case WebCommandKind::SetBusSoloSafe: {
                engine.projectHistoryBeginEdit("", "Toggle Bus Solo-Safe");
                engine.setBusSoloSafe(idx, cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetClickSolo: {
                engine.projectHistoryBeginEdit("", "Toggle Click Solo");
                engine.setClickSolo(cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetClickSoloSafe: {
                engine.projectHistoryBeginEdit("", "Toggle Click Solo-Safe");
                engine.setClickSoloSafe(cmd.value != 0.0);
                engine.projectHistoryCommitEdit();
                break;
            }
            case WebCommandKind::SetTrackSend: {
                std::string gestureId;
                glz::generic doc;
                if (builder_json::parseJson(cmd.json, doc)) {
                    builder_json::getString(doc, "gestureId", gestureId);
                    if (gestureId.empty()) {
                        int trackIndex = -1;
                        std::string busId;
                        builder_json::getInt(doc, "trackIndex", trackIndex);
                        builder_json::getString(doc, "busId", busId);
                        gestureId = "ts" + std::to_string(trackIndex) + "_" + busId;
                    }
                }
                engine.projectHistoryBeginEdit(gestureId, "Set Track Send");
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
                    rememberRecentProject(juce::File(cmd.path));
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
                    publishWebState();
                }
                break;
            }
            case WebCommandKind::ClearRecentProjects:
                appSettings.recentProjects.clear();
                saveAppSettingsToDisk();
                publishWebState();
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
            case WebCommandKind::RenderAudio:
                startAudioRender(cmd.json);
                break;
            case WebCommandKind::CancelAudioRender:
                cancelAudioRender.store(true, std::memory_order_release);
                setStatus("Cancelling audio render…");
                break;
            case WebCommandKind::PluginScan: {
                wire::WPluginScanPayload p;
                (void)glz::read_json(p, cmd.json);
                if (!pluginCatalog.startScan(p.rescanAll))
                    setStatus("Plug-in scan is already running");
                break;
            }
            case WebCommandKind::PluginScanCancel:
                setStatus(pluginCatalog.cancelScan()
                    ? "Cancelling plug-in scan…"
                    : "No plug-in scan is running");
                break;
            case WebCommandKind::PluginSetEnabled: {
                glz::generic doc;
                std::string pluginId;
                bool enabled = true;
                if (builder_json::parseJson(cmd.json, doc)
                    && builder_json::getString(doc, "pluginId", pluginId)
                    && builder_json::getBool(doc, "enabled", enabled)) {
                    setStatus(pluginCatalog.setPluginEnabled(pluginId, enabled)
                        ? (enabled ? "Plug-in enabled" : "Plug-in disabled")
                        : "Could not update plug-in: catalog item not found");
                }
                break;
            }
            case WebCommandKind::PluginSlotAdd: pluginSlotAdd(cmd.json); break;
            case WebCommandKind::PluginSlotRemove: pluginSlotRemove(cmd.json); break;
            case WebCommandKind::PluginSlotMove: pluginSlotMove(cmd.json); break;
            case WebCommandKind::PluginSlotBypass: pluginSlotBypass(cmd.json); break;
            case WebCommandKind::PluginSlotOpenEditor: pluginSlotOpenEditor(cmd.json); break;
            case WebCommandKind::PluginSlotKeepAwake: pluginSlotKeepAwake(cmd.json); break;
            case WebCommandKind::PluginSlotPark: pluginSlotPark(cmd.json); break;
            case WebCommandKind::PluginSlotUnpark: pluginSlotUnpark(cmd.json); break;
            case WebCommandKind::BuilderSongAdd: builderSongAdd(cmd.json); break;
            case WebCommandKind::BuilderSongImportFolder: builderSongImportFolder(cmd.json); break;
            case WebCommandKind::BuilderSongRemove: builderSongRemove(cmd.json); break;
            case WebCommandKind::BuilderSongMove: builderSongMove(cmd.json); break;
            case WebCommandKind::BuilderSongEnd: builderSongEnd(cmd.json); break;
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
            case WebCommandKind::BuilderTrackImportWavDialog: builderTrackImportWavDialog(cmd.json); break;
            case WebCommandKind::BuilderRegionAdd: builderRegionAdd(cmd.json); break;
            case WebCommandKind::BuilderRegionRemove: builderRegionRemove(cmd.json); break;
            case WebCommandKind::BuilderRegionUpdate: builderRegionUpdate(cmd.json); break;
            case WebCommandKind::BuilderMidiRegionAdd: builderMidiRegionAdd(cmd.json); break;
            case WebCommandKind::BuilderMidiRegionRemove: builderMidiRegionRemove(cmd.json); break;
            case WebCommandKind::BuilderMidiRegionUpdate: builderMidiRegionUpdate(cmd.json); break;
            case WebCommandKind::BuilderAutomationLaneAdd: builderAutomationLaneAdd(cmd.json); break;
            case WebCommandKind::BuilderAutomationLaneRemove: builderAutomationLaneRemove(cmd.json); break;
            case WebCommandKind::BuilderAutomationLaneUpdate: builderAutomationLaneUpdate(cmd.json); break;
            case WebCommandKind::BuilderAutomationPointAdd: builderAutomationPointAdd(cmd.json); break;
            case WebCommandKind::BuilderAutomationPointRemove: builderAutomationPointRemove(cmd.json); break;
            case WebCommandKind::BuilderAutomationRecordGesture: builderAutomationRecordGesture(cmd.json); break;
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
            case WebCommandKind::BuilderCycleUpdate: builderCycleUpdate(cmd.json); break;
            case WebCommandKind::SetLightingConfig: lightingSetConfig(cmd.json); break;
            case WebCommandKind::LightFixtureAdd: lightingFixtureAdd(cmd.json); break;
            case WebCommandKind::LightFixtureDuplicate: lightingFixtureDuplicate(cmd.json); break;
            case WebCommandKind::LightFixtureRemove: lightingFixtureRemove(cmd.json); break;
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
            case WebCommandKind::SetAudioInputDevice: settingsSetAudioInputDevice(cmd.json); break;
            case WebCommandKind::SetAudioDeviceType: settingsSetAudioDeviceType(cmd.json); break;
            case WebCommandKind::ShowAudioControlPanel: settingsShowAudioControlPanel(); break;
            case WebCommandKind::SetSampleRate: settingsSetSampleRate(cmd.json); break;
            case WebCommandKind::SetBufferSize: settingsSetBufferSize(cmd.json); break;
            case WebCommandKind::SetMidiOutput: settingsSetMidiOutput(cmd.json); break;
            case WebCommandKind::SetMidiInput: settingsSetMidiInput(cmd.json); break;
            case WebCommandKind::SetMidiVirtualPort: settingsSetMidiVirtualPort(cmd.json); break;
            case WebCommandKind::SetUiRenderEngine: settingsSetUiRenderEngine(cmd.json); break;
            case WebCommandKind::SetTheme: settingsSetTheme(cmd.json); break;
            case WebCommandKind::SetKeybinding: settingsSetKeybinding(cmd.json); break;
            case WebCommandKind::SetOutputChannels: settingsSetOutputChannels(cmd.json); break;
            case WebCommandKind::SetInputChannels: settingsSetInputChannels(cmd.json); break;
            case WebCommandKind::MidiLearn: settingsMidiLearn(cmd.json); break;
            case WebCommandKind::MidiLearnCancel: settingsMidiLearnCancel(); break;
            case WebCommandKind::MidiClear: settingsMidiClear(cmd.json); break;
            case WebCommandKind::Seek: transportSeek(cmd.json); break;
            case WebCommandKind::QuitDecision: handleQuitDecision(cmd.arg); break;
            case WebCommandKind::OpenDecision: handleOpenDecision(cmd.arg); break;
            case WebCommandKind::UiFocusState:
                // Legacy no-op: native MacKeyMonitor is gone; SPA handles focus.
                break;
            case WebCommandKind::PerformAction: {
                // From the Electron shell's menu / action bridge. cmd.json
                // carries {"action":"..."}.
                glz::generic doc;
                std::string action;
                if (builder_json::parseJson(cmd.json, doc)
                    && builder_json::getString(doc, "action", action) && !action.empty())
                    performAction(action);
                break;
            }
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
    state.recording = engine.isRecording();
    state.autoInputMonitoring = engine.isAutoInputMonitoring();
    state.autoPunchEnabled = engine.isAutoPunchEnabled();
    state.lowLatencyMonitoring = engine.isLowLatencyMonitoring();
    state.lowLatencyLimitMs = engine.getLowLatencyLimitMs();
    state.liveRecordings = engine.getLiveRecordingRegions();
    state.hardwareAlarm = transport.hardwareAlarm.load(std::memory_order_relaxed);

    const Project& proj = engine.project();
    const auto activeBank = engine.activePluginProcessorBank();
    const auto copyPluginSlots = [&activeBank](const std::vector<PluginSlot>& slots) {
        std::vector<WebUiState::PluginSlotRow> rows;
        rows.reserve(slots.size());
        for (const auto& slot : slots) {
            WebUiState::PluginSlotRow row;
            row.id = slot.id;
            row.pluginId = slot.plugin.identifier;
            row.name = slot.plugin.name;
            row.manufacturer = slot.plugin.manufacturer;
            row.format = slot.plugin.format;
            row.instrument = slot.plugin.instrument;
            row.bypassed = slot.bypassed;
            row.hasState = slot.stateResource.has_value();
            row.keepAwake = slot.keepAwake;
            if (activeBank != nullptr) {
                row.powerState = pluginPowerStateToString(activeBank->getSlotPowerState(slot.id));
            } else {
                row.powerState = "active";
            }
            rows.push_back(std::move(row));
        }
        return rows;
    };
    state.projectName = proj.name;
    state.click = proj.click.enabled;
    state.clickName = proj.click.name.empty() ? "Click" : proj.click.name;
    state.clickBusId = routeIdOf(proj.click.output);
    state.clickGainDb = proj.click.gainDb;
    state.clickPan = proj.click.pan;
    state.clickMono = proj.click.channels == 1;
    state.clickSolo = proj.click.solo;
    state.clickSoloSafe = engine.isClickSoloSafe();
    state.clickOutputType = outputTypeToString(proj.click.output.type);
    state.clickOutputTarget = proj.click.output.target.value_or("");
    state.clickSoloGroup = engine.trackSoloGroup();
    state.clickSoloActiveInGroup = engine.anySoloInGroup(state.clickSoloGroup.c_str());
    state.clickSends.clear();
    for (const SendConfig& cs : proj.click.output.sends) {
        WebUiState::ClickSendRow csr;
        csr.busId = cs.bus;
        csr.level = cs.level;
        csr.enabled = cs.enabled;
        state.clickSends.push_back(std::move(csr));
    }
    state.clickPlugins = copyPluginSlots(proj.click.plugins);
    // Interval max of rendered click peaks since last poll — captures every
    // audible tick even when the impulse is shorter than the UI sample period.
    {
        const MeterFrame clickFrame = engine.consumeClickMeterInterval();
        state.clickPeakDb = clickFrame.peakDb;
        state.clickPeakDbL = clickFrame.peakDbL;
        state.clickPeakDbR = clickFrame.peakDbR;
        state.clickIntervalPeakDbL = clickFrame.intervalPeakDbL;
        state.clickIntervalPeakDbR = clickFrame.intervalPeakDbR;
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
        state.streamRingFraction = bh.minRingFraction;
        state.streamIoPressure = bh.ioPressure == IoPressureLevel::Critical  ? "critical"
                                 : bh.ioPressure == IoPressureLevel::Tight   ? "tight"
                                                                             : "healthy";
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
    state.openConfirmPending = awaitingOpenDecision;
    state.saveAsPending = (pendingSaveAsCallback != nullptr);
    state.uiTab = uiTabRequest;
    state.uiTabSeq = uiTabSeq;
    state.canUndo = engine.canUndoTimeline();
    state.canRedo = engine.canRedoTimeline();
    state.undoLabel = engine.undoTimelineLabel();
    state.redoLabel = engine.redoTimelineLabel();

    state.songs.reserve(proj.songs.size());
    for (const SongDef& song : proj.songs) {
        WebUiState::SongRow row;
        row.name = song.name;
        row.bpm = song.bpm;
        row.autoplay = (song.onEnded == SongEnd::Next);
        row.tsNum = song.timeSignature.numerator;
        row.tsDen = song.timeSignature.denominator;
        row.endSeconds = song.endSeconds;
        // Metronome is project-global — mirror onto every song row so older
        // SPA code that still reads song.click / song.clickSends stays correct.
        row.click = proj.click.enabled;
        row.clickBusId = routeIdOf(proj.click.output);
        row.clickGainDb = proj.click.gainDb;
        for (const SendConfig& cs : proj.click.output.sends) {
            WebUiState::SongRow::ClickSendRow csr;
            csr.busId = cs.bus;
            csr.level = cs.level;
            csr.enabled = cs.enabled;
            row.clickSends.push_back(std::move(csr));
        }

        row.regions.reserve(song.regions.size());
        for (const Region& r : song.regions) {
            WebUiState::SongRow::RegionRow rr;
            rr.id = r.id;
            rr.trackId = r.trackId;
            rr.startSeconds = r.startSeconds;
            rr.durationSeconds = r.durationSeconds;
            rr.gainDb = r.gainDb;
            rr.source.file = r.source.file;
            rr.source.offsetSeconds = r.source.offsetSeconds;
            rr.fade.inSeconds = r.fade.inSeconds;
            rr.fade.outSeconds = r.fade.outSeconds;
            rr.fade.inCurve = r.fade.inCurve;
            rr.fade.outCurve = r.fade.outCurve;
            rr.loop.enabled = r.loop.enabled;
            rr.loop.lengthSeconds = r.loop.lengthSeconds;
            rr.playback.speed = r.playback.speed;
            rr.playback.semitones = r.playback.semitones;
            rr.playback.reverse = r.playback.reverse;
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
            er.httpUrl = e.httpUrl.value_or("");
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
            lcr.color.r = lc.color.r;
            lcr.color.g = lc.color.g;
            lcr.color.b = lc.color.b;
            lcr.intensity = lc.intensity;
            lcr.fade.inSeconds = lc.fade.inSeconds;
            lcr.fade.outSeconds = lc.fade.outSeconds;
            lcr.label = lc.label.value_or("");
            lcr.effect.type = lc.effect.type.value_or("");
            lcr.effect.sourceType = lc.effect.sourceType;
            lcr.effect.sourceId = lc.effect.sourceId.value_or("");
            lcr.effect.intensity = lc.effect.intensity;
            lcr.effect.tempoSync = lc.effect.tempoSync;
            lcr.effect.tempoSubdivision = lc.effect.tempoSubdivision;
            lcr.effect.rateHz = lc.effect.rateHz;
            lcr.gradient.preset = lc.gradient.preset;
            lcr.gradient.colors = lc.gradient.colors.value_or("");
            lcr.blendMode = lc.blendMode;
            row.lightCues.push_back(std::move(lcr));
        }

        row.midiRegions.reserve(song.midiRegions.size());
        for (const auto& mr : song.midiRegions) {
            WebUiState::SongRow::MidiRegionRow mrr;
            mrr.id = mr.id;
            mrr.trackId = mr.trackId;
            mrr.name = mr.name;
            mrr.startBeats = mr.startBeats;
            mrr.durationBeats = mr.durationBeats;
            mrr.clipOffsetBeats = mr.clipOffsetBeats;
            mrr.loop = mr.loop;
            mrr.loopLengthBeats = mr.loopLengthBeats;
            mrr.muted = mr.muted;
            mrr.color = mr.color;
            mrr.notes.reserve(mr.notes.size());
            for (const auto& n : mr.notes) {
                WebUiState::SongRow::MidiRegionRow::Note nr;
                nr.id = n.id;
                nr.pitch = n.pitch;
                nr.startBeats = n.startBeats;
                nr.durationBeats = n.durationBeats;
                nr.velocity = n.velocity;
                nr.releaseVelocity = n.releaseVelocity;
                nr.probability = n.probability;
                nr.pan = n.pan;
                nr.tuningOffsetCents = n.tuningOffsetCents;
                nr.muted = n.muted;
                mrr.notes.push_back(std::move(nr));
            }
            row.midiRegions.push_back(std::move(mrr));
        }

        row.tempoPoints.reserve(song.tempoPoints.size());
        for (const auto& tp : song.tempoPoints) {
            WebUiState::SongRow::TempoPointRow tpr;
            tpr.beat = tp.beat;
            tpr.bpm = tp.bpm;
            tpr.timeSeconds = tp.timeSeconds;
            tpr.curve = tp.curve;
            row.tempoPoints.push_back(std::move(tpr));
        }

        row.signaturePoints.reserve(song.signaturePoints.size());
        for (const auto& sp : song.signaturePoints) {
            WebUiState::SongRow::SignaturePointRow spr;
            spr.beat = sp.beat;
            spr.numerator = sp.numerator;
            spr.denominator = sp.denominator;
            spr.bar = sp.bar;
            row.signaturePoints.push_back(std::move(spr));
        }

        state.songs.push_back(std::move(row));
    }

    // Project-wide cycle (one zone; songIndex binds left/right to a song).
    state.cycle.active = proj.cycle.active;
    state.cycle.skip = proj.cycle.skip;
    state.cycle.startSeconds = proj.cycle.startSeconds;
    state.cycle.endSeconds = proj.cycle.endSeconds;
    state.cycle.songIndex = proj.cycle.songIndex;

    if (state.songIndex >= 0 && static_cast<size_t>(state.songIndex) < proj.songs.size()) {
        const SongDef& song = proj.songs[static_cast<size_t>(state.songIndex)];
        state.songName = song.name;
        state.bpm = song.bpm;
    }

    state.meters.reserve(engine.busCount());
    for (size_t i = 0; i < engine.busCount(); ++i) {
        WebUiState::MeterRow m;
        m.id = engine.busIdAt(i);
        // Interval-max peaks so short impulses (metronome on this bus) are not
        // lost between UI polls — see AudioEngine::consumeBusMeterInterval().
        {
            const MeterFrame frame = engine.consumeBusMeterInterval(i);
            m.peakDb = frame.peakDb;
            m.peakDbL = frame.peakDbL;
            m.peakDbR = frame.peakDbR;
            m.intervalPeakDbL = frame.intervalPeakDbL;
            m.intervalPeakDbR = frame.intervalPeakDbR;
            m.shortTermLufs = frame.shortTermLufs;
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
        tr.kind = trackKindToString(def.kind);
        tr.stripId = def.effectiveStripId();
        tr.channels = def.channels;
        tr.gainDb = def.gainDb;
        tr.pan = def.pan;
        tr.mute = def.mute;
        tr.solo = def.solo;
        tr.soloSafe = def.soloSafe;
        tr.soloGroup = engine.trackSoloGroup();
        tr.soloActiveInGroup = engine.anySoloInGroup(tr.soloGroup.c_str());
        tr.recordArmed = def.recordArmed;
        tr.inputMonitoring = def.inputMonitoring;
        tr.inputSource = def.inputSource;
        tr.midiInputChannel = def.midiInputChannel;
        tr.midiInputDevice = def.midiInputDevice;
        tr.inputTrimDb = def.inputTrimDb;
        tr.phaseInvert = def.phaseInvert;
        tr.polarity = polarityToString(def.polarity);
        tr.plugins = copyPluginSlots(def.plugins);
        // The project serializer's mapping, not a second copy of it. The copy
        // that used to live here had drifted: it had no case for
        // OutputType::Bus and folded it into a `default:` of "main", so a
        // track whose main route is an aux/group bus was published to the web
        // UI as routed to Main -- the mixer showed the wrong destination and
        // sourceOutputBusId() resolved it to "audio::main" instead of the bus
        // id. -Wswitch-enum is what surfaced it.
        tr.output.type = outputTypeToString(def.output.type);
        tr.output.target = def.output.target.value_or("");
        for (const auto& send : def.output.sends) {
            WebUiState::TrackRow::SendRow sr;
            sr.bus = send.bus;
            sr.level = send.level;
            sr.preFader = send.preFader || (send.tap == SendTap::PreFader);
            sr.enabled = send.enabled;
            sr.lowLatencySafe = send.lowLatencySafe;
            sr.tap = sendTapToString(send.tap != SendTap::PostPan ? send.tap : (send.preFader ? SendTap::PreFader : SendTap::PostPan));
            tr.output.sends.push_back(std::move(sr));
        }

        // Interval-max peaks so short impulses on tracks are not lost between
        // UI polls -- same pattern as buses/click (consumeBusMeterInterval).
        {
            const MeterFrame frame = engine.consumeTrackMeterInterval(i);
            tr.peakDb = frame.peakDb;
            tr.peakDbL = frame.peakDbL;
            tr.peakDbR = frame.peakDbR;
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
        br.soloSafe = engine.isBusSoloSafe(i);
        br.soloGroup = engine.busSoloGroupAt(i);
        br.soloActiveInGroup = engine.anySoloInGroup(br.soloGroup.c_str());
        br.startChannel = engine.busStartChannelAt(i);
        br.channels = engine.busChannelCountAt(i);
        br.isDirectOut = engine.busIsDirectAt(i);
        br.unavailable = engine.busIsDirectAt(i) && !engine.busAvailableAt(i);
        const auto sendIt = std::find_if(proj.sends.begin(), proj.sends.end(),
            [&](const SendBus& s) { return s.id == br.id; });
        if (br.id == "audio::main") {
            br.pan = proj.main.pan;
            br.isAux = false;
            br.plugins = copyPluginSlots(proj.main.plugins);
        } else if (sendIt != proj.sends.end()) {
            br.pan = sendIt->pan;
            br.isAux = true;
            br.plugins = copyPluginSlots(sendIt->plugins);
        } else {
            br.pan = 0.0;
            br.isAux = false;
        }
        // Peaks already consumed into state.meters above; re-read LUFS frame
        // for bus rows without double-clearing the interval max. Prefer the
        // same interval peaks so mixer strips match the master meters array.
        if (i < state.meters.size() && state.meters[i].id == br.id) {
            br.peakDb = state.meters[i].peakDb;
            br.peakDbL = state.meters[i].peakDbL;
            br.peakDbR = state.meters[i].peakDbR;
        } else {
            const MeterFrame frame = engine.consumeBusMeterInterval(i);
            br.peakDb = frame.peakDb;
            br.peakDbL = frame.peakDbL;
            br.peakDbR = frame.peakDbR;
        }
        state.busses.push_back(std::move(br));
    }

    // Signal-flow diagram data: a direct projection of the graph the audio
    // thread is rendering right now. Deliberately a copy of the engine's own
    // structure rather than a re-derivation -- the whole value of the diagram
    // is that it cannot disagree with what you hear.
    state.mixGraph.strips.clear();
    state.mixGraph.edges.clear();
    if (const auto graph = engine.mixGraph()) {
        state.mixGraph.strips.reserve(graph->strips.size());
        for (const MixStrip& strip : graph->strips) {
            WebUiState::MixGraphRow::StripRow row;
            row.id = strip.id;
            row.name = strip.name;
            row.kind = stripKindName(strip.kind);
            row.soloGroup = soloGroupName(strip.soloGroup);
            row.channels = strip.channels;
            // The graph stores linear gain; the diagram labels dB like every
            // other surface does.
            row.gainDb = strip.gainLinear > 0.0f
                             ? 20.0 * std::log10(static_cast<double>(strip.gainLinear))
                             : -144.0;
            row.pan = strip.pan;
            row.mute = strip.mute;
            row.solo = strip.solo;
            row.soloSafe = strip.soloSafe;
            row.audible = strip.audible;
            row.physicalChannel = strip.physicalChannel;
            // Live level, so the diagram shows which paths are actually
            // carrying signal rather than only how they are wired.
            if (strip.kind == StripKind::Click) {
                row.peakDb = state.clickPeakDb;
            } else if (strip.kind == StripKind::Track) {
                if (strip.projectIndex < state.tracks.size())
                    row.peakDb = state.tracks[strip.projectIndex].peakDb;
            } else {
                for (const auto& bus : state.busses) {
                    if (bus.id == strip.id) {
                        row.peakDb = bus.peakDb;
                        break;
                    }
                }
            }
            state.mixGraph.strips.push_back(std::move(row));
        }
        state.mixGraph.edges.reserve(graph->edges.size());
        for (const MixEdge& edge : graph->edges) {
            if (edge.from >= graph->strips.size() || edge.to >= graph->strips.size())
                continue;
            WebUiState::MixGraphRow::EdgeRow row;
            row.from = graph->strips[edge.from].id;
            row.to = graph->strips[edge.to].id;
            row.level = static_cast<double>(edge.gainLinear) * 100.0;
            row.preFader = edge.preFader;
            row.active = edge.active;
            row.sourceChannel = edge.sourceChannel;
            state.mixGraph.edges.push_back(std::move(row));
        }
    }

    state.lighting.enabled = proj.lighting.enabled;
    state.lighting.kind = lightingKindToString(proj.lighting.kind);
    state.lighting.resolight.columns = proj.lighting.resolight.columns;
    state.lighting.resolight.rows = proj.lighting.resolight.rows;
    state.lighting.idle.behavior = proj.lighting.idle.behavior;
    state.lighting.idle.color.r = proj.lighting.idle.color.r;
    state.lighting.idle.color.g = proj.lighting.idle.color.g;
    state.lighting.idle.color.b = proj.lighting.idle.color.b;
    state.lighting.idle.intensity = proj.lighting.idle.intensity;
    state.lighting.idle.effect.type = proj.lighting.idle.effect.type;
    state.lighting.idle.effect.rateHz = proj.lighting.idle.effect.rateHz;
    state.lighting.idle.gradient.preset = proj.lighting.idle.gradient.preset;
    state.lighting.idle.gradient.colors = proj.lighting.idle.gradient.colors.value_or("");
    state.lighting.defaultRefreshRateHz = proj.lighting.defaultRefreshRateHz;
    state.lighting.fixtures.reserve(proj.lighting.fixtures.size());
    for (const LightFixture& f : proj.lighting.fixtures) {
        WebUiState::LightFixtureRow fr;
        fr.id = f.id;
        fr.name = f.name;
        fr.kind = lightFixtureKindToString(f.kind);
        fr.grid.column = f.grid.column;
        fr.grid.row = f.grid.row;
        fr.ledCount = f.ledCount;
        fr.addressable = f.addressable;
        fr.position.x = f.position.x;
        fr.position.y = f.position.y;
        fr.position.z = f.position.z;
        fr.rotation.y = f.rotation.y;
        fr.mountedHorizontally = f.mountedHorizontally;
        fr.dmx.universe = f.dmx.universe;
        fr.dmx.startChannel = f.dmx.startChannel;
        fr.dmx.channelCount = f.dmx.channelCount;
        fr.shape = f.shape;
        fr.matrixColumns = f.matrixColumns;
        fr.channelProfile = f.channelProfile;
        fr.tiltDegrees = f.tiltDegrees;
        fr.refreshRateHz = f.refreshRateHz;
        fr.networkHost = f.networkHost.value_or("");
        if (f.networkHost.has_value() && !f.networkHost->empty()) {
            const auto link = engine.lightHardware().fixtureLinkStatus(f.id);
            fr.hwConfigured = link.configured;
            fr.hwConnected = link.connected;
            fr.hwRssiDbm = link.rssiDbm;
            fr.hwChipType = link.chipType;
        }
        state.lighting.fixtures.push_back(std::move(fr));
    }
    state.lighting.artNetTargetHost = proj.lighting.artNetTargetHost.value_or("");
    {
        const auto boards = engine.lightHardware().discoveredBoards();
        state.lighting.discoveredBoards.reserve(boards.size());
        for (const auto& b : boards) {
            WebUiState::DiscoveredBoardRow row;
            row.mac = b.mac;
            row.ip = b.ip;
            row.name = b.name;
            row.chipType = b.chipType;
            row.lastSeenSecondsAgo = b.lastSeenSecondsAgo;
            state.lighting.discoveredBoards.push_back(std::move(row));
        }
    }

    state.lighting.tracks.reserve(proj.lighting.tracks.size());
    for (const LightTrack& lt : proj.lighting.tracks) {
        WebUiState::LightingRow::LightTrackRow ltr;
        ltr.id = lt.id;
        ltr.name = lt.name;
        ltr.fixtureIds = lt.fixtureIds;
        state.lighting.tracks.push_back(std::move(ltr));
    }

    // Backend-authoritative resolved lamp state -- the exact same
    // engine/lighting/LightOutputResolver.h call LightEngine's real-time DMX
    // thread makes, so the live preview can never drift from what the real
    // hardware is doing (see RESTORE_POINT.md Feature 6's sync fix).
    if (proj.lighting.enabled && state.songIndex >= 0
        && static_cast<size_t>(state.songIndex) < proj.songs.size()) {
        const SongDef& activeSong = proj.songs[static_cast<size_t>(state.songIndex)];
        const auto& allTracks = proj.tracks;
        const auto sourceLevelDb = [this, &allTracks](const std::string& type, const std::string& id) -> SourceLevels {
            const auto toLevels = [](const MeterFrame& f) {
                SourceLevels lv;
                lv.peakDb = f.peakDb;
                for (int b = 0; b < kLightBandCount; ++b)
                    lv.bandLevel[b] = f.bandLevel[b];
                return lv;
            };
            if (type == "track") {
                for (size_t i = 0; i < allTracks.size(); ++i) {
                    if (allTracks[i].id != id)
                        continue;
                    if (const auto* m = engine.trackMeterAt(i)) {
                        MeterFrame f;
                        if (m->read(f))
                            return toLevels(f);
                    }
                    break;
                }
                return SourceLevels{};
            }
            for (size_t i = 0; i < engine.busCount(); ++i) {
                if (!id.empty() && engine.busIdAt(i) != id)
                    continue;
                if (id.empty() && i != 0)
                    continue; // empty id = master mix / first bus
                if (const auto* m = engine.busMeterAt(i)) {
                    MeterFrame f;
                    if (m->read(f))
                        return toLevels(f);
                }
                break;
            }
            return SourceLevels{};
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

        // Apply the same idle-behavior override LightEngine's real DMX thread
        // applies: while the transport is stopped with a non-"hold"
        // idleBehavior (blackout/staticColor/effect), the whole preview feed
        // fades to/from the idle target via the shared blendTowardIdle +
        // kIdleFadeSeconds, exactly like the hardware -- resuming playback
        // fades just as smoothly back out of it. This preview feed drives
        // every light preview in the SPA (Light tab, Editor's Light-mode,
        // wherever) -- the frontend draws the backend-rendered per-LED rows
        // as-is and never re-simulates idle behavior client-side anymore.
        const bool useIdleOverride = !state.playing && proj.lighting.idle.behavior != "hold";

        // Mirror of LightEngine's transition bookkeeping -- see threadLoop.
        // Each transition fires once (edge-triggered): leaving idle keys on
        // wasIdleFading only, never on an already-active resume fade, or the
        // resume fade-out would restart every frame and never progress.
        if (useIdleOverride && !lightingPreviewWasIdleFading && !lightingPreviewWasResumeFading) {
            // Fresh entry into idle (transport just stopped) -- start the
            // fade from the last pre-idle resolve, same as the DMX thread.
            lightingPreviewIdleFadeStart = std::chrono::steady_clock::now();
            lightingPreviewWasIdleFading = true;
        } else if (lightingPreviewWasResumeFading && useIdleOverride) {
            lightingPreviewLastResolved = lightingPreviewLastFrame;
            lightingPreviewIdleFadeStart = std::chrono::steady_clock::now();
            lightingPreviewWasResumeFading = false;
            lightingPreviewWasIdleFading = true;
        } else if (!useIdleOverride && lightingPreviewWasIdleFading) {
            lightingPreviewResumeFrom = lightingPreviewLastFrame;
            lightingPreviewResumeFadeStart = std::chrono::steady_clock::now();
            lightingPreviewWasResumeFading = true;
            lightingPreviewWasIdleFading = false;
        }

        // When a fade is genuinely in progress (0 < blendT < 1), these mirror
        // LightEngine::threadLoop's blendFrom/blendTo/blendT so the per-LED
        // preview loop below can crossfade each LED individually instead of
        // rendering the pre-blended aggregate `resolved` -- keeps the web
        // preview's per-pixel look identical to the real DMX output during
        // idle transitions (see resolveLedWireColorsBlended's doc comment).
        std::vector<ResolvedFixtureOutput> resolved;
        std::vector<ResolvedFixtureOutput> blendFrom;
        std::vector<ResolvedFixtureOutput> blendTo;
        double blendT = 1.0;
        if (lightingPreviewWasResumeFading) {
            // Fading back from idle to the normal cue resolve. Fixtures the
            // idle state turned on but that no cue drives anymore get an
            // explicit off-row so they fade to black instead of snapping.
            auto normal = resolveLightOutputs(
                proj.lighting.tracks, activeSong.lightCues, livePlayheadSec, activeSong.bpm, sourceLevelDb);
            const double t = std::chrono::duration<double>(
                                 std::chrono::steady_clock::now() - lightingPreviewResumeFadeStart)
                                 .count() /
                             kResumeFadeSeconds;
            if (t >= 1.0) {
                resolved = std::move(normal);
                lightingPreviewWasResumeFading = false;
            } else {
                for (const auto& rf : lightingPreviewResumeFrom) {
                    bool found = false;
                    for (const auto& n : normal)
                        if (n.fixtureId == rf.fixtureId) { found = true; break; }
                    if (!found) {
                        ResolvedFixtureOutput stub;
                        stub.fixtureId = rf.fixtureId;
                        normal.push_back(std::move(stub));
                    }
                }
                resolved = blendTowardIdle(lightingPreviewResumeFrom, normal, t);
                blendFrom = lightingPreviewResumeFrom;
                blendTo = normal;
                blendT = t;
            }
            lightingPreviewLastResolved = resolved;
        } else if (lightingPreviewWasIdleFading) {
            // Fading into (and then sustaining) the idle target. effectPhase
            // is wall-clock seconds since the fade began -- consumed by the
            // "effect" idle mode so the effect animates while stopped.
            const double effectPhase = std::chrono::duration<double>(
                                           std::chrono::steady_clock::now() - lightingPreviewIdleFadeStart)
                                           .count();
            const auto target = buildIdleTarget(proj.lighting.fixtures, proj.lighting.idle.behavior,
                                                proj.lighting.idle.color.r, proj.lighting.idle.color.g,
                                                proj.lighting.idle.color.b, proj.lighting.idle.intensity,
                                                proj.lighting.idle.effect.type, proj.lighting.idle.effect.rateHz,
                                                proj.lighting.idle.gradient.preset, proj.lighting.idle.gradient.colors.value_or(""),
                                                effectPhase);
            const double t = effectPhase / kIdleFadeSeconds;
            resolved = blendTowardIdle(lightingPreviewLastResolved, target, t);
            if (t < 1.0) {
                blendFrom = lightingPreviewLastResolved;
                blendTo = target;
                blendT = t;
            }
        } else {
            resolved = resolveLightOutputs(
                proj.lighting.tracks, activeSong.lightCues, livePlayheadSec, activeSong.bpm, sourceLevelDb);
            lightingPreviewLastResolved = resolved;
        }
        lightingPreviewLastFrame = resolved;

        // Fixture id -> project fixture array index, the wire key the binary
        // per-LED stream uses so the frontend can map colors back to its own
        // lighting.fixtures array without shipping ids every frame.
        std::map<std::string, int> fixtureIndex;
        for (size_t fi = 0; fi < proj.lighting.fixtures.size(); ++fi)
            fixtureIndex[proj.lighting.fixtures[fi].id] = static_cast<int>(fi);

        // Only built when a fade is actually in progress -- see blendFrom's
        // doc comment above. `blendTo`/`resolved` share the same fixture
        // order (both derived by iterating the same "to" vector inside
        // blendTowardIdle); only the "from" side needs a lookup by id since
        // a fixture can be absent from it.
        std::map<std::string, const ResolvedFixtureOutput*> blendFromById;
        const bool blendActive = !blendFrom.empty() || !blendTo.empty();
        if (blendActive)
            for (const auto& f : blendFrom)
                blendFromById[f.fixtureId] = &f;

        state.lightOutput.reserve(resolved.size());
        for (size_t ri = 0; ri < resolved.size(); ++ri) {
            const auto& r = resolved[ri];
            WebUiState::LightOutputRow lor;
            lor.fixtureId = r.fixtureId;
            lor.fixtureIdx = fixtureIndex[r.fixtureId]; // -1 if missing from the rig
            if (lor.fixtureIdx >= 0) {
                const auto& fixture = proj.lighting.fixtures[static_cast<size_t>(lor.fixtureIdx)];
                std::vector<LedWireColor> wire;
                if (blendActive) {
                    static const ResolvedFixtureOutput kBlackFallback{};
                    const ResolvedFixtureOutput* fromEntry = &kBlackFallback;
                    if (auto it = blendFromById.find(r.fixtureId); it != blendFromById.end())
                        fromEntry = it->second;
                    wire = resolveLedWireColorsBlended(*fromEntry, blendTo[ri], fixture, blendT);
                } else {
                    wire = resolveLedWireColors(r, fixture);
                }
                lor.ledColors.reserve(wire.size());
                for (const auto& c : wire) {
                    // The preview has no separate white channel to render --
                    // add w back into r/g/b (real RGBW hardware's white diode
                    // visually brightens/desaturates the same way) so an
                    // "rgbw" fixture doesn't preview as near-black just
                    // because most of a white cue color got routed onto the
                    // W wire instead of R/G/B.
                    const int r2 = std::min(255, static_cast<int>(c.r) + c.w);
                    const int g2 = std::min(255, static_cast<int>(c.g) + c.w);
                    const int b2 = std::min(255, static_cast<int>(c.b) + c.w);
                    lor.ledColors.push_back({r2, g2, b2});
                }
            }
            state.lightOutput.push_back(std::move(lor));
        }
    }

    state.cpuPercent = health.totalCpuPercent;
    state.rssBytes = health.totalRssBytes;
    state.freeBytes = health.systemFreeBytes;
    state.systemTotalBytes = health.systemTotalBytes;
    state.cpuCoreCount = health.cpuCoreCount;
    state.underrunCount = health.underrunCount;
    state.audioCallbackCount = health.audioCallbackCount;
    state.silentBlockCount = health.silentBlockCount;
    state.pitchBlockCount = health.pitchBlockCount;
    // Sourced from the streaming layer rather than SystemHealth so telemetry/
    // keeps no dependency on audio/.
    state.streamStarveCount = engine.streamStarveCount();
    {
        const auto cb = engine.callbackTimingSnapshot();
        state.callbackWorstRatio = cb.worstRatio;
        state.callbackWorstMs = cb.worstWallMs;
        state.callbackWorstCpuShare = cb.worstCpuShare;
        state.callbackComputeStalls = cb.computeStalls;
        state.callbackPreemptedStalls = cb.preemptedStalls;
        state.callbackOverruns = cb.buckets[static_cast<size_t>(CallbackBucket::Over100)];
    }
    state.outputLatencySamples = static_cast<int>(engine.outputLatencySamples());
    state.outputLatencyMs = engine.outputLatencySeconds() * 1000.0;
    state.hostTimeSkewMs = static_cast<double>(engine.hostTimeSkew()) / 1.0e6;
    // A throttled laptop is the one cause of a dropout that every other number
    // here reports as healthy. See platform/ThermalState.h.
    state.thermalState = thermalStateName(currentThermalState());
    state.diskReadBytesPerSec = health.diskReadBytesPerSec;
    state.diskWriteBytesPerSec = health.diskWriteBytesPerSec;
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
