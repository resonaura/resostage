/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Media-import Builder commands. Legacy API action names remain compatible.
#include "MainComponent.h"
#include "engine/AudioEngineInternal.h"
#include "project/ProjectJson.h"
#include "project/RouteId.h"
#include "server/BuilderJson.h"

#if JUCE_WINDOWS
#include <windows.h>
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace resostage {

using namespace builder_json;

namespace {
struct UploadedMediaCleanup {
    juce::File file;
    ~UploadedMediaCleanup() { file.deleteFile(); }
};
} // namespace

void MainComponent::builderTrackImportWAVUpload(int songIndex, int trackIndex, const std::string& tempWavPath,
                                                double startSeconds, const std::string& requestId) {
    if (songIndex < 0 || trackIndex < 0) {
        std::remove(tempWavPath.c_str());
        setStatus("Import failed: no target track");
        webServer.finishTrackImport(requestId, false, "No target track");
        return;
    }
    // AudioEngine validates the target before auto-creating a package. Do not
    // save an empty document merely because an invalid upload was received.
    const auto sIdx = static_cast<size_t>(songIndex);
    const auto tIdx = static_cast<size_t>(trackIndex);
    const juce::Component::SafePointer<MainComponent> safeThis(this);
    // The upload belongs to this operation, including cancellation during
    // Core shutdown where its queued completion deliberately never runs.
    auto upload = std::make_shared<UploadedMediaCleanup>();
    upload->file = juce::File(juce::String::fromUTF8(tempWavPath.c_str()));
    engine.importWavForTrackAsync(sIdx, tIdx, tempWavPath, [safeThis, upload, requestId](bool ok, std::string error) {
        if (safeThis == nullptr)
            return;
        safeThis->webServer.finishTrackImport(requestId, ok, error);
        if (!ok) {
            safeThis->setStatus("Import failed: " + juce::String(error));
            return;
        }
        safeThis->notifyProjectStructureChanged();
        safeThis->setStatus("Media imported");
    }, startSeconds);
}

void MainComponent::builderTrackImportWAVDialog(const std::string& json) {
    if (!engine.isProjectLoaded())
        return;
    glz::generic doc;
    int songIndex = -1, trackIndex = -1;
    if (parseJson(json, doc)) {
        getInt(doc, "songIndex", songIndex);
        getInt(doc, "index", trackIndex);
    }
    if (songIndex < 0 || trackIndex < 0)
        return;

    // Native OS picker -- only reachable from the embedded webview (the
    // plain-browser timeline keeps its own <input type=file> fallback, see
    // AudioTrackLanes.tsx). The picked file imports straight from disk, no
    // upload round-trip. importWavForTrackAsync auto-creates a default
    // archive if the project was never saved, so no extra guard needed here.
#if JUCE_WINDOWS
    ::AllowSetForegroundWindow(ASFW_ANY);
#endif
    fileChooser = std::make_unique<juce::FileChooser>(
        "Open Audio or Video File", juce::File(),
        "*.wav;*.wave;*.aiff;*.aif;*.aifc;*.mp3;*.flac;*.ogg;*.oga;*.m4a;*.aac;*.opus;*.wma;*.caf;"
        "*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v;*.mpeg;*.mpg;*.mts;*.m2ts;*.ts;*.flv;*.wmv;*.3gp;*.mxf;*.ogv;*.vob;*.asf;*.dv");
    const auto browserFlags = juce::FileBrowserComponent::openMode
                               | juce::FileBrowserComponent::canSelectFiles;
    const auto sIdx = static_cast<size_t>(songIndex);
    const auto tIdx = static_cast<size_t>(trackIndex);
    const juce::Component::SafePointer<MainComponent> safeThis(this);
    fileChooser->launchAsync(browserFlags, [safeThis, sIdx, tIdx](const juce::FileChooser& fc) {
        if (safeThis == nullptr)
            return;
        const auto file = fc.getResult();
        if (file == juce::File() || !file.existsAsFile())
            return;
        safeThis->engine.importWavForTrackAsync(sIdx, tIdx, file.getFullPathName().toStdString(),
                                      [safeThis](bool ok, std::string error) {
            if (safeThis == nullptr)
                return;
            if (!ok) {
                safeThis->setStatus("Import failed: " + juce::String(error));
                return;
            }
            safeThis->notifyProjectStructureChanged();
            safeThis->setStatus("Media imported");
        });
    });
}

} // namespace resostage
