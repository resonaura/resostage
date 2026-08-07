// Peak overview build/cache for AudioEngine (timeline waveforms).
// Background PeakBuildThreadPool work + session/on-disk PeakCache.
// Kept in its own translation unit so AudioEngine.cpp doesn't balloon.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"

#include "audio/PeakCache.h"

#include <algorithm>
#include <chrono>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>


namespace resostage {


const PeakOverview* AudioEngine::trackPeaksAt(size_t index) const {
    if (index >= trackPeaks.size())
        return nullptr;
    return &trackPeaks[index];
}

void AudioEngine::joinPendingPeakBuilds() {
    // Busy-wait rather than a condition variable: this is only called from
    // rare, deliberate actions (load/save/new/import/quit), never from the
    // song-switch hot path, so the simplicity is worth it. Bounded by
    // whatever single-track decode a build thread was already mid-way
    // through -- generation-abandonment only checks between tracks.
    while (activePeakBuilds.load(std::memory_order_acquire) > 0)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
}

void AudioEngine::rebuildTrackPeaks() {
    // Any prior build is now stale regardless of how far it got -- it will
    // self-abandon at its next per-track checkpoint (see the loop below) and
    // its result will be discarded on arrival. Deliberately NOT waiting for
    // it here: this runs on every song switch (Prev/Next), and blocking on a
    // still-running decode from the previous selection is exactly the
    // "Prev/Next feels laggy" bug this change fixes. Multiple background
    // builds briefly overlapping is fine -- they're serialized against each
    // other by streaming.withProjectLoaderLock() and only the one matching
    // the current generation ever gets applied.
    ++peakBuildGeneration;

    trackPeaks.clear();
    pendingPeakCacheExtras.clear();
    if (!projectLoaded || currentSong == static_cast<size_t>(-1))
        return;
    const Project& proj = loader.project();
    if (currentSong >= proj.songs.size())
        return;

    const SongDef& song = proj.songs[currentSong];

    // Build a region→trackIndex map so peaks can be placed at the correct
    // track position (trackPeaks is indexed by track, not by region).
    std::vector<int> regionTrackIndices;
    regionTrackIndices.reserve(song.regions.size());
    for (const auto& r : song.regions) {
        int idx = -1;
        for (size_t ti = 0; ti < trackIdByIndex.size(); ++ti) {
            if (trackIdByIndex[ti] == r.trackId) {
                idx = static_cast<int>(ti);
                break;
            }
        }
        regionTrackIndices.push_back(idx);
    }

    trackPeaks.resize(trackIdByIndex.size()); // blank lanes -- filled in as the background build below completes

    const uint64_t generation = peakBuildGeneration.load(std::memory_order_relaxed);
    const size_t songIndexForBuild = currentSong;
    const std::string archivePathForBuild = loader.archivePath();
    std::vector<std::string> trackFiles;
    trackFiles.reserve(song.regions.size());
    for (const auto& r : song.regions)
        trackFiles.push_back(r.source.file);

    // Waveform decode is read-only and feeds the UI only, never playback --
    // do it off the message thread so switching songs doesn't block on
    // decoding every stem's full WAV data before Play becomes responsive
    // again (this used to be the single biggest contributor to "loading a
    // song feels slow", since it ran synchronously right here).
    activePeakBuilds.fetch_add(1, std::memory_order_relaxed);
    std::thread([this, generation, songIndexForBuild, archivePathForBuild, files = std::move(trackFiles),
                 indices = std::move(regionTrackIndices)]() mutable {
        demoteBackgroundWorkerPriority();
        std::vector<PeakOverview> buildResults(files.size());
        std::vector<ProjectLoader::ExtraFile> buildExtras;

        // Open a SEPARATE reader on the same archive file rather than going
        // through the shared `loader`/`streaming.withProjectLoaderLock()`.
        // The two used to share one mz_zip_archive + mutex, which meant
        // decoding a real song's worth of stems for peak overviews (tens to
        // hundreds of MB) held that lock long enough to starve the
        // streaming I/O thread's refill() calls for the whole duration --
        // ring buffers ran dry and stayed dry, so Play produced total
        // silence and the Mixer meters never moved even though playback
        // "looked" like it was running. Independent mz_zip_archive readers
        // on the same file don't share any mutable state, so this fully
        // eliminates the contention instead of just narrowing it.
        std::string openError;
        ProjectLoader peakLoader;
        const bool haveLoader = !files.empty() && peakLoader.open(archivePathForBuild, openError);

        if (haveLoader) {
            // Phase 1: Extract all files to memory buffers (sequential on one
            // zip handle -- can't parallelize zip reads). Check session cache
            // and on-disk peak cache during this phase to skip files we
            // already know about.
            struct PendingBuild {
                size_t index;
                std::vector<uint8_t> data;
                std::string path;
            };
            std::vector<PendingBuild> pending;
            pending.reserve(files.size());

            for (size_t i = 0; i < files.size(); ++i) {
                if (peakBuildGeneration.load(std::memory_order_acquire) != generation)
                    break;

                // Session cache hit -- already built this session.
                {
                    std::lock_guard<std::mutex> cacheLock(peakCacheMutex);
                    if (auto it = peakOverviewSessionCache.find(files[i]); it != peakOverviewSessionCache.end()) {
                        buildResults[i] = it->second;
                        continue;
                    }
                }

                // On-disk peak cache hit.
                std::string error;
                if (PeakCache::loadFromArchive(peakLoader, files[i], buildResults[i], error))
                    continue;

                // Extract to memory for parallel decode below.
                std::vector<uint8_t> wavData;
                std::string extractErr;
                if (peakLoader.extractFile(files[i], wavData, extractErr) && !wavData.empty()) {
                    pending.push_back({i, std::move(wavData), files[i]});
                } else {
                    buildResults[i] = PeakOverview{};
                }
            }

            // Publish a single region→track peak onto the message thread as
            // soon as it is ready so the SPA can paint waveforms track-by-
            // track instead of waiting for the whole song batch to finish
            // ("пики не грузит динамически").
            auto publishPartial = [this, generation, songIndexForBuild, &indices](size_t regionIndex, PeakOverview overview) {
                if (overview.empty())
                    return;
                const int trackIdx = (regionIndex < indices.size()) ? indices[regionIndex] : -1;
                if (trackIdx < 0)
                    return;
                // Capture POD copies (not the parameter names themselves) so
                // the async lambda doesn't trip -Wshadow-uncaptured-local on
                // the enclosing publishPartial parameters.
                const size_t regionIdxCopy = regionIndex;
                juce::MessageManager::callAsync(
                    [this, generation, songIndexForBuild, trackIdx, regionIdxCopy,
                     overviewCopy = std::move(overview)]() mutable {
                        if (peakBuildGeneration.load(std::memory_order_acquire) != generation
                            || currentSong != songIndexForBuild)
                            return;
                        if (static_cast<size_t>(trackIdx) >= trackPeaks.size())
                            return;
                        trackPeaks[static_cast<size_t>(trackIdx)] = overviewCopy;
                        if (songIndexForBuild < loader.project().songs.size()) {
                            auto& s = loader.project().songs[songIndexForBuild];
                            if (regionIdxCopy < s.regions.size()
                                && s.regions[regionIdxCopy].durationSeconds <= 0.0
                                && overviewCopy.durationSeconds > 0.0) {
                                s.regions[regionIdxCopy].durationSeconds = overviewCopy.durationSeconds;
                            }
                        }
                    });
            };

            // Session / on-disk hits from phase 1 are already in buildResults
            // -- push them to the UI immediately before the slow decode.
            for (size_t i = 0; i < buildResults.size(); ++i) {
                if (!buildResults[i].empty())
                    publishPartial(i, buildResults[i]);
            }

            // Phase 2: Decode peaks from memory buffers in parallel. Each
            // build is fully independent (no shared state), so jobs are
            // handed to the bounded peakBuildPool rather than spawning one
            // raw thread per file -- keeps this bounded even when a sweep
            // and a rebuild overlap.
            if (!pending.empty()) {
                std::vector<std::vector<ProjectLoader::ExtraFile>> threadExtras(pending.size());
                std::vector<std::function<void()>> jobs;
                jobs.reserve(pending.size());
                for (size_t t = 0; t < pending.size(); ++t) {
                    jobs.emplace_back([this, &pb = pending[t], &buildResults, &threadExtras, t, generation, publishPartial]() {
                        if (peakBuildGeneration.load(std::memory_order_acquire) != generation)
                            return;
                        PeakOverview overview;
                        std::string error;
                        if (overview.buildFromBuffer(pb.data.data(), pb.data.size(), error)) {
                            threadExtras[t].push_back(PeakCache::makeCacheExtra(overview, pb.path));
                            {
                                std::lock_guard<std::mutex> lock(peakCacheMutex);
                                peakOverviewSessionCache[pb.path] = overview;
                            }
                            buildResults[pb.index] = overview;
                            publishPartial(pb.index, std::move(overview));
                        } else {
                            buildResults[pb.index] = PeakOverview{};
                        }
                    });
                }
                peakBuildPool.runBatchAndWait(std::move(jobs));
                for (auto& extras : threadExtras)
                    for (auto& e : extras)
                        buildExtras.push_back(std::move(e));
            }
        }

        // Done touching the archive -- unblock anything waiting in
        // joinPendingPeakBuilds() (load/save/new/import/quit) even though
        // this thread still has a message-thread hop left to do below.
        activePeakBuilds.fetch_sub(1, std::memory_order_release);

        juce::MessageManager::callAsync(
            [this, generation, songIndexForBuild, results = std::move(buildResults), newExtras = std::move(buildExtras),
             targetIndices = std::move(indices)]() mutable {
                // Song changed again while this build was in flight -- discard.
                if (peakBuildGeneration.load(std::memory_order_acquire) != generation || currentSong != songIndexForBuild)
                    return;

                // Final reconciliation (covers any partial that raced a
                // song-change and any empty-track slots).
                if (trackPeaks.size() != targetIndices.size())
                    trackPeaks.assign(targetIndices.size(), PeakOverview{});
                for (size_t i = 0; i < results.size() && i < targetIndices.size(); ++i) {
                    const int trackIdx = targetIndices[i];
                    if (trackIdx >= 0 && static_cast<size_t>(trackIdx) < trackPeaks.size())
                        trackPeaks[static_cast<size_t>(trackIdx)] = std::move(results[i]);
                }

                if (songIndexForBuild < loader.project().songs.size()) {
                    auto& s = loader.project().songs[songIndexForBuild];
                    for (size_t i = 0; i < targetIndices.size() && i < s.regions.size(); ++i) {
                        const int trackIdx = targetIndices[i];
                        if (trackIdx >= 0 && static_cast<size_t>(trackIdx) < trackPeaks.size()) {
                            if (s.regions[i].durationSeconds <= 0.0 && trackPeaks[static_cast<size_t>(trackIdx)].durationSeconds > 0.0) {
                                s.regions[i].durationSeconds = trackPeaks[static_cast<size_t>(trackIdx)].durationSeconds;
                            }
                        }
                    }
                }
                for (auto& e : newExtras)
                    pendingPeakCacheExtras.push_back(std::move(e));
            });
    }).detach();
}

const PeakOverview* AudioEngine::cachedPeaksForFile(const std::string& file) const {
    std::lock_guard<std::mutex> cacheLock(peakCacheMutex);
    auto it = peakOverviewSessionCache.find(file);
    return it != peakOverviewSessionCache.end() ? &it->second : nullptr;
}

void AudioEngine::ensureAllSongPeaksBuilt() {
    if (!projectLoaded)
        return;
    if (allPeaksBuildInFlight.exchange(true, std::memory_order_acq_rel))
        return; // a sweep is already in flight; it'll pick up anything still missing next time it's called

    std::vector<std::string> filesToBuild;
    {
        std::lock_guard<std::mutex> cacheLock(peakCacheMutex);
        for (const auto& song : loader.project().songs)
            for (const auto& r : song.regions)
                if (!r.source.file.empty() && !peakOverviewSessionCache.count(r.source.file)
                    && std::find(filesToBuild.begin(), filesToBuild.end(), r.source.file) == filesToBuild.end())
                    filesToBuild.push_back(r.source.file);
    }
    if (filesToBuild.empty()) {
        allPeaksBuildInFlight.store(false, std::memory_order_release);
        return;
    }

    // Same independent-reader pattern as rebuildTrackPeaks() (see its doc
    // comment): a separate mz_zip_archive on the same file so this sweep
    // never contends with the streaming I/O thread's refill() calls.
    const std::string archivePathForBuild = loader.archivePath();
    activePeakBuilds.fetch_add(1, std::memory_order_relaxed);
    std::thread([this, archivePathForBuild, files = std::move(filesToBuild)]() {
        demoteBackgroundWorkerPriority();
        std::vector<ProjectLoader::ExtraFile> newExtras;
        std::string openError;
        ProjectLoader peakLoader;
        if (peakLoader.open(archivePathForBuild, openError)) {
            // Phase 1: Extract all files to memory (sequential on zip handle).
            struct PendingBuild {
                std::string path;
                std::vector<uint8_t> data;
            };
            std::vector<PendingBuild> pending;
            pending.reserve(files.size());
            std::vector<std::string> cachedPaths;

            for (const auto& file : files) {
                PeakOverview overview;
                std::string error;
                if (PeakCache::loadFromArchive(peakLoader, file, overview, error)) {
                    std::lock_guard<std::mutex> lock(peakCacheMutex);
                    peakOverviewSessionCache[file] = std::move(overview);
                    continue;
                }
                std::vector<uint8_t> wavData;
                std::string extractErr;
                if (peakLoader.extractFile(file, wavData, extractErr) && !wavData.empty()) {
                    pending.push_back({file, std::move(wavData)});
                }
            }

            // Phase 2: Decode peaks in parallel, via the bounded pool -- a
            // whole-project sweep can involve far more files than
            // rebuildTrackPeaks()'s single-song case, so this is exactly the
            // fan-out the pool exists to cap.
            if (!pending.empty()) {
                std::vector<std::vector<ProjectLoader::ExtraFile>> threadExtras(pending.size());
                std::vector<std::function<void()>> jobs;
                jobs.reserve(pending.size());
                for (size_t t = 0; t < pending.size(); ++t) {
                    jobs.emplace_back([this, &pb = pending[t], &threadExtras, t]() {
                        PeakOverview overview;
                        std::string error;
                        if (overview.buildFromBuffer(pb.data.data(), pb.data.size(), error)) {
                            threadExtras[t].push_back(PeakCache::makeCacheExtra(overview, pb.path));
                            {
                                std::lock_guard<std::mutex> lock(peakCacheMutex);
                                peakOverviewSessionCache[pb.path] = std::move(overview);
                            }
                        }
                    });
                }
                peakBuildPool.runBatchAndWait(std::move(jobs));
                for (auto& extras : threadExtras)
                    for (auto& e : extras)
                        newExtras.push_back(std::move(e));
            }
        }
        activePeakBuilds.fetch_sub(1, std::memory_order_release);
        juce::MessageManager::callAsync([this, extras = std::move(newExtras)]() mutable {
            for (auto& e : extras)
                pendingPeakCacheExtras.push_back(std::move(e));
            allPeaksBuildInFlight.store(false, std::memory_order_release);
        });
    }).detach();
}

} // namespace resostage
