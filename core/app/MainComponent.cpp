#include "MainComponent.h"
#include "lighting/LightOutputResolver.h"
#include "platform/MacShellMode.h"
#include "platform/TrayIcon.h"
#include "project/ProjectJson.h"
#include "timing/BarSeek.h"
#include "ui/UiColors.h"
#include "web/BuilderJson.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <vector>

namespace resostage {

MainComponent::MainComponent() {
#if JUCE_MAC
    // No Dock icon ever, for any launch mode (see LSUIElement in
    // Info.plist.in) -- a runtime setActivationPolicy call here would be too
    // late, macOS already registered the Dock icon before our own code runs.
    // When Electron spawned us as its nested backend specifically, give the
    // user a menu-bar way to see/quit the backend instead.
    if (std::getenv("RESOSTAGE_SPAWNED_BY_SHELL") != nullptr) {
        trayIcon = std::make_unique<TrayIcon>([] {
            juce::JUCEApplication::getInstance()->systemRequestedQuit();
        });
    }
#endif

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

    // Start with a real, empty, editable project rather than a "load
    // something first" placeholder -- SPA Builder is immediately usable.
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
    webServer.addWebRoot(juce::File::getSpecialLocation(juce::File::currentApplicationFile)
                             .getChildFile("Contents/Resources/web")
                             .getFullPathName()
                             .toStdString());
    webServer.addWebRoot(juce::File::getCurrentWorkingDirectory()
                             .getChildFile("ui/dist")
                             .getFullPathName()
                             .toStdString());

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

    // The Core is headless: the on-screen UI comes from the engine chosen in
    // Settings -- the Electron shell (window/menu/Touch Bar) or the default
    // browser tab. Either way the JUCE window backs off to an accessory
    // process that keeps serving the backend (audio / lighting / WebServer).
    //
    // Exception: the shipped bundle nests this Core.app inside the Electron
    // shell's own .app (Contents/Resources/) and Electron is what the user
    // actually launches -- it spawns THIS process as its backend, setting
    // RESOSTAGE_SPAWNED_BY_SHELL so we don't try to *also* spawn a shell of
    // our own (which would be circular) or pop open a browser tab. This
    // never overrides the flag for standalone/dev launches of this .app.
    const bool spawnedByShell = std::getenv("RESOSTAGE_SPAWNED_BY_SHELL") != nullptr;
    if (spawnedByShell) {
        juce::MessageManager::callAsync([this] {
            if (auto* tl = getTopLevelComponent())
                tl->setVisible(false);
#if JUCE_MAC
            backOffToHeadlessShell();
#endif
        });
    } else if (appSettings.uiRenderEngine == "electron") {
        launchElectronShell();
    } else {
        launchBrowserTab();
    }

    setWantsKeyboardFocus(true);
    setSize(1280, 800);

    // Match WebServer::kTelemetryHz (60).
    startTimerHz(WebServer::kTelemetryHz);
}

MainComponent::~MainComponent() {
    stopTimer();
    // In electron mode the shell is our on-screen window -- kill it first so
    // quitting ResoStage never strands a visible shell with no backend.
    terminateElectronShell();
    webServer.stop();
}

// ── Electron shell mode ──────────────────────────────────────────────────
// Settings > UI = "electron" routes the on-screen window through the
// Electron shell (electron/ in the repo root) instead of a plain browser
// tab. The shell talks to the same backend (REST + WS on kWebPort) any
// remote browser tab would, builds its native menu bar / Touch Bar from
// GET /api/v1/ui/menu (the same MenuModel table the AppKit menu used), and
// dispatches menu clicks via POST /api/v1/action (PerformAction →
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
    args.add("--backend-port=" + juce::String(kWebPort));

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
    // Drop out of the foreground once the shell is up: hide the JUCE window
    // and remove us from the Dock so Electron is the only visible ResoStage.
    juce::MessageManager::callAsync([this] {
        if (auto* tl = getTopLevelComponent())
            tl->setVisible(false);
#if JUCE_MAC
        backOffToHeadlessShell();
#endif
    });
}

