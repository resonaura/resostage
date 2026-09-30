// Electron/browser shell lifecycle and the platform-specific process bridge.
// These methods only manage the presentation shell; Core remains the
// authoritative playback process.

#include "MainComponent.h"
#include "platform/PlatformShellMode.h"

#include <cstdlib>

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

namespace resostage {

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

} // namespace resostage

