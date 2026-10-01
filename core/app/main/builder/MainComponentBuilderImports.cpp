// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

// WAV-import Builder commands.
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

void MainComponent::builderTrackImportWavUpload(int songIndex, int trackIndex, const std::string& tempWavPath,
                                                double startSeconds) {
    if (songIndex < 0 || trackIndex < 0) {
        std::remove(tempWavPath.c_str());
        setStatus("Import failed: no target track");
        return;
    }
    if (engine.projectPath().empty()) {
        std::string err;
        const auto docDir = juce::File::getSpecialLocation(juce::File::userHomeDirectory).getChildFile("Documents").getChildFile("ResoSet_Projects");
        docDir.createDirectory();
        const std::string defaultPath = docDir.getChildFile("UntitledProject.rsnraset").getFullPathName().toStdString();
        if (!engine.saveProject(defaultPath, err)) {
            std::remove(tempWavPath.c_str());
            setStatus("Import failed: could not auto-create project archive (" + juce::String(err) + ")");
            return;
        }
    }

    const auto sIdx = static_cast<size_t>(songIndex);
    const auto tIdx = static_cast<size_t>(trackIndex);
    engine.importWavForTrackAsync(sIdx, tIdx, tempWavPath, [this, tempWavPath](bool ok, std::string error) {
        std::remove(tempWavPath.c_str());
        if (!ok) {
            setStatus("Import failed: " + juce::String(error));
            return;
        }
    notifyProjectStructureChanged();
        setStatus("WAV imported");
    }, startSeconds);
}

void MainComponent::builderTrackImportWavDialog(const std::string& json) {
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
        "Open Audio File", juce::File(),
        "*.wav;*.wave;*.aiff;*.aif;*.mp3;*.flac;*.ogg;*.m4a;*.aac;*.opus;*.wma;*.caf");
    const auto browserFlags = juce::FileBrowserComponent::openMode
                               | juce::FileBrowserComponent::canSelectFiles;
    const auto sIdx = static_cast<size_t>(songIndex);
    const auto tIdx = static_cast<size_t>(trackIndex);
    fileChooser->launchAsync(browserFlags, [this, sIdx, tIdx](const juce::FileChooser& fc) {
        const auto file = fc.getResult();
        if (file == juce::File() || !file.existsAsFile())
            return;
        engine.importWavForTrackAsync(sIdx, tIdx, file.getFullPathName().toStdString(),
                                      [this](bool ok, std::string error) {
            if (!ok) {
                setStatus("Import failed: " + juce::String(error));
                return;
            }
            notifyProjectStructureChanged();
            setStatus("Audio imported");
        });
    });
}

} // namespace resostage