void MainComponent::terminateElectronShell() {
    if (electronProcess == nullptr)
        return;
    if (electronProcess->isRunning())
        electronProcess->kill();
    electronProcess.reset();
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

    juce::MessageManager::callAsync([this] {
        if (auto* tl = getTopLevelComponent())
            tl->setVisible(false);
#if JUCE_MAC
        backOffToHeadlessShell();
#endif
    });
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
    busyOverlay.setBounds(getLocalBounds());
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
    else if (action == "import_song_folder")
        importSongFolderNative();
    else if (action == "clear_recent_projects") {
        appSettings.recentProjects.clear();
        saveAppSettingsToDisk();
        publishWebState();
    }
    else if (action == "quit") {
        // Native menu bar intercepts "quit" in Main.cpp before reaching us;
        // this branch covers the Electron shell (POST /api/v1/action) and any
        // MIDI/hotkey mapping -- same unsaved-changes prompt either way.
        confirmQuitIfUnsaved([](bool canQuit) {
            if (canQuit)
                juce::JUCEApplication::quit();
        });
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
        confirmQuitIfUnsaved([](bool canQuit) {
            if (canQuit)
                juce::JUCEApplication::quit();
        });
    }
    else if (action.rfind("open_recent:", 0) == 0) {
        const std::string path = action.substr(std::string("open_recent:").size());
        if (!loadProjectFromPath(juce::File(path))) {
            // Stale entry -- the file moved/was deleted since it was recorded.
            removeRecentProject(appSettings.recentProjects, path);
            saveAppSettingsToDisk();
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
            case WebCommandKind::SetSampleRate: settingsSetSampleRate(cmd.json); break;
            case WebCommandKind::SetBufferSize: settingsSetBufferSize(cmd.json); break;
            case WebCommandKind::SetMidiOutput: settingsSetMidiOutput(cmd.json); break;
            case WebCommandKind::SetMidiInput: settingsSetMidiInput(cmd.json); break;
            case WebCommandKind::SetMidiVirtualPort: settingsSetMidiVirtualPort(cmd.json); break;
            case WebCommandKind::SetUiRenderEngine: settingsSetUiRenderEngine(cmd.json); break;
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
            case WebCommandKind::PerformAction: {
                // From the Electron shell's native menu (and anything else
                // that wants the generic menu/hotkey path over HTTP). cmd.json
                // carries {"action":"..."} -- same performAction() every
                // native hotkey / menu bar item funnels through.
                static simdjson::dom::parser parser;
                simdjson::dom::element doc;
                std::string action;
                if (!parser.parse(cmd.json).get(doc)
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
    state.lighting.idleBehavior = proj.lighting.idleBehavior;
    state.lighting.idleColorR = proj.lighting.idleColorR;
    state.lighting.idleColorG = proj.lighting.idleColorG;
    state.lighting.idleColorB = proj.lighting.idleColorB;
    state.lighting.idleIntensity = proj.lighting.idleIntensity;
    state.lighting.idleEffectType = proj.lighting.idleEffectType;
    state.lighting.idleEffectRateHz = proj.lighting.idleEffectRateHz;
    state.lighting.idleGradientPreset = proj.lighting.idleGradientPreset;
    state.lighting.idleGradientColors = proj.lighting.idleGradientColors;
    state.lighting.defaultRefreshRateHz = proj.lighting.defaultRefreshRateHz;
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
        fr.shape = f.shape;
        fr.matrixCols = f.matrixCols;
        fr.channelProfile = f.channelProfile;
        fr.tiltDeg = f.tiltDeg;
        fr.refreshRateHz = f.refreshRateHz;
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
        const auto sourceLevelDb = [this, &allTracks, &proj](const std::string& type, const std::string& id) -> SourceLevels {
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
            for (size_t i = 0; i < proj.busses.size(); ++i) {
                if (!id.empty() && proj.busses[i].id != id)
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
        // applies: while the transport is stopped with a non-"holdLast"
        // idleBehavior (blackout/staticColor/effect), the whole preview feed
        // fades to/from the idle target via the shared blendTowardIdle +
        // kIdleFadeSeconds, exactly like the hardware -- resuming playback
        // fades just as smoothly back out of it. This preview feed drives
        // every light preview in the SPA (Light tab, Editor's Light-mode,
        // wherever) -- the frontend draws the backend-rendered per-LED rows
        // as-is and never re-simulates idle behavior client-side anymore.
        const bool useIdleOverride = !state.playing && proj.lighting.idleBehavior != "holdLast";

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
                proj.lightTracks, activeSong.lightCues, livePlayheadSec, activeSong.bpm, sourceLevelDb);
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
                    if (!found)
                        normal.push_back(ResolvedFixtureOutput{rf.fixtureId});
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
            const auto target = buildIdleTarget(proj.lighting.fixtures, proj.lighting.idleBehavior,
                                                proj.lighting.idleColorR, proj.lighting.idleColorG,
                                                proj.lighting.idleColorB, proj.lighting.idleIntensity,
                                                proj.lighting.idleEffectType, proj.lighting.idleEffectRateHz,
                                                proj.lighting.idleGradientPreset, proj.lighting.idleGradientColors,
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
                proj.lightTracks, activeSong.lightCues, livePlayheadSec, activeSong.bpm, sourceLevelDb);
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
