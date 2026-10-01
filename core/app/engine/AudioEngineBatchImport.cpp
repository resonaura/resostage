/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Batch WAV-stem import for AudioEngine. The background worker stream-copies
// audio and prepares peaks; the shared finishAsyncImport path reopens and
// restages the archive on the message thread.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"

#include "../media/WAVBatchImport.h"

#include <exception>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace resostage {

void AudioEngine::importSongStemsBatchAsync(size_t songIndex, const std::vector<BatchItem>& items,
                                            std::function<void(bool, std::string)> onComplete) {
    auto fail = [&onComplete](std::string msg) {
        if (onComplete)
            onComplete(false, std::move(msg));
    };

    if (items.empty() || items.size() > media::kMaximumWAVBatchFiles) {
        fail("A stem batch must contain between 1 and 256 files");
        return;
    }

    if (isBusy()) {
        fail("Project operation already in progress");
        return;
    }
    if (importThread.joinable())
        importThread.join();
    if (pendingFinishImport) {
        auto fn = std::move(pendingFinishImport);
        pendingFinishImport = nullptr;
        fn();
    }
    if (songIndex >= loader.project().songs.size()) {
        fail("Invalid stem import song");
        return;
    }
    std::unordered_set<size_t> targetTracks;
    for (const auto& item : items) {
        if (item.trackIndex >= loader.project().tracks.size()
            || !targetTracks.insert(item.trackIndex).second) {
            fail("Stem import requires distinct valid target tracks");
            return;
        }
    }
    if (!loader.isOpen() || loader.archivePath().empty()) {
        // Never replace an authored unsaved document with newProject merely
        // to give its imported stems a package to live in.
        std::string error;
        const auto projectDirectory = juce::File::getSpecialLocation(juce::File::userHomeDirectory)
            .getChildFile("Documents").getChildFile("ResoSet_Projects");
        projectDirectory.createDirectory();
        const auto defaultPath = projectDirectory.getChildFile("UntitledProject.rsnraset")
            .getFullPathName().toStdString();
        if (!saveProject(defaultPath, error)) {
            fail("Failed to auto-create project archive: " + error);
            return;
        }
    }

    const Project projectBefore = loader.project();
    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    stop();
    joinPendingPeakBuilds();
    streaming.stop();

    const std::string archivePath = loader.archivePath();
    const std::string tempOut = loader.isDirectoryContainer() ? archivePath : archivePath + ".new";
    busyImporting.store(true, std::memory_order_release);
    cancelImport.store(false, std::memory_order_release);

    importThread = std::thread([this, songIndex, items, archivePath, tempOut, projectBefore,
                               songToRestore, wasPlaying, onComplete]() mutable {
        std::string error;
        bool allOk = false;
        try {
            std::vector<media::WAVStemImportItem> preparedItems;
            preparedItems.reserve(items.size());
            for (const auto& item : items)
                preparedItems.push_back({item.trackIndex, item.filesystemPath});
            std::vector<std::pair<std::string, PeakOverview>> committedPeaks;
            allOk = media::writeWAVStemBatch(loader, projectBefore, songIndex, preparedItems,
                                           tempOut, &cancelImport, committedPeaks, error);
            if (allOk) {
                for (auto& [entry, overview] : committedPeaks)
                    cachePeakOverview(entry, std::move(overview));
            }
        } catch (const std::exception& exception) {
            error = "Stem import worker failed: " + std::string(exception.what());
        } catch (...) {
            error = "Stem import worker failed with an unexpected error";
        }

        auto finishFn = [this, allOk, error, archivePath, tempOut, projectBefore,
                         songToRestore, wasPlaying, onComplete]() {
            finishAsyncImport(allOk, error, tempOut, archivePath, songToRestore, wasPlaying,
                [this, projectBefore, onComplete](bool ok, std::string message) {
                    if (ok) {
                        projectHistory.beginEdit(projectBefore, "", "Import stem batch");
                        projectHistory.commitEdit(loader.project());
                    }
                    if (onComplete)
                        onComplete(ok, std::move(message));
                });
        };
        pendingFinishImport = finishFn;

        juce::MessageManager::callAsync([this, lifetime = importCallbackLifetime]() {
            if (!lifetime->load(std::memory_order_acquire))
                return;
            if (pendingFinishImport) {
                auto fn = std::move(pendingFinishImport);
                pendingFinishImport = nullptr;
                fn();
            }
        });
    });
}

} // namespace resostage
