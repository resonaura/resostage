/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Project lifecycle, file I/O orchestration, and native project dialogs.
// State mutations continue to use AudioEngine's project APIs on the JUCE
// message thread; asynchronous file workers remain owned by AudioEngine.

#include "MainComponent.h"
#include "engine/AudioEngineInternal.h"
#include "BinaryData.h"
#include "project/ProjectJson.h"

#if JUCE_WINDOWS
#include <windows.h>
#endif

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace resostage {

void MainComponent::openRecentProjectFromPath(const std::string& path) {
    if (!juce::File(path).exists()) {
        removeRecentProject(appSettings.recentProjects, path);
        saveAppSettingsToDisk();
        setStatus("Project not found: " + juce::String(path));
        publishWebState();
        return;
    }
    openProjectFromIpc(path);
}

void MainComponent::openProjectFromIpc(const std::string& path) {
    if (engine.isBusy()) {
        setStatus("Project operation in progress; retry opening after it finishes");
        publishWebState();
        return;
    }

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
        if (awaitingOpenDecision) {
            // Keep the first destination bound to the visible confirmation.
            // Silently replacing it would make the user's answer apply to a
            // different request than the one they saw; silently ignoring it
            // gives no feedback when two open requests arrive close together.
            setStatus("Resolve the current project-open prompt before opening another project");
            publishWebState();
            return;
        }
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
        // Keep native file-picker opens on the same unsaved-change path as
        // externally requested and recent-project opens.
        openProjectFromIpc(file.getFullPathName().toStdString());
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
    ++projectEpoch_;
    if (projectEpoch_ == 0)
        ++projectEpoch_;
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
