#include "AudioEngine.h"

#include "audio/PeakCache.h"
#include "audio/WavMetadata.h"
#include "platform/AudioWorkgroup.h"
#include "platform/ProcessPriority.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <thread>


namespace resoset {

namespace {
float dbToGain(double db) {
    if (db <= -144.0)
        return 0.0f;
    return static_cast<float>(std::pow(10.0, db / 20.0));
}

// Fade shape: curve in [-1, +1], 0 = linear.
// Positive → ease-out (fast start, slow end); negative → ease-in (slow start).
// Exponent is 2^(-curve*2) so +1 → exp 0.25 (concave-up / ease-out feel)
// and -1 → exp 4 (ease-in). Matches typical DAW fade-curve drag direction.
float shapedFadeGain(float t01, double curve) {
    const float t = std::clamp(t01, 0.0f, 1.0f);
    if (std::abs(curve) < 1.0e-6)
        return t;
    const float exp = std::pow(2.0f, static_cast<float>(-curve) * 2.0f); // 4..0.25
    return std::pow(t, exp);
}

// Lookahead ring per stem. Larger = more resilience to SSD thrashing
// (Spotlight, backups, Xcode) before an underrun; memory cost is
// tracks * ch * rate * seconds * 4B — e.g. 16 stereo 48 kHz × 8 s ≈ 50 MB.
// Metronome does not use this path (pure synth). Beyond this window,
// StreamingTrackBuffer catch-up skip still resyncs after silence holes.
constexpr double kRingBufferSeconds = 8.0;

// Play prime is intentionally short (see play()) — long waits freezes UI on
// song switch. Rings + async RAM residency fill in the background.

// Shared I/O-thread hooks: elevate disk/CPU priority, then join CoreAudio
// workgroup; leave workgroup on exit (required — see AudioWorkgroup.h).
void streamingIoThreadStart() {
    boostStreamingIoThreadPriority();
    joinCurrentThreadToDefaultOutputWorkgroup();
}
void streamingIoThreadStop() {
    leaveCurrentThreadWorkgroupIfJoined();
}

// ~/Library/Application Support/ResoStage/Drafts/draft_<timestamp>.rsnraset
// (platform-appropriate equivalent elsewhere). Auto-created for every
// newProject() so imports have somewhere real to write to immediately,
// without forcing a manual Save As first. Rotated on every launch / new
// draft (keep the most recent kMaxRetainedDrafts; drop *.new / tmp leftovers).
// Successful Save As still promotes the active draft out of this folder.
constexpr int kMaxRetainedDrafts = 3;

void purgeStaleDrafts(const juce::File& draftsDir, const juce::String& keepPath = {}) {
    if (!draftsDir.isDirectory())
        return;

    struct Entry {
        juce::File file;
        juce::int64 modTime = 0;
        bool isCompleteDraft = false;
    };
    std::vector<Entry> complete;
    const juce::String keepFull = keepPath.isNotEmpty()
                                      ? juce::File(keepPath).getFullPathName()
                                      : juce::String();

    for (const auto& f : draftsDir.findChildFiles(
             juce::File::findFilesAndDirectories, false)) {
        const juce::String name = f.getFileName();
        const juce::String full = f.getFullPathName();
        // Crash/write leftovers from the old archivePath+".new" path and
        // partial renames -- never useful, always reclaim.
        if (name.contains(".new") || name.contains("tmp-writing") || name.endsWithIgnoreCase(".tmp")) {
            f.deleteRecursively();
            continue;
        }
        if (!name.startsWith("draft_") || !name.endsWithIgnoreCase(".rsnraset")) {
            // Unknown junk under Drafts/ -- leave alone (user may have put something here).
            continue;
        }
        if (keepFull.isNotEmpty() && full == keepFull)
            continue;
        Entry e;
        e.file = f;
        e.modTime = f.getLastModificationTime().toMilliseconds();
        e.isCompleteDraft = true;
        complete.push_back(std::move(e));
    }

    std::sort(complete.begin(), complete.end(),
              [](const Entry& a, const Entry& b) { return a.modTime > b.modTime; });
    for (size_t i = static_cast<size_t>(kMaxRetainedDrafts); i < complete.size(); ++i)
        complete[i].file.deleteRecursively();
}

bool makeDraftArchivePath(std::string& outPath, std::string& error) {
    // JUCE's userApplicationDataDirectory maps to ~/Library on macOS, not
    // ~/Library/Application Support -- append that segment explicitly to
    // land in the conventional location instead of directly under ~/Library.
    const juce::File userData = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
#if JUCE_MAC
    const juce::File appSupport = userData.getChildFile("Application Support");
#else
    const juce::File appSupport = userData;
#endif
    const juce::File draftsDir = appSupport.getChildFile("ResoStage").getChildFile("Drafts");
    const auto result = draftsDir.createDirectory();
    if (result.failed()) {
        error = result.getErrorMessage().toStdString();
        return false;
    }
    // Rotate before allocating a new timestamped draft so a crashy session
    // of "New Project" clicks can't fill the disk again.
    purgeStaleDrafts(draftsDir);
    const juce::String filename = "draft_" + juce::String(juce::Time::getCurrentTime().toMilliseconds()) + ".rsnraset";
    outPath = draftsDir.getChildFile(filename).getFullPathName().toStdString();
    return true;
}
} // namespace

AudioEngine::AudioEngine() {
    // Reclaim disk from previous sessions even if the user never hits New
    // Project this launch (makeDraftArchivePath also rotates on create).
    {
        const juce::File userData = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
#if JUCE_MAC
        const juce::File appSupport = userData.getChildFile("Application Support");
#else
        const juce::File appSupport = userData;
#endif
        purgeStaleDrafts(appSupport.getChildFile("ResoStage").getChildFile("Drafts"));
    }
    deviceManagerInstance.addAudioCallback(this);
    deviceManagerInstance.addChangeListener(this);
    midiDispatcher.start();
    eventDispatcher.start();
}

AudioEngine::~AudioEngine() {
    // If an async import is still running (rare -- app quit mid-import), let
    // it finish rather than tearing down loader/streaming out from under its
    // background thread. Imports are seconds, not minutes, so this is a
    // bounded, acceptable delay on quit.
    if (importThread.joinable())
        importThread.join();
    if (saveThread.joinable())
        saveThread.join();
    if (pendingFinishImport) {
        auto fn = std::move(pendingFinishImport);
        pendingFinishImport = nullptr;
        fn();
    }
    // Background peak builds also read `loader` (see rebuildTrackPeaks());
    // wait for them before streaming.stop() hands loader ownership to us.
    joinPendingPeakBuilds();
    stop();
    streaming.stop();
    purgeStaleSavePackages();
    midiDispatcher.stop();
    eventDispatcher.stop();
    deviceManagerInstance.removeChangeListener(this);
    deviceManagerInstance.removeAudioCallback(this);
    deviceManagerInstance.closeAudioDevice();
}

void AudioEngine::changeListenerCallback(juce::ChangeBroadcaster*) {
    checkForDeviceLoss();
}

void AudioEngine::checkForDeviceLoss() {
    auto* currentDevice = deviceManagerInstance.getCurrentAudioDevice();
    if (currentDevice != nullptr) {
        lastKnownDeviceName = currentDevice->getName().toStdString();
        transportTelemetry.hardwareAlarm.store(false, std::memory_order_relaxed);
        return;
    }

    if (lastKnownDeviceName.empty())
        return; // never had a device yet -- nothing to fail over from

    // The device we were using is gone. Alarm the UI and fall back to the
    // system default output. MasterClock is deliberately left running (not
    // stopped here) -- it keeps advancing off wall-clock time regardless of
    // whether the audio callback is firing, so when a device comes back
    // online, StreamingTrackBuffer's catch-up logic resyncs audio to
    // wherever the timeline says it should be rather than restarting from
    // where playback happened to stop.
    lastKnownDeviceName.clear();
    transportTelemetry.hardwareAlarm.store(true, std::memory_order_relaxed);
    deviceManagerInstance.initialiseWithDefaultDevices(0, 2);
}

const SeqLock<MeterFrame>* AudioEngine::busMeterAt(size_t index) const {
    if (index >= busMeters.size())
        return nullptr;
    return busMeters[index].get();
}

const SeqLock<MeterFrame>* AudioEngine::trackMeterAt(size_t index) const {
    if (index >= trackMeters.size())
        return nullptr;
    return trackMeters[index].get();
}

namespace {
void atomicMaxFloat(std::atomic<float>& slot, float v) {
    if (!(v > 0.0f) || !std::isfinite(v))
        return;
    float cur = slot.load(std::memory_order_relaxed);
    while (v > cur
           && !slot.compare_exchange_weak(cur, v, std::memory_order_relaxed,
                                          std::memory_order_relaxed)) {
        // cur updated by CAS failure
    }
}

float linearPeakToDb(float p) {
    if (!(p > 1.0e-9f) || !std::isfinite(p))
        return -144.0f;
    return 20.0f * std::log10(std::min(p, 32.0f));
}
} // namespace

MeterFrame AudioEngine::consumeClickMeterInterval() {
    // Take the max peak rendered since the previous UI poll, then clear.
    const float peakL = clickPeakIntervalMaxL.exchange(0.0f, std::memory_order_relaxed);
    const float peakR = clickPeakIntervalMaxR.exchange(0.0f, std::memory_order_relaxed);

    // Echo last interval once: publish N carries real peak, publish N+1 still
    // carries it if this interval was silent. WS client that only samples the
    // later frame still sees the tick. Next silent interval clears delivery.
    const float outL = std::max(peakL, clickPeakDeliveryL);
    const float outR = std::max(peakR, clickPeakDeliveryR);
    clickPeakDeliveryL = peakL;
    clickPeakDeliveryR = peakR;

    MeterFrame frame;
    frame.peakDbL = linearPeakToDb(outL);
    frame.peakDbR = linearPeakToDb(outR);
    frame.peakDb = linearPeakToDb(std::max(outL, outR));
    frame.truePeakDb = frame.peakDb;
    return frame;
}

const std::string& AudioEngine::busNameAt(size_t index) const {
    static const std::string kEmpty;
    const auto& buses = loader.project().busses;
    if (index >= buses.size())
        return kEmpty;
    return buses[index].name.empty() ? buses[index].id : buses[index].name;
}

const TrackDef* AudioEngine::trackDefAt(size_t index) const {
    if (!projectLoaded)
        return nullptr;
    const auto& trks = loader.project().tracks;
    if (index < trks.size())
        return &trks[index];
    return nullptr;
}

TrackDef* AudioEngine::trackDefAt(size_t index) {
    return const_cast<TrackDef*>(static_cast<const AudioEngine*>(this)->trackDefAt(index));
}

const TrackDef* AudioEngine::trackDefInSong(size_t songIndex, size_t trackIndex) const {
    (void)songIndex;
    return trackDefAt(trackIndex);
}

TrackDef* AudioEngine::trackDefInSong(size_t songIndex, size_t trackIndex) {
    (void)songIndex;
    return trackDefAt(trackIndex);
}

bool AudioEngine::isBusMuted(size_t busIndex) const {
    const auto& buses = loader.project().busses;
    if (busIndex < buses.size())
        return buses[busIndex].mute;
    return busIndex < busMuted.size() && busMuted[busIndex];
}

bool AudioEngine::isBusSoloed(size_t busIndex) const {
    const auto& buses = loader.project().busses;
    return busIndex < buses.size() && buses[busIndex].solo;
}

double AudioEngine::busGainDb(size_t busIndex) const {
    const auto& buses = loader.project().busses;
    if (busIndex >= buses.size())
        return 0.0;
    return buses[busIndex].gainDb;
}

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
        trackFiles.push_back(r.file);

    // Waveform decode is read-only and feeds the UI only, never playback --
    // do it off the message thread so switching songs doesn't block on
    // decoding every stem's full WAV data before Play becomes responsive
    // again (this used to be the single biggest contributor to "loading a
    // song feels slow", since it ran synchronously right here).
    activePeakBuilds.fetch_add(1, std::memory_order_relaxed);
    std::thread([this, generation, songIndexForBuild, archivePathForBuild, files = std::move(trackFiles),
                 regionTrackIndices = std::move(regionTrackIndices)]() mutable {
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
                    jobs.emplace_back([this, &pb = pending[t], &buildResults, &threadExtras, t, generation]() {
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
                            buildResults[pb.index] = std::move(overview);
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
             regionTrackIndices = std::move(regionTrackIndices)]() mutable {
                // Song changed again while this build was in flight -- discard.
                if (peakBuildGeneration.load(std::memory_order_acquire) != generation || currentSong != songIndexForBuild)
                    return;

                // Remap region-indexed peaks to track-indexed peaks.
                trackPeaks.assign(regionTrackIndices.size(), PeakOverview{});
                for (size_t i = 0; i < results.size() && i < regionTrackIndices.size(); ++i) {
                    const int trackIdx = regionTrackIndices[i];
                    if (trackIdx >= 0 && static_cast<size_t>(trackIdx) < trackPeaks.size())
                        trackPeaks[static_cast<size_t>(trackIdx)] = std::move(results[i]);
                }

                if (songIndexForBuild < loader.project().songs.size()) {
                    auto& s = loader.project().songs[songIndexForBuild];
                    for (size_t i = 0; i < regionTrackIndices.size() && i < s.regions.size(); ++i) {
                        const int trackIdx = regionTrackIndices[i];
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
                if (!r.file.empty() && !peakOverviewSessionCache.count(r.file)
                    && std::find(filesToBuild.begin(), filesToBuild.end(), r.file) == filesToBuild.end())
                    filesToBuild.push_back(r.file);
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

double AudioEngine::currentSongLengthSeconds() const {
    if (currentSampleRate <= 0.0 || currentSongLengthFrames <= 0)
        return 0.0;
    return static_cast<double>(currentSongLengthFrames) / currentSampleRate;
}

double AudioEngine::regionEffectiveDurationSeconds(const Region& r) const {
    if (r.durationSeconds > 0.0)
        return r.durationSeconds;
    const PeakOverview* pk = cachedPeaksForFile(r.file);
    return pk != nullptr ? pk->durationSeconds : 0.0;
}

double AudioEngine::songAuthoredDurationSeconds(const SongDef& song) const {
    double maxEnd = 0.0;
    for (const Region& r : song.regions)
        maxEnd = std::max(maxEnd, r.startSeconds + regionEffectiveDurationSeconds(r));
    return maxEnd;
}

double AudioEngine::globalPlayheadSeconds() const {
    if (!projectLoaded || currentSong == static_cast<size_t>(-1))
        return 0.0;
    const Project& proj = loader.project();
    double offset = 0.0;
    for (size_t i = 0; i < currentSong && i < proj.songs.size(); ++i)
        offset += songAuthoredDurationSeconds(proj.songs[i]);
    return offset + clock.currentSeconds();
}

double AudioEngine::globalBeatsElapsed() const {
    if (!projectLoaded || currentSong == static_cast<size_t>(-1) || currentSong >= loader.project().songs.size())
        return 0.0;
    const Project& proj = loader.project();
    double beats = 0.0;
    for (size_t i = 0; i < currentSong; ++i)
        beats += songAuthoredDurationSeconds(proj.songs[i]) * (proj.songs[i].bpm / 60.0);
    beats += clock.currentSeconds() * (proj.songs[currentSong].bpm / 60.0);
    return beats;
}

void AudioEngine::ensureTrackMeters(size_t count) {
    trackMeters.resize(count);
    for (size_t i = 0; i < count; ++i) {
        if (trackMeters[i] == nullptr)
            trackMeters[i] = std::make_unique<SeqLock<MeterFrame>>();
    }
}

void AudioEngine::buildBusListFromProject() {
    std::lock_guard<std::recursive_mutex> lock(routingMutex);


    busses.clear();
    busIndexById.clear();


    for (const BusDef& bus : loader.project().busses) {
        LoadedBus lb;
        lb.id = bus.id;
        lb.channelCount = bus.channels;
        busIndexById[bus.id] = busses.size();
        busses.push_back(std::move(lb));
    }

    busMeters.clear();
    busLoudnessMeters.clear();
    busMuted.assign(busses.size(), false);
    for (size_t i = 0; i < busses.size() && i < loader.project().busses.size(); ++i)
        busMuted[i] = loader.project().busses[i].mute;
    busMeters.resize(busses.size());
    busLoudnessMeters.resize(busses.size());
    for (size_t i = 0; i < busses.size(); ++i) {
        busMeters[i] = std::make_unique<SeqLock<MeterFrame>>();
        busLoudnessMeters[i].prepare(currentSampleRate, 2);
    }

    ensureScratchSizes();
}

void AudioEngine::publishRoutingSnapshot() {
    std::lock_guard<std::recursive_mutex> lock(routingMutex);

    if (!projectLoaded || currentSong == static_cast<size_t>(-1))
        return;

    markDirty();

    const Project& proj = loader.project();
    if (currentSong >= proj.songs.size())
        return;

    bool anyTrackSolo = proj.builtInClickSolo;
    for (size_t i = 0; i < proj.tracks.size() && i < trackIdByIndex.size(); ++i)
        if (proj.tracks[i].solo)
            anyTrackSolo = true;

    bool anyBusSolo = false;
    for (const BusDef& b : proj.busses)
        if (b.solo)
            anyBusSolo = true;

    auto snapshot = std::make_unique<RoutingSnapshot>();
    snapshot->busCount = static_cast<uint32_t>(busses.size());

    for (size_t i = 0; i < proj.tracks.size() && i < trackIdByIndex.size(); ++i) {
        const TrackDef& trackDef = proj.tracks[i];
        const bool trackSilenced = trackDef.mute || (anyTrackSolo && !trackDef.solo);
        const float trackGain = dbToGain(trackDef.gainDb);
        const float trackPan = static_cast<float>(std::clamp(trackDef.pan, -1.0, 1.0));

        // Main (FOH) route.
        auto busIt = busIndexById.find(trackDef.busId);
        if (busIt != busIndexById.end()) {
            TrackRoute route;
            route.trackIndex = static_cast<uint32_t>(i);
            route.busIndex = static_cast<uint32_t>(busIt->second);
            route.gainLinear = trackGain;
            route.sendGainLinear = 1.0f;
            route.pan = trackPan;
            route.mute = trackSilenced;
            route.isAuxSend = false;
            route.forceMono = trackDef.mono;
            snapshot->routes.push_back(route);
        }

        // Aux-send matrix rows.
        for (const TrackSendDef& send : trackDef.sends) {
            if (!send.enabled)
                continue;
            auto sendBusIt = busIndexById.find(send.busId);
            if (sendBusIt == busIndexById.end())
                continue;
            TrackRoute route;
            route.trackIndex = static_cast<uint32_t>(i);
            route.busIndex = static_cast<uint32_t>(sendBusIt->second);
            // Pre-fader: ignore track fader/mute, still respect solo group.
            if (send.preFader) {
                route.gainLinear = 1.0f;
                route.mute = anyTrackSolo && !trackDef.solo;
            } else {
                route.gainLinear = trackGain;
                route.mute = trackSilenced;
            }
            route.sendGainLinear = dbToGain(send.gainDb);
            route.pan = trackPan;
            route.isAuxSend = true;
            route.forceMono = trackDef.mono;
            snapshot->routes.push_back(route);
        }
    }

    for (size_t bi = 0; bi < proj.busses.size(); ++bi) {
        const BusDef& busDef = proj.busses[bi];
        auto busIt = busIndexById.find(busDef.id);
        if (busIt == busIndexById.end())
            continue;
        BusOutput out;
        out.busIndex = static_cast<uint32_t>(busIt->second);
        out.startChannel = busDef.output.startChannel;
        out.channelCount = busDef.channels;
        out.gainLinear = dbToGain(busDef.gainDb);
        out.mute = busDef.mute || (anyBusSolo && !busDef.solo);
        snapshot->outputs.push_back(out);
    }

    routing.publish(std::move(snapshot));
}

void AudioEngine::republishRouting() {
    publishRoutingSnapshot();
}

void AudioEngine::rebuildBussesFromProject() {
    buildBusListFromProject();
    publishRoutingSnapshot();
}

void AudioEngine::setTrackGainDb(size_t songIndex, size_t trackIndex, double gainDb) {
    (void)songIndex;
    TrackDef* t = trackDefAt(trackIndex);
    if (t == nullptr)
        return;
    t->gainDb = gainDb;
    publishRoutingSnapshot();
}

void AudioEngine::setTrackPan(size_t songIndex, size_t trackIndex, double pan) {
    (void)songIndex;
    TrackDef* t = trackDefAt(trackIndex);
    if (t == nullptr)
        return;
    t->pan = std::clamp(pan, -1.0, 1.0);
    publishRoutingSnapshot();
}

void AudioEngine::setTrackMono(size_t songIndex, size_t trackIndex, bool mono) {
    (void)songIndex;
    TrackDef* t = trackDefAt(trackIndex);
    if (t == nullptr)
        return;
    t->mono = mono;
    publishRoutingSnapshot();
}

void AudioEngine::setTrackMute(size_t songIndex, size_t trackIndex, bool mute) {
    (void)songIndex;
    TrackDef* t = trackDefAt(trackIndex);
    if (t == nullptr)
        return;
    t->mute = mute;
    publishRoutingSnapshot();
}

void AudioEngine::setTrackSolo(size_t songIndex, size_t trackIndex, bool solo) {
    (void)songIndex;
    TrackDef* t = trackDefAt(trackIndex);
    if (t == nullptr)
        return;
    t->solo = solo;
    publishRoutingSnapshot();
}

void AudioEngine::setTrackBusId(size_t songIndex, size_t trackIndex, const std::string& busId) {
    (void)songIndex;
    TrackDef* t = trackDefAt(trackIndex);
    if (t == nullptr)
        return;
    if (!busId.empty() && busIndexById.find(busId) == busIndexById.end())
        return;
    t->busId = busId;
    publishRoutingSnapshot();
}

void AudioEngine::setTrackSend(size_t songIndex, size_t trackIndex, size_t sendIndex, const TrackSendDef& send) {
    (void)songIndex;
    TrackDef* t = trackDefAt(trackIndex);
    if (t == nullptr || sendIndex >= t->sends.size())
        return;
    if (busIndexById.find(send.busId) == busIndexById.end())
        return;
    t->sends[sendIndex] = send;
    publishRoutingSnapshot();
}

void AudioEngine::addTrackSend(size_t songIndex, size_t trackIndex, const TrackSendDef& send) {
    (void)songIndex;
    TrackDef* t = trackDefAt(trackIndex);
    if (t == nullptr)
        return;
    if (busIndexById.find(send.busId) == busIndexById.end())
        return;
    t->sends.push_back(send);
    publishRoutingSnapshot();
}

void AudioEngine::removeTrackSend(size_t songIndex, size_t trackIndex, size_t sendIndex) {
    (void)songIndex;
    TrackDef* t = trackDefAt(trackIndex);
    if (t == nullptr || sendIndex >= t->sends.size())
        return;
    t->sends.erase(t->sends.begin() + static_cast<std::ptrdiff_t>(sendIndex));
    publishRoutingSnapshot();
}

void AudioEngine::setBusGainDb(size_t busIndex, double gainDb) {
    auto& buses = loader.project().busses;
    if (busIndex >= buses.size())
        return;
    buses[busIndex].gainDb = gainDb;
    publishRoutingSnapshot();
}

void AudioEngine::setBusMute(size_t busIndex, bool mute) {
    auto& buses = loader.project().busses;
    if (busIndex >= buses.size())
        return;
    buses[busIndex].mute = mute;
    if (busIndex < busMuted.size())
        busMuted[busIndex] = mute;
    publishRoutingSnapshot();
}

void AudioEngine::setBusSolo(size_t busIndex, bool solo) {
    auto& buses = loader.project().busses;
    if (busIndex >= buses.size())
        return;
    buses[busIndex].solo = solo;
    publishRoutingSnapshot();
}

void AudioEngine::setClickSolo(bool solo) {
    loader.project().builtInClickSolo = solo;
    publishRoutingSnapshot();
}

void AudioEngine::refreshClickState() {
    std::lock_guard<std::recursive_mutex> lock(routingMutex);


    if (!projectLoaded || currentSong >= loader.project().songs.size())
        return;
    const SongDef& song = loader.project().songs[currentSong];
    clickTargetBusIndex = -1;
    clickSendBusIndices.clear();
    clickSendGainLinears.clear();
    isClickEnabled = song.builtInClickEnabled;

    auto clickBusIt = busIndexById.find(song.builtInClickBusId.empty() ? (busses.empty() ? "" : busses.front().id) : song.builtInClickBusId);
    if (clickBusIt != busIndexById.end()) {
        clickTargetBusIndex = static_cast<int>(clickBusIt->second);
        // Gain/pan are project-global (same for every song).
        clickGainLinear = dbToGain(loader.project().builtInClickGainDb);
        clickPan = static_cast<float>(
            std::clamp(loader.project().builtInClickPan, -1.0, 1.0));
        clickGenerator.prepare(currentSampleRate, song.bpm, song.timeSignature.numerator);
    }
    for (const TrackSendDef& cs : song.builtInClickSends) {
        if (!cs.enabled)
            continue;
        auto it = busIndexById.find(cs.busId);
        if (it == busIndexById.end())
            continue;
        clickSendBusIndices.push_back(static_cast<int>(it->second));
        clickSendGainLinears.push_back(dbToGain(cs.gainDb));
    }
}

void AudioEngine::setBusOutputChannel(size_t busIndex, int startChannel) {
    auto& buses = loader.project().busses;
    if (busIndex >= buses.size())
        return;
    buses[busIndex].output.startChannel = std::max(0, startChannel);
    publishRoutingSnapshot();
}

void AudioEngine::ensureScratchSizes() {
    std::lock_guard<std::recursive_mutex> lock(routingMutex);


    const int busChannels = std::max<int>(2, static_cast<int>(busses.size()) * 2);
    const int samples = std::max(currentBlockSize, 1);
    busScratch.setSize(busChannels, samples, false, false, true);

    for (auto& scratch : trackScratch)
        scratch.setSize(2, samples, false, false, true);

    clickScratch.assign(static_cast<size_t>(samples), 0.0f);
}


bool AudioEngine::loadProject(const std::string& path, std::string& error) {
    stop();
    // Background peak builds also read `loader` -- must finish before we
    // start mutating it directly below (streaming.stop() only halts the
    // streaming I/O thread, not these).
    joinPendingPeakBuilds();
    streaming.stop();
    purgeStaleSavePackages();

    if (!loader.open(path, error))
        return false;

    buildBusListFromProject();
    currentSong = static_cast<size_t>(-1);
    trackIdByIndex.clear();
    trackScratch.clear();
    trackGainSmooth.clear();
    clickSendSmooth.clear();
    trackMeters.clear();
    projectLoaded = true;
    // A user-chosen / loaded archive is never a draft -- without this, a
    // prior newProject()'s usingDraftArchive=true leaked across Load and
    // made plain Save always open the file picker (hasRealSaveLocation
    // requires !isDraftProject()).
    usingDraftArchive = false;
    midiClockEverStarted = false; // a new project's MIDI clock hasn't started yet -- next play() sends 0xFA, not 0xFB
    peakOverviewSessionCache.clear(); // different archive -- same file path could mean different audio

    // stop() above only freezes the playhead at wherever it was (so a normal
    // Stop/Play resumes in place) -- selectSong() is what actually zeroes it
    // back out when staging a song. If the loaded project has at least one
    // song, ensureSongSelected()/goToSong(0) does that momentarily after this
    // returns. If it has none, nothing else ever will, and the old project's
    // stale position keeps reporting as this one's -- e.g. Player's timeline
    // showing a playhead seconds into a song that no longer exists.
    if (loader.project().songs.empty()) {
        clock.start(currentSampleRate, 0);
        clock.stop();
    }

    streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);
    clearDirty();
    return true;
}

void AudioEngine::newProject(const std::string& name) {
    stop();
    // Same reasoning as loadProject() above -- a brand new project always
    // starts with zero songs, so nothing downstream will reset this.
    clock.start(currentSampleRate, 0);
    clock.stop();
    joinPendingPeakBuilds();
    streaming.stop();

    loader.newProject(name);
    usingDraftArchive = false;
    peakOverviewSessionCache.clear();

    // Auto-create a draft archive immediately so WAV/song-folder imports
    // work right away. Best-effort: if this fails (disk full, permissions),
    // fall back to no archive at all -- imports will then prompt the user
    // to Save As manually instead (see BuilderPanel::ensureProjectSaved).
    std::string draftPath, draftError;
    if (makeDraftArchivePath(draftPath, draftError) && loader.saveAs(draftPath, draftError)
        && loader.open(draftPath, draftError)) {
        usingDraftArchive = true;
    }

    buildBusListFromProject();
    projectLoaded = true;
    midiClockEverStarted = false;

    if (!loader.project().songs.empty()) {
        std::string err;
        selectSong(0, err);
    } else {
        currentSong = static_cast<size_t>(-1);
        trackIdByIndex.clear();
        trackScratch.clear();
        trackMeters.clear();
    }

    streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);
    clearDirty();
}


void AudioEngine::markDirty() {
    unsavedChanges.store(true, std::memory_order_release);
    if (!projectLoaded)
        return;
    // Mid-show: don't thrash the same SSD as stem refill. Flush on stop.
    if (playing.load(std::memory_order_acquire)) {
        autosaveDeferred.store(true, std::memory_order_release);
        return;
    }
    std::string err;
    loader.saveAutosave(err);
    autosaveDeferred.store(false, std::memory_order_release);
}

void AudioEngine::flushDeferredAutosave() {
    if (!autosaveDeferred.exchange(false, std::memory_order_acq_rel))
        return;
    if (!projectLoaded || !unsavedChanges.load(std::memory_order_acquire))
        return;
    std::string err;
    loader.saveAutosave(err);
}

bool AudioEngine::saveProject(const std::string& path, std::string& error) {
    if (!projectLoaded) {
        error = "No project loaded";
        return false;
    }

    {
        const juce::String stem = juce::File(path).getFileNameWithoutExtension();
        if (stem.isNotEmpty())
            loader.project().name = stem.toStdString();
    }

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    const bool overwriteOpen = (path == loader.archivePath());
    const bool promotingDraft = usingDraftArchive && !overwriteOpen;
    const bool switchingToNewPath = !overwriteOpen && !promotingDraft;
    const std::string oldDraftPath = usingDraftArchive ? loader.archivePath() : std::string();
    Project snapshot = loader.project();
    std::string sourcePath = loader.archivePath();
    const bool isContainer = loader.isDirectoryContainer();
    const bool playThroughOk =
        isContainer && !promotingDraft && overwriteOpen && wasPlaying;

    namespace fs = std::filesystem;
    auto replacePath = [](const std::string& from, const std::string& to, std::string& err) -> bool {
        std::error_code ec;
        fs::remove_all(to, ec);
        fs::rename(from, to, ec);
        if (ec) {
            err = "Failed to replace archive: " + ec.message();
            return false;
        }
        return true;
    };

    // ── Play-through overwrite (directory package, same path, while playing) ──
    if (playThroughOk) {
        const std::string tempOut = path + ".saving";
        if (!loader.saveAsWithExtras(tempOut, pendingPeakCacheExtras, error, &snapshot))
            return false;
        const std::string aside = path + ".play-old";
        std::error_code ec;
        fs::remove_all(aside, ec);
        fs::rename(path, aside, ec);
        if (ec) {
            fs::remove_all(tempOut, ec);
            error = "Failed to park live package: " + ec.message();
            return false;
        }
        fs::rename(tempOut, path, ec);
        if (ec) {
            std::error_code ec2;
            fs::rename(aside, path, ec2);
            fs::remove_all(tempOut, ec2);
            error = "Failed to install saved package: " + ec.message();
            return false;
        }
        fs::remove_all(aside, ec);
        if (ec)
            staleSavePackages.push_back(aside);
        usingDraftArchive = false;
        clearDirty();
        clearAutosave();
        return true;
    }

    // ── Classic path: stop / write / reopen / restage ──
    stop();
    joinPendingPeakBuilds();
    streaming.stop();
    purgeStaleSavePackages();

    if (overwriteOpen || promotingDraft) {
        const std::string tempOut = path + ".new";
        if (!loader.saveAsWithExtras(tempOut, pendingPeakCacheExtras, error, &snapshot))
            return false;

        loader.close();
        if (!replacePath(tempOut, path, error)) {
            (void)loader.open(sourcePath, error);
            projectLoaded = loader.isOpen();
            if (projectLoaded)
                streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);
            return false;
        }
        if (!loader.open(path, error)) {
            projectLoaded = false;
            return false;
        }
        if (promotingDraft) {
            usingDraftArchive = false;
            if (!oldDraftPath.empty() && oldDraftPath != path) {
                std::error_code ec;
                fs::remove_all(oldDraftPath, ec);
            }
        }
    } else if (switchingToNewPath) {
        if (!loader.saveAsWithExtras(path, pendingPeakCacheExtras, error, &snapshot))
            return false;
        loader.close();
        if (!loader.open(path, error)) {
            projectLoaded = false;
            return false;
        }
        usingDraftArchive = false;
        if (!oldDraftPath.empty() && oldDraftPath != path) {
            std::error_code ec;
            fs::remove_all(oldDraftPath, ec);
        }
    } else {
        if (!loader.saveAsWithExtras(path, pendingPeakCacheExtras, error, &snapshot))
            return false;

        if (!loader.isOpen()) {
            if (!loader.open(path, error)) {
                projectLoaded = false;
                return false;
            }
        }
    }

    buildBusListFromProject();
    projectLoaded = true;
    streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);

    currentSong = static_cast<size_t>(-1);
    trackIdByIndex.clear();
    trackScratch.clear();
    trackGainSmooth.clear();
    clickSendSmooth.clear();
    trackMeters.clear();

    const auto& projTracks = loader.project().tracks;
    if (!projTracks.empty()) {
        for (const auto& t : projTracks)
            trackIdByIndex.push_back(t.id);
        trackScratch.assign(trackIdByIndex.size(), juce::AudioBuffer<float>());
        ensureTrackMeters(trackIdByIndex.size());
        ensureScratchSizes();
        publishRoutingSnapshot();
    }

    if (songToRestore != static_cast<size_t>(-1)
        && songToRestore < loader.project().songs.size()) {
        std::string selectError;
        if (!selectSong(songToRestore, selectError)) {
            error = "Saved, but failed to restage song: " + selectError;
            return false;
        }
        if (wasPlaying)
            play();
    }
    clearDirty();
    clearAutosave();
    return true;
}

void AudioEngine::purgeStaleSavePackages() {
    namespace fs = std::filesystem;
    for (const auto& p : staleSavePackages) {
        std::error_code ec;
        fs::remove_all(p, ec);
    }
    staleSavePackages.clear();
}

void AudioEngine::saveProjectAsync(const std::string& path,
                                   std::function<void(bool success, std::string error)> onComplete) {
    if (!projectLoaded) {
        if (onComplete)
            onComplete(false, "No project loaded");
        return;
    }
    if (busySaving.exchange(true) || busyImporting.load(std::memory_order_acquire)) {
        busySaving.store(false);
        if (onComplete)
            onComplete(false, "Already busy");
        return;
    }
    if (saveThread.joinable())
        saveThread.join();

    // Update display name on the live project before snapshotting.
    {
        const juce::String stem = juce::File(path).getFileNameWithoutExtension();
        if (stem.isNotEmpty())
            loader.project().name = stem.toStdString();
    }

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    const bool promotingDraft = usingDraftArchive && path != loader.archivePath();
    const std::string oldDraftPath = usingDraftArchive ? loader.archivePath() : std::string();
    const std::string sourcePath = loader.archivePath();
    const bool isContainer = loader.isDirectoryContainer();
    // Same-path overwrite of a directory package can swap under live FILE*
    // cursors (they keep reading the old inodes). Save-As / draft promote /
    // legacy ZIP still need a restage.
    const bool playThroughOk = isContainer && !promotingDraft && path == sourcePath && wasPlaying;
    Project snapshot = loader.project();
    auto extras = pendingPeakCacheExtras;
    const std::string tempOut = path + ".saving";

    // Heavy archive write off the message thread. Directory packages copy via
    // the filesystem (no shared zip handle). saveAsWithExtras no longer mutates
    // openArchivePath, so streaming keeps the correct live path the whole time.
    saveThread = std::thread([this, path, tempOut, snapshot, extras, sourcePath, promotingDraft,
                              oldDraftPath, songToRestore, wasPlaying, playThroughOk, isContainer,
                              onComplete]() mutable {
        std::string error;
        // Legacy ZIP shares mz_zip with streaming — serialize against IO.
        bool wrote = false;
        if (isContainer) {
            wrote = loader.saveAsWithExtras(tempOut, extras, error, &snapshot);
        } else {
            streaming.withProjectLoaderLock([&] {
                wrote = loader.saveAsWithExtras(tempOut, extras, error, &snapshot);
            });
        }

        juce::MessageManager::callAsync([this, wrote, error, path, tempOut, sourcePath, promotingDraft,
                                         oldDraftPath, songToRestore, wasPlaying, playThroughOk,
                                         onComplete]() {
            namespace fs = std::filesystem;
            auto finish = [&](bool ok, const std::string& err) {
                busySaving.store(false, std::memory_order_release);
                if (onComplete)
                    onComplete(ok, err);
            };

            if (!wrote) {
                std::error_code ec;
                fs::remove_all(tempOut, ec);
                finish(false, error.empty() ? "Save failed" : error);
                return;
            }

            std::error_code ec;

            if (playThroughOk) {
                // ── Titanic save: keep playing across the package swap ──
                // 1) rename live package aside (open FILE* keep old inodes)
                // 2) rename temp into place
                // 3) leave streaming alone; defer delete of the aside dir
                const std::string aside = path + ".play-old";
                fs::remove_all(aside, ec); // previous interrupted save
                fs::rename(path, aside, ec);
                if (ec) {
                    fs::remove_all(tempOut, ec);
                    finish(false, "Failed to park live package: " + ec.message());
                    return;
                }
                fs::rename(tempOut, path, ec);
                if (ec) {
                    // Roll back so openArchivePath still matches on-disk.
                    std::error_code ec2;
                    fs::rename(aside, path, ec2);
                    fs::remove_all(tempOut, ec2);
                    finish(false, "Failed to install saved package: " + ec.message());
                    return;
                }
                // Open stem FILE* still hold the old inodes after rename —
                // unlinking the aside tree is safe (POSIX); free disk ASAP.
                fs::remove_all(aside, ec);
                if (ec)
                    staleSavePackages.push_back(aside);
                // openArchivePath already equals `path`.
                usingDraftArchive = false;
                clearDirty();
                clearAutosave();
                finish(true, {});
                return;
            }

            // ── Classic path: stop streaming, replace, reopen, restage ──
            const bool keepPlaying = wasPlaying;
            stop();
            streaming.stop();
            joinPendingPeakBuilds();
            purgeStaleSavePackages(); // safe: no open stem FDs into old packages

            loader.close();
            fs::remove_all(path, ec);
            fs::rename(tempOut, path, ec);
            if (ec) {
                std::string recoverErr;
                (void)loader.open(sourcePath, recoverErr);
                projectLoaded = loader.isOpen();
                if (projectLoaded)
                    streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);
                finish(false, "Failed to replace archive: " + ec.message());
                return;
            }

            std::string openErr;
            if (!loader.open(path, openErr)) {
                projectLoaded = false;
                finish(false, openErr);
                return;
            }
            usingDraftArchive = false;
            if (promotingDraft && !oldDraftPath.empty() && oldDraftPath != path) {
                fs::remove_all(oldDraftPath, ec);
            }

            buildBusListFromProject();
            projectLoaded = true;
            streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);

            currentSong = static_cast<size_t>(-1);
            trackIdByIndex.clear();
            trackScratch.clear();
            trackGainSmooth.clear();
            clickSendSmooth.clear();
            trackMeters.clear();
            const auto& projTracks = loader.project().tracks;
            if (!projTracks.empty()) {
                for (const auto& t : projTracks)
                    trackIdByIndex.push_back(t.id);
                trackScratch.assign(trackIdByIndex.size(), juce::AudioBuffer<float>());
                ensureTrackMeters(trackIdByIndex.size());
                ensureScratchSizes();
                publishRoutingSnapshot();
            }

            if (songToRestore != static_cast<size_t>(-1)
                && songToRestore < loader.project().songs.size()) {
                std::string selectError;
                if (selectSong(songToRestore, selectError) && keepPlaying)
                    play();
            }
            clearDirty();
            clearAutosave();
            finish(true, {});
        });
    });
}


bool AudioEngine::selectSong(size_t songIndex, std::string& error, bool fireOnLoadEventsFlag) {
    return selectSongInternal(songIndex, error, fireOnLoadEventsFlag, /*gaplessKeepPlaying=*/false);
}

bool AudioEngine::selectSongInternal(size_t songIndex, std::string& error, bool fireOnLoadEventsFlag,
                                     bool gaplessKeepPlaying) {
    if (!gaplessKeepPlaying)
        stop();
    // else: leave the MIDI clock running -- continuous across the gapless
    // boundary; setClockBpm() below retunes it in place, no Stop/Start.

    if (!projectLoaded) {
        error = "No project loaded";
        return false;
    }

    const Project& proj = loader.project();
    if (songIndex >= proj.songs.size()) {
        error = "Song index out of range";
        return false;
    }
    const SongDef& song = proj.songs[songIndex];

    // While streams swap + playhead resets, audio must not read the new
    // rings at the old absolute sample position (see streamHandoff doc).
    // Gapless keeps playing=true across the handoff, so this flag is the
    // only thing that prevents a multi-minute skip into the next song.
    const bool handoff = gaplessKeepPlaying || playing.load(std::memory_order_acquire);
    if (handoff)
        streamHandoff.store(true, std::memory_order_release);

    // Promote/open streams first -- atomic shared_ptr swap inside stageSong,
    // safe concurrent with the audio thread holding a previous ActiveSongHandle.
    // Keep this OUTSIDE routingMutex: cold open can do disk I/O and must not
    // stall the audio callback for tens of ms (which itself causes underruns).
    const int64_t ringCapacityFrames = static_cast<int64_t>(currentSampleRate * kRingBufferSeconds);
    // Selecting a song while stopped: skip ring prime entirely — open headers
    // only (IO workers fill before Play). Gapless/playing handoff still primes
    // briefly so the first post-switch blocks aren't silent.
    const bool needPrime = gaplessKeepPlaying || playing.load(std::memory_order_acquire);
    const double primeSec = needPrime ? 0.25 : 0.0;
    const double primeWait = needPrime ? 0.08 : 0.0;
    if (!streaming.stageSong(songIndex, song, ringCapacityFrames, currentSampleRate, error, primeSec,
                             primeWait)) {
        streamHandoff.store(false, std::memory_order_release);
        return false;
    }
    // Previous song's StreamCursors are gone (or about to be after the audio
    // thread drops its ActiveSongHandle). Safe to drop packages parked by a
    // play-through save that could not be unlinked immediately.
    if (!gaplessKeepPlaying)
        purgeStaleSavePackages();

    // Deliberately NO hardSeekTo(0) on the gapless path: streamHandoff
    // already prevents the audio thread from reading rings between promote
    // and playhead-reset, and precached buffers are still at frame 0. A
    // full re-open+prime of every multi-100MB stem was the multi-tens-of-ms
    // "prolag" between songs.

    // Validate track -> bus assignments before staging UI/routing state.
    // An empty busId is valid and deliberate: a "sends-only" track with no
    // main/FOH destination, routed purely through its TrackSendDef entries
    // (publishRoutingSnapshot() already treats "busId not found" as simply
    // "no main route" -- only a *non-empty* dangling reference is an error).
    std::vector<std::string> newTrackIds;
    newTrackIds.reserve(proj.tracks.size());
    for (const TrackDef& trackDef : proj.tracks) {
        if (!trackDef.busId.empty() && busIndexById.find(trackDef.busId) == busIndexById.end()) {
            error = "Track '" + trackDef.id + "' references unknown bus '" + trackDef.busId + "'";
            return false;
        }
        newTrackIds.push_back(trackDef.id);
    }

    // Song length from the (already published) active staged song.
    int64_t newSongLengthFrames = 0;
    {
        StreamingEngine::ActiveSongHandle activeSong = streaming.acquireActiveSong();
        if (activeSong) {
            for (const std::string& trackId : newTrackIds) {
                if (StreamingTrackBuffer* buf = activeSong.track(trackId))
                    newSongLengthFrames = std::max(newSongLengthFrames, buf->totalFrames());
            }
        }
    }

    // Prepare click routing offline, publish under the lock below.
    int newClickTarget = -1;
    float newClickGain = 1.0f;
    std::vector<int> newClickSends;
    std::vector<float> newClickSendGains;
    const bool newClickEnabled = song.builtInClickEnabled;
    auto clickBusIt = busIndexById.find(song.builtInClickBusId.empty()
                                            ? (busses.empty() ? "" : busses.front().id)
                                            : song.builtInClickBusId);
    if (clickBusIt != busIndexById.end()) {
        newClickTarget = static_cast<int>(clickBusIt->second);
        newClickGain = dbToGain(loader.project().builtInClickGainDb);
    }
    for (const TrackSendDef& cs : song.builtInClickSends) {
        if (!cs.enabled)
            continue;
        auto it = busIndexById.find(cs.busId);
        if (it == busIndexById.end())
            continue;
        newClickSends.push_back(static_cast<int>(it->second));
        newClickSendGains.push_back(dbToGain(cs.gainDb));
    }

    // CRITICAL: every field the audio thread reads under routingMutex must
    // flip atomically relative to that lock. The previous code reassigned
    // trackScratch to a vector of EMPTY AudioBuffers *outside* the lock,
    // then called ensureScratchSizes() which blocked on the mutex -- so the
    // audio callback could (and did) try_to_lock successfully, read a null
    // getWritePointer/getReadPointer from a 0-channel buffer, and SIGSEGV
    // (see crash: audioDeviceIOCallbackWithContext @ busScratch.addSample
    // with srcL == nullptr, while the message thread was stuck in
    // ensureScratchSizes during gapless switchToSongGapless).
    {
        std::lock_guard<std::recursive_mutex> lock(routingMutex);

        trackIdByIndex = std::move(newTrackIds);
        trackScratch.assign(trackIdByIndex.size(), juce::AudioBuffer<float>());
        ensureTrackMeters(trackIdByIndex.size());
        // Inline ensureScratchSizes body while we already hold the lock
        // (recursive_mutex would allow re-entry, but keep it explicit).
        {
            const int busChannels = std::max<int>(2, static_cast<int>(busses.size()) * 2);
            const int samples = std::max(currentBlockSize, 1);
            busScratch.setSize(busChannels, samples, false, false, true);
            for (auto& scratch : trackScratch)
                scratch.setSize(2, samples, false, false, true);
            clickScratch.assign(static_cast<size_t>(samples), 0.0f);
        }

        currentSongLengthFrames = newSongLengthFrames;
        eventFiredFlags.assign(song.events.size(), 0);

        clickTargetBusIndex = newClickTarget;
        clickGainLinear = newClickGain;
        clickPan = static_cast<float>(
            std::clamp(loader.project().builtInClickPan, -1.0, 1.0));
        clickSendBusIndices = std::move(newClickSends);
        clickSendGainLinears = std::move(newClickSendGains);
        isClickEnabled = newClickEnabled;
        if (newClickTarget >= 0)
            clickGenerator.prepare(currentSampleRate, song.bpm, song.timeSignature.numerator);

        currentSong = songIndex;

        // Publish routing while still holding routingMutex (recursive).
        publishRoutingSnapshot();

        // Reset playhead + micro-fade state under the same lock the audio
        // thread uses for the whole mix/fade path, so it can never observe
        // "hold cleared, fade-in not yet armed" or a half-updated song.
        //
        // Sequence matters for MasterClock: stop first so the audio thread's
        // onAudioCallback becomes a no-op (it only re-anchors while
        // clock.isRunning()), THEN zero the free-run counter, THEN start at 0.
        // free-running fetch_add while stopped was the other half of the
        // gapless playhead-jump race.
        clock.stop();
        hwSamplePosition.store(0, std::memory_order_relaxed);
        underrunFadeOutRemaining = 0;
        underrunFadeOutLength = 0;
        lastCallbackWasUnderrun = false;
        lastCallbackHostNanos = 0;
        pendingSongEndAction = SongEndAction::None;
        // Soft edge into the new song. Gapless uses a short fade (~5ms @ 48k)
        // so the handoff doesn't feel like a hole; non-gapless keeps the
        // longer edge for cold starts / scrub landings.
        const int fadeIn = gaplessKeepPlaying ? 256 : kSongEndFadeSamples;
        recoveryFadeInLength = fadeIn;
        recoveryFadeInRemaining = fadeIn;
        outputHeldSilent = false;

        if (gaplessKeepPlaying) {
            // Stay in PLAYING: restart timeline at 0 without a stop/start gap.
            clock.start(currentSampleRate, 0);
            playing.store(true, std::memory_order_release);
            transportTelemetry.playheadSamples.store(0, std::memory_order_relaxed);
            transportTelemetry.playheadSeconds.store(0.0, std::memory_order_relaxed);
            transportTelemetry.running.store(true, std::memory_order_relaxed);
        } else {
            // Anchor frozen at 0; play() will start the clock later.
            clock.start(currentSampleRate, 0);
            clock.stop();
            transportTelemetry.playheadSamples.store(0, std::memory_order_relaxed);
            transportTelemetry.playheadSeconds.store(0.0, std::memory_order_relaxed);
            transportTelemetry.running.store(false, std::memory_order_relaxed);
        }

        // Streams + playhead are coherent at 0 -- audio may read again.
        resetMetersSilent();
        streamHandoff.store(false, std::memory_order_release);
    }

    if (gaplessKeepPlaying)
        midiDispatcher.setClockBpm(song.bpm); // smooth retune, no phase reset/Stop/Start

    rebuildTrackPeaks();

    if (fireOnLoadEventsFlag)
        fireOnLoadEvents(song);

    // Precache only the sequential neighbour (AutoplayNext / Next button).
    // Random hops (song 0 → 7) do cold stage; we never keep filling a stale
    // "next" for a song the user left. Epoch aborts in-flight jobs if the
    // user hopscotches before this async runs.
    if (songIndex + 1 < proj.songs.size()) {
        const size_t nextIdx = songIndex + 1;
        const int64_t ringCap = ringCapacityFrames;
        const double sr = currentSampleRate;
        const uint64_t epoch = streaming.stageEpoch();
        juce::MessageManager::callAsync([this, nextIdx, ringCap, sr, epoch] {
            if (!projectLoaded)
                return;
            if (streaming.stageEpoch() != epoch)
                return; // user already staged another song
            const Project& p = loader.project();
            if (currentSong + 1 != nextIdx || nextIdx >= p.songs.size())
                return;
            if (streaming.hasPrecacheFor(nextIdx))
                return;
            streaming.precacheSong(nextIdx, p.songs[nextIdx], ringCap, sr, epoch);
        });
    } else {
        // Last song — nothing sequential to keep warm.
        streaming.dropPrecacheUnless(static_cast<size_t>(-1));
    }

    return true;
}

bool AudioEngine::switchToSongGapless(size_t songIndex, std::string& error) {
    return selectSongInternal(songIndex, error, /*fireOnLoadEvents=*/true, /*gaplessKeepPlaying=*/true);
}

bool AudioEngine::consumeGaplessAdvance(size_t& outSongIndex) {
    const int pending = pendingGaplessSong.exchange(-1, std::memory_order_acq_rel);
    if (pending < 0)
        return false;
    outSongIndex = static_cast<size_t>(pending);
    return true;
}

bool AudioEngine::consumeGaplessUiNotify(size_t& outSongIndex) {
    const int pending = pendingGaplessUiNotify.exchange(-1, std::memory_order_acq_rel);
    if (pending < 0)
        return false;
    outSongIndex = static_cast<size_t>(pending);
    return true;
}

void AudioEngine::resetMetersSilent() {
    const MeterFrame silent{};
    for (auto& m : trackMeters)
        if (m != nullptr)
            m->write(silent);
    for (size_t i = 0; i < busMeters.size(); ++i) {
        if (i < busLoudnessMeters.size())
            busLoudnessMeters[i].reset();
        if (busMeters[i] != nullptr)
            busMeters[i]->write(silent);
    }
    clickMeterFrame.write(silent);
}

bool AudioEngine::tryGaplessPromoteOnAudioThread(size_t nextSongIndex) {
    if (!projectLoaded || nextSongIndex >= loader.project().songs.size())
        return false;
    if (!streaming.tryPromotePrecached(nextSongIndex))
        return false;

    const SongDef& song = loader.project().songs[nextSongIndex];

    // Length from the just-promoted buffers (device domain).
    int64_t newLen = 0;
    {
        StreamingEngine::ActiveSongHandle activeSong = streaming.acquireActiveSong();
        if (activeSong) {
            for (const std::string& trackId : trackIdByIndex) {
                if (StreamingTrackBuffer* buf = activeSong.track(trackId))
                    newLen = std::max(newLen, buf->totalFrames());
            }
        }
    }

    // Click routing for the new song (same fields the message-thread path sets).
    int newClickTarget = -1;
    float newClickGain = 1.0f;
    std::vector<int> newClickSends;
    std::vector<float> newClickSendGains;
    const bool newClickEnabled = song.builtInClickEnabled;
    auto clickBusIt = busIndexById.find(song.builtInClickBusId.empty()
                                            ? (busses.empty() ? "" : busses.front().id)
                                            : song.builtInClickBusId);
    if (clickBusIt != busIndexById.end()) {
        newClickTarget = static_cast<int>(clickBusIt->second);
        newClickGain = dbToGain(loader.project().builtInClickGainDb);
    }
    for (const TrackSendDef& cs : song.builtInClickSends) {
        if (!cs.enabled)
            continue;
        auto it = busIndexById.find(cs.busId);
        if (it == busIndexById.end())
            continue;
        newClickSends.push_back(static_cast<int>(it->second));
        newClickSendGains.push_back(dbToGain(cs.gainDb));
    }

    // Apply under the same mutex the render path holds, so the first post-
    // handoff callback sees a coherent song 0 / click / length snapshot.
    // We already hold nothing here (called from the render path before the
    // routeLock section finishes fade) -- try_lock; if contended, fall back.
    std::unique_lock<std::recursive_mutex> lock(routingMutex, std::try_to_lock);
    if (!lock.owns_lock()) {
        // Streams already promoted -- leave streamHandoff true and ask the
        // message thread to finish state via switchToSongGapless.
        pendingGaplessSong.store(static_cast<int>(nextSongIndex), std::memory_order_release);
        return false;
    }

    currentSong = nextSongIndex;
    currentSongLengthFrames = newLen;
    eventFiredFlags.assign(song.events.size(), 0);
    clickTargetBusIndex = newClickTarget;
    clickGainLinear = newClickGain;
    clickPan = static_cast<float>(
        std::clamp(loader.project().builtInClickPan, -1.0, 1.0));
    clickSendBusIndices = std::move(newClickSends);
    clickSendGainLinears = std::move(newClickSendGains);
    isClickEnabled = newClickEnabled;
    if (newClickTarget >= 0)
        clickGenerator.prepare(currentSampleRate, song.bpm, song.timeSignature.numerator);

    clock.stop();
    hwSamplePosition.store(0, std::memory_order_relaxed);
    underrunFadeOutRemaining = 0;
    underrunFadeOutLength = 0;
    lastCallbackWasUnderrun = false;
    lastCallbackHostNanos = 0;
    pendingSongEndAction = SongEndAction::None;
    recoveryFadeInLength = 256;
    recoveryFadeInRemaining = 256;
    outputHeldSilent = false;
    clock.start(currentSampleRate, 0);
    playing.store(true, std::memory_order_release);
    transportTelemetry.playheadSamples.store(0, std::memory_order_relaxed);
    transportTelemetry.playheadSeconds.store(0.0, std::memory_order_relaxed);
    transportTelemetry.running.store(true, std::memory_order_relaxed);
    resetMetersSilent();
    streamHandoff.store(false, std::memory_order_release);

    midiDispatcher.setClockBpm(song.bpm);
    pendingGaplessUiNotify.store(static_cast<int>(nextSongIndex), std::memory_order_release);
    autoAdvancePending.store(false, std::memory_order_release);

    // Precache the song after this one (message thread will also try; best-effort).
    if (nextSongIndex + 1 < loader.project().songs.size()) {
        const int64_t ringCapacityFrames = static_cast<int64_t>(currentSampleRate * kRingBufferSeconds);
        // Cannot safely open files on the audio thread -- leave precache to UI tick.
        (void)ringCapacityFrames;
    }
    return true;
}

void AudioEngine::play() {
    if (currentSong == static_cast<size_t>(-1))
        return;

    // Resume from the current anchor (0 after selectSong, or last seek/stop pos).
    // Defensively clamped to the song's actual length: this anchor should
    // never legitimately exceed it (selectSong resets to 0, seekToSeconds
    // clamps to [0, length]), but resuming beyond the end would otherwise
    // manifest as "Play does nothing audible" -- the render callback's
    // song-end check fires on the very first block and immediately stops
    // again before any audio is produced.
    int64_t startSample = clock.currentSamplePosition();
    if (currentSongLengthFrames > 0 && startSample >= currentSongLengthFrames)
        startSample = 0;
    // If starting from the beginning of a song, re-arm timeline events.
    if (startSample <= 0)
        std::fill(eventFiredFlags.begin(), eventFiredFlags.end(), 0);

    // Brief prime only — long waits froze Play after song switch. IO workers
    // + async RAM residency keep filling after the clock starts.
    (void)streaming.primeActiveSong(0.4, currentSampleRate, 0.15);

    // Reset the raw hardware sample counter BEFORE (re)starting MasterClock.
    // hwSamplePosition free-runs continuously since the audio device
    // started, incrementing every callback regardless of `playing` (see
    // audioDeviceIOCallbackWithContext -- the fetch_add happens
    // unconditionally, before the playing check). Without this reset, the
    // very next callback after play() re-anchors MasterClock to that stale,
    // ever-growing counter, instantly jumping the playhead forward by
    // however long playback was stopped -- including the entire gap between
    // app/device startup and the first Play, or between Stop and the next
    // Play. Stored before clock.start() (which release-stores
    // MasterClock::running) so the audio thread's acquire-load of running
    // is guaranteed to also observe this reset (release/acquire
    // synchronizes-with, not a torn race).
    hwSamplePosition.store(startSample, std::memory_order_relaxed);
    clock.start(currentSampleRate, startSample);

    const Project& proj = loader.project();
    if (currentSong < proj.songs.size()) {
        const double bpm = proj.songs[currentSong].bpm;
        // First transport start this project -> MIDI Start (0xFA), fresh
        // phase. Every later play() (resume from pause/stop, anywhere in the
        // project) -> MIDI Continue (0xFB), preserving phase -- deliberately
        // NOT keyed on `startSample <= 0`, since seeking to the very start of
        // e.g. song 3 mid-project must not look like a whole-set restart.
        if (!midiClockEverStarted) {
            midiDispatcher.startClock(bpm, SystemMonotonicClock{}.nowNanos());
            midiClockEverStarted = true;
        } else {
            midiDispatcher.continueClock(bpm);
        }
    }

    playing.store(true, std::memory_order_release);
}

void AudioEngine::stop() {
    // Freeze the playhead at the current position so Stop/Play resumes rather
    // than jumping to 0 (explicit restarts go through selectSong / seek).
    if (playing.load(std::memory_order_acquire)) {
        const int64_t pos = clock.currentSamplePosition();
        clock.start(currentSampleRate, pos);
    }
    playing.store(false, std::memory_order_release);
    clock.stop();
    midiDispatcher.stopClock();

    transportTelemetry.playheadSamples.store(clock.currentSamplePosition(), std::memory_order_relaxed);
    transportTelemetry.playheadSeconds.store(clock.currentSeconds(), std::memory_order_relaxed);
    transportTelemetry.running.store(false, std::memory_order_relaxed);
    // Flush autosave that was deferred during play (SSD stays free mid-show).
    flushDeferredAutosave();
}

void AudioEngine::stopToStart() {
    if (!projectLoaded || currentSong == static_cast<size_t>(-1)) {
        stop();
        return;
    }

    // A few ms of tolerance so a seek that landed a handful of samples off
    // zero (rounding in seconds<->sample conversion) still counts as "at the
    // start" on the second press, rather than requiring bit-exact 0.
    const int64_t epsilonSamples = static_cast<int64_t>(currentSampleRate * 0.05);
    const bool atSongStart = clock.currentSamplePosition() <= epsilonSamples;

    if (atSongStart && currentSong != 0) {
        // Second press (already at this song's start): rewind to the very
        // beginning of the whole project. selectSong() halts playback itself.
        std::string error;
        selectSong(0, error);
        return;
    }

    // First press (or already at the project's own start): halt, then
    // rewind the current song to 0. stop() first so seekToSeconds's
    // wasPlaying capture reads false and the result is a genuine stop, not
    // "seek while still playing".
    stop();
    std::string error;
    seekToSeconds(0.0, error);
}

bool AudioEngine::seekToSeconds(double seconds, std::string& error, size_t songIndex) {
    if (!projectLoaded || currentSong == static_cast<size_t>(-1)) {
        error = "No song selected";
        return false;
    }

    const bool wasPlaying = playing.load(std::memory_order_acquire);
    const size_t targetSong = (songIndex == static_cast<size_t>(-1)) ? currentSong : songIndex;
    if (targetSong >= loader.project().songs.size()) {
        error = "Song index out of range";
        return false;
    }

    const bool sameSong = (targetSong == currentSong);

    // Cross-song: full restage (StreamingTrackBuffer is forward-only per open).
    // Same-song: hard-seek in place WITHOUT stop/play -- scrub used to call
    // selectSong (which stops) then restart, producing a one-buffer "blip
    // then silence then play" glitch on every drag.
    if (!sameSong) {
        if (!selectSong(targetSong, error, /*fireOnLoadEvents=*/false))
            return false;
    }

    double maxSec = currentSongLengthSeconds();
    if (maxSec <= 0.0)
        maxSec = 24 * 3600.0;
    seconds = std::clamp(seconds, 0.0, maxSec);
    const int64_t sample = static_cast<int64_t>(seconds * currentSampleRate);

    // Mute stream reads while we re-park the rings at `sample`.
    streamHandoff.store(true, std::memory_order_release);
    if (!streaming.seekActiveSongTo(sample, error)) {
        streamHandoff.store(false, std::memory_order_release);
        return false;
    }

    // Mark past events as already fired so seek doesn't re-trigger them.
    const Project& proj = loader.project();
    if (targetSong < proj.songs.size()) {
        const SongDef& song = proj.songs[targetSong];
        eventFiredFlags.assign(song.events.size(), 0);
        for (size_t i = 0; i < song.events.size(); ++i) {
            const TimelineEvent& ev = song.events[i];
            if (ev.triggerOnLoad)
                continue;
            const double fireAt = ev.timeSeconds - (ev.latencyCompensationMs / 1000.0);
            if (fireAt <= seconds)
                eventFiredFlags[i] = 1;
        }
    }

    {
        std::lock_guard<std::recursive_mutex> lock(routingMutex);
        hwSamplePosition.store(sample, std::memory_order_relaxed);
        underrunFadeOutRemaining = 0;
        underrunFadeOutLength = 0;
        outputHeldSilent = false;
        // Very short edge on scrub (same-song) so it doesn't feel like a stop.
        const int fadeIn = sameSong ? 64 : kUnderrunFadeSamples;
        recoveryFadeInLength = fadeIn;
        recoveryFadeInRemaining = fadeIn;
        pendingSongEndAction = SongEndAction::None;
        lastCallbackWasUnderrun = false;
        lastCallbackHostNanos = 0;
        clock.start(currentSampleRate, sample);
        transportTelemetry.playheadSamples.store(sample, std::memory_order_relaxed);
        transportTelemetry.playheadSeconds.store(seconds, std::memory_order_relaxed);
        resetMetersSilent();

        if (wasPlaying || sameSong) {
            // sameSong keeps transport running across the seek; cross-song
            // restores prior wasPlaying after restage.
            if (wasPlaying) {
                playing.store(true, std::memory_order_release);
                transportTelemetry.running.store(true, std::memory_order_relaxed);
            } else {
                clock.stop();
                playing.store(false, std::memory_order_release);
                transportTelemetry.running.store(false, std::memory_order_relaxed);
            }
        } else {
            clock.stop();
            transportTelemetry.running.store(false, std::memory_order_relaxed);
        }
        streamHandoff.store(false, std::memory_order_release);
    }

    if (wasPlaying && targetSong < proj.songs.size()) {
        const double globalBeats = globalBeatsElapsed();
        const long long sixteenths = std::llround(globalBeats * 4.0);
        const uint16_t midiBeats16 = static_cast<uint16_t>(std::clamp<long long>(sixteenths, 0, 16383));
        midiDispatcher.sendSongPositionPointer(midiBeats16);
        if (sameSong)
            midiDispatcher.continueClock(proj.songs[targetSong].bpm);
        else
            midiDispatcher.continueClock(proj.songs[targetSong].bpm);
    }
    return true;
}

void AudioEngine::dispatchEvent(const TimelineEvent& ev, uint64_t targetHostTimeNanos) {
    switch (ev.type) {
        case EventType::MidiNoteOn: {
            MidiCommand cmd;
            cmd.kind = MidiCommandKind::NoteOn;
            cmd.channel = static_cast<uint8_t>(std::clamp(ev.midiChannel - 1, 0, 15));
            cmd.data1 = static_cast<uint8_t>(std::clamp(ev.midiNote, 0, 127));
            cmd.data2 = static_cast<uint8_t>(std::clamp(ev.midiVelocity, 0, 127));
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            midiDispatcher.enqueue(cmd);
            break;
        }
        case EventType::MidiNoteOff: {
            MidiCommand cmd;
            cmd.kind = MidiCommandKind::NoteOff;
            cmd.channel = static_cast<uint8_t>(std::clamp(ev.midiChannel - 1, 0, 15));
            cmd.data1 = static_cast<uint8_t>(std::clamp(ev.midiNote, 0, 127));
            cmd.data2 = static_cast<uint8_t>(std::clamp(ev.midiVelocity, 0, 127));
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            midiDispatcher.enqueue(cmd);
            break;
        }
        case EventType::MidiCC: {
            MidiCommand cmd;
            cmd.kind = MidiCommandKind::ControlChange;
            cmd.channel = static_cast<uint8_t>(std::clamp(ev.midiChannel - 1, 0, 15));
            cmd.data1 = static_cast<uint8_t>(std::clamp(ev.midiCC, 0, 127));
            cmd.data2 = static_cast<uint8_t>(std::clamp(ev.midiCCValue, 0, 127));
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            midiDispatcher.enqueue(cmd);
            break;
        }
        case EventType::MidiProgramChange: {
            MidiCommand cmd;
            cmd.kind = MidiCommandKind::ProgramChange;
            cmd.channel = static_cast<uint8_t>(std::clamp(ev.midiChannel - 1, 0, 15));
            cmd.data1 = static_cast<uint8_t>(std::clamp(ev.midiProgram, 0, 127));
            cmd.targetHostTimeNanos = targetHostTimeNanos;
            midiDispatcher.enqueue(cmd);
            break;
        }
        case EventType::Http: {
            HttpTriggerCommand cmd;
            cmd.url = ev.httpUrl;
            cmd.method = ev.httpMethod;
            cmd.body = ev.httpBody;
            eventDispatcher.enqueueHttp(cmd);
            break;
        }
        case EventType::Dmx: {
            DmxTriggerCommand cmd;
            cmd.universe = ev.dmxUniverse;
            cmd.data = ev.dmxData;
            eventDispatcher.enqueueDmx(cmd);
            break;
        }
    }
}

void AudioEngine::fireOnLoadEvents(const SongDef& song) {
    const uint64_t now = SystemMonotonicClock{}.nowNanos();
    for (const TimelineEvent& ev : song.events)
        if (ev.triggerOnLoad)
            dispatchEvent(ev, now);
}

void AudioEngine::fireDueEvents(const SongDef& song, double blockStartSeconds, double blockEndSeconds,
                                 uint64_t hostTimeNanosAtBlockStart) {
    for (size_t i = 0; i < song.events.size() && i < eventFiredFlags.size(); ++i) {
        const TimelineEvent& ev = song.events[i];
        if (ev.triggerOnLoad || eventFiredFlags[i] != 0)
            continue;

        const double fireAtSeconds = ev.timeSeconds - (ev.latencyCompensationMs / 1000.0);
        if (fireAtSeconds > blockEndSeconds)
            continue;

        // Events already in the past when we get to them (e.g. several were
        // skipped during a MasterClock catch-up jump) fire as soon as
        // possible rather than being silently dropped.
        const double offsetSeconds = std::max(0.0, fireAtSeconds - blockStartSeconds);
        const uint64_t targetHostTimeNanos = hostTimeNanosAtBlockStart + static_cast<uint64_t>(offsetSeconds * 1.0e9);

        dispatchEvent(ev, targetHostTimeNanos);
        eventFiredFlags[i] = 1;
    }
}

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice* device) {
    currentSampleRate = device->getCurrentSampleRate();
    currentBlockSize = device->getCurrentBufferSizeSamples();
    hwSamplePosition.store(0, std::memory_order_relaxed);
    lastCallbackHostNanos = 0;

    for (auto& meter : busLoudnessMeters)
        meter.prepare(currentSampleRate, 2);

    ensureScratchSizes();
}

void AudioEngine::audioDeviceStopped() {
    // Deliberately does NOT stop MasterClock: this callback fires when the
    // underlying device is torn down (e.g. a hot-unplug), which is exactly
    // the case checkForDeviceLoss() is watching for via the paired
    // AudioDeviceManager change notification -- the timeline should keep
    // advancing through that gap. An explicit user Stop goes through the
    // public stop() method instead, which does stop the clock.
    playing.store(false, std::memory_order_release);
}

void AudioEngine::audioDeviceIOCallbackWithContext(const float* const* /*inputChannelData*/,
                                                     int /*numInputChannels*/,
                                                     float* const* outputChannelData,
                                                     int numOutputChannels,
                                                     int numSamples,
                                                     const juce::AudioIODeviceCallbackContext& context) {
    for (int ch = 0; ch < numOutputChannels; ++ch)
        if (outputChannelData[ch] != nullptr)
            std::fill(outputChannelData[ch], outputChannelData[ch] + numSamples, 0.0f);

    // Debug-only manual stall injection -- see simulateUnderrun()'s doc comment.
    const double stallMs = simulatedStallMs.exchange(0.0, std::memory_order_acq_rel);
    if (stallMs > 0.0)
        std::this_thread::sleep_for(std::chrono::duration<double, std::milli>(stallMs));

    // JUCE's CoreAudio backend sets context.hostTimeNs to point directly at
    // AudioTimeStamp::mHostTime -- despite the name, that's raw
    // mach_absolute_time() TICKS, not nanoseconds (see juce_CoreAudio_mac.cpp,
    // `AudioIODeviceCallbackContext context { inNow != nullptr ? &inNow->mHostTime : nullptr }`).
    // Using it unconverted here corrupted MasterClock's elapsed-time math by
    // the timebase ratio (~41.7x observed), which rockets the playhead
    // billions of samples ahead within the first couple of callbacks and
    // immediately trips the song-end-reached check -- i.e. "press Play, it
    // jumps to some timestamp and stops instantly, nothing audible plays".
    const uint64_t hostTimeNanos = (context.hostTimeNs != nullptr)
                                        ? SystemMonotonicClock::ticksToNanos(*context.hostTimeNs)
                                        : SystemMonotonicClock{}.nowNanos();
    // Sample-accurate render playhead for THIS block. Driven by the free-run
    // hardware counter (incremented once per callback while the transport
    // clock is running), NOT by MasterClock's wall-clock free-run projection.
    // Using the wall-clock value here used to let WAV reads and the built-in
    // click diverge under PI-loop gamma corrections / host-time jitter --
    // the click is pure math on playheadSample while stems come from disk at
    // the same index, so they must share a single, sample-locked position.
    // MasterClock still tracks wall-clock for UI/MIDI fail-safe telemetry.
    int64_t renderPlayheadSample = clock.currentSamplePosition();
    const bool clockRunning = clock.isRunning();
    if (clockRunning) {
        // Only advance the free-run hardware counter while the transport
        // clock is running. Free-running across Stop / the gapless song-end
        // hold raced a concurrent message-thread store(0)+start(0) and
        // re-anchored song B's playhead to a multi-million-sample value.
        const int64_t hwPos = hwSamplePosition.fetch_add(numSamples, std::memory_order_relaxed);
        clock.onAudioCallback(hostTimeNanos, hwPos);
        renderPlayheadSample = hwPos;
    }

    systemHealth.noteAudioCallback();
    // Underrun heuristic: gap between consecutive callbacks more than 2.5x the
    // expected block duration (or an explicit simulateUnderrun stall).
    // Skip while the transport clock is stopped -- gapless handoff deliberately
    // parks the clock for a few blocks and must not look like a dropout.
    bool underrunThisCallback = false;
    if (clockRunning && lastCallbackHostNanos != 0 && currentSampleRate > 0.0 && numSamples > 0) {
        const double expectedNs = (static_cast<double>(numSamples) / currentSampleRate) * 1.0e9;
        const double gapNs = static_cast<double>(hostTimeNanos - lastCallbackHostNanos);
        if (gapNs > expectedNs * 2.5 || stallMs > 0.0) {
            systemHealth.noteUnderrun();
            underrunThisCallback = true;
            underrunFadeOutLength = kUnderrunFadeSamples;
            underrunFadeOutRemaining = kUnderrunFadeSamples;
        }
    }
    // After an underrun gap, start a short fade-in so recovery isn't a click.
    if (lastCallbackWasUnderrun && !underrunThisCallback) {
        outputHeldSilent = false;
        recoveryFadeInLength = kUnderrunFadeSamples;
        recoveryFadeInRemaining = kUnderrunFadeSamples;
    }
    lastCallbackWasUnderrun = underrunThisCallback;
    if (clockRunning)
        lastCallbackHostNanos = hostTimeNanos;

    // Telemetry prefers the sample-accurate render position while playing so
    // the UI playhead tracks the actual audio, not a wall-clock estimate.
    const int64_t telemetrySamples = clockRunning ? renderPlayheadSample : clock.currentSamplePosition();
    const double telemetrySeconds = (currentSampleRate > 0.0)
                                        ? static_cast<double>(telemetrySamples) / currentSampleRate
                                        : clock.currentSeconds();
    transportTelemetry.playheadSamples.store(telemetrySamples, std::memory_order_relaxed);
    transportTelemetry.playheadSeconds.store(telemetrySeconds, std::memory_order_relaxed);
    transportTelemetry.sampleRate.store(clock.sampleRate(), std::memory_order_relaxed);
    transportTelemetry.driftFactor.store(clock.driftFactor(), std::memory_order_relaxed);
    transportTelemetry.running.store(playing.load(std::memory_order_relaxed), std::memory_order_relaxed);

    if (!playing.load(std::memory_order_acquire)) {
        // Declick tail: the first silent callback right after a Stop/Pause
        // ramps the last real output sample on each channel down to zero
        // instead of a hard cut -- see kStopDeclickSamples' doc comment.
        if (wasPlayingLastCallback) {
            stopDeclickRemaining = kStopDeclickSamples;
            if (static_cast<int>(lastOutputSample.size()) < numOutputChannels)
                lastOutputSample.resize(static_cast<size_t>(numOutputChannels), 0.0f);
        }
        wasPlayingLastCallback = false;

        if (stopDeclickRemaining > 0) {
            const int declickSamples = std::min(numSamples, stopDeclickRemaining);
            for (int ch = 0; ch < numOutputChannels; ++ch) {
                if (outputChannelData[ch] == nullptr)
                    continue;
                const float start = (static_cast<size_t>(ch) < lastOutputSample.size())
                                        ? lastOutputSample[static_cast<size_t>(ch)]
                                        : 0.0f;
                for (int i = 0; i < declickSamples; ++i) {
                    const int remaining = stopDeclickRemaining - i;
                    const float g = static_cast<float>(remaining)
                                     / static_cast<float>(kStopDeclickSamples);
                    outputChannelData[ch][i] = start * g;
                }
            }
            stopDeclickRemaining -= declickSamples;
        }

        // See metersSilencedSinceStop's doc comment: without this, meters
        // hold their last playing-state value forever instead of dropping to
        // silence once transport stops.
        if (!metersSilencedSinceStop) {
            const MeterFrame silent{};
            for (auto& m : trackMeters)
                if (m != nullptr)
                    m->write(silent);
            for (size_t i = 0; i < busMeters.size(); ++i) {
                if (i < busLoudnessMeters.size())
                    busLoudnessMeters[i].reset();
                if (busMeters[i] != nullptr)
                    busMeters[i]->write(silent);
            }
            clickMeterFrame.write(silent);
            metersSilencedSinceStop = true;
        }
        // Keep this live even while stopped. The underrun check above
        // already skips itself while !clockRunning, so it wouldn't fire
        // *now* either way -- but if left stale from before Stop/Pause,
        // the gap computed on the very first callback after Play resumes
        // would span the *entire pause*, tripping a false underrun the
        // instant transport restarts. A genuine dropout is still caught
        // (the gap is measured from here, not from further back).
        lastCallbackHostNanos = hostTimeNanos;
        return;
    }
    metersSilencedSinceStop = false;
    wasPlayingLastCallback = true;

    // Gapless / restage handoff: keep outputs silent and do not touch rings
    // until the message thread has reset the playhead to match the new song.
    if (streamHandoff.load(std::memory_order_acquire))
        return;

    const std::shared_ptr<const RoutingSnapshot> snap = routing.acquireForRender();
    if (snap == nullptr || busses.empty())
        return;

    std::unique_lock<std::recursive_mutex> routeLock(routingMutex, std::try_to_lock);
    if (!routeLock.owns_lock())
        return;


    StreamingEngine::ActiveSongHandle activeSong = streaming.acquireActiveSong();

    if (!activeSong)
        return;

    const int64_t playheadSample = renderPlayheadSample;

    const Project& proj = loader.project();
    if (currentSong < proj.songs.size()) {
        const SongDef& song = proj.songs[currentSong];

        const double blockStartSeconds = static_cast<double>(playheadSample) / currentSampleRate;
        const double blockEndSeconds = static_cast<double>(playheadSample + numSamples) / currentSampleRate;
        fireDueEvents(song, blockStartSeconds, blockEndSeconds, hostTimeNanos);

        // Arm as soon as the fade window (kSongEndFadeSamples before the real
        // end) first overlaps this block -- NOT once we're already past the
        // end. StreamingTrackBuffer::read() only starts returning silence
        // once the ring truly runs dry, which can happen mid-block; arming
        // reactively (checking playheadSample >= currentSongLengthFrames)
        // means the block that actually contains the real hard cutoff (real
        // audio for the first `got` samples, then abrupt zero for the rest,
        // since trackScratch is .clear()-ed before every read()) has already
        // gone by, fully unramped, before we ever notice -- that abrupt
        // in-block step is the crackle, and by the time we react the ramp
        // only has already-silent audio left to multiply, doing nothing.
        // Starting the ramp `kSongEndFadeSamples` early guarantees gain has
        // decayed to ~0 by the time the real cutoff sample arrives, so the
        // step lands on already-near-silent audio and is inaudible.
        const int64_t fadeArmSample = currentSongLengthFrames - kSongEndFadeSamples;
        if (currentSongLengthFrames > 0 && playheadSample + numSamples >= fadeArmSample) {
            if (pendingSongEndAction == SongEndAction::None) {
                if (underrunFadeOutRemaining <= 0) {
                    underrunFadeOutLength = kSongEndFadeSamples;
                    underrunFadeOutRemaining = kSongEndFadeSamples;
                }
                pendingSongEndAction = (song.playbackMode == PlaybackMode::AutoplayNext
                                         && currentSong + 1 < proj.songs.size())
                                            ? SongEndAction::GaplessAdvance
                                            : SongEndAction::StopTransport;
                pendingSongEndTargetSong = currentSong + 1;
            }
        }
        // Deliberately do NOT clear pendingSongEndAction when playhead is
        // briefly before fadeArmSample: that used to self-heal mid-handoff
        // and drop a GaplessAdvance. Fresh songs reset it in selectSongInternal.
    }

    // Pass 1: pull this block's audio from each track's stream exactly once
    // (a track may feed multiple busses, but must only be read from its ring
    // buffer once per block -- see StreamingTrackBuffer's class comment).
    // trackScratch is always sized under routingMutex (which we hold). Defensive
    // size check still guards a future mismatch if block size grows mid-run.
    //
    // Region windowing: streams are region-keyed (see StreamingEngine::stageSong).
    // We map the song playhead into the source file via
    //   fileFrame = playhead - regionStart + sourceOffset
    // and force silence outside [start, start+duration). Without this the
    // file kept playing after the clip's visual end, then hit EOF and
    // flashed meters. Fades + region gain are applied sample-accurately here.
    for (size_t t = 0; t < trackIdByIndex.size(); ++t) {
        if (t >= trackScratch.size())
            break;
        juce::AudioBuffer<float>& scratch = trackScratch[t];
        if (scratch.getNumChannels() < 1 || scratch.getNumSamples() < numSamples)
            continue;
        scratch.clear();

        const std::string& trackId = trackIdByIndex[t];
        const Region* reg = nullptr;
        if (currentSong < proj.songs.size()) {
            const SongDef& song = proj.songs[currentSong];
            const double blockT0 = static_cast<double>(playheadSample) / currentSampleRate;
            const double blockT1 = static_cast<double>(playheadSample + numSamples) / currentSampleRate;
            const Region* fallback = nullptr;
            for (const Region& r : song.regions) {
                if (r.trackId != trackId)
                    continue;
                if (fallback == nullptr)
                    fallback = &r;
                const double dur = regionEffectiveDurationSeconds(r);
                const double end = r.startSeconds + dur;
                if (blockT1 > r.startSeconds && blockT0 < end) {
                    reg = &r;
                    break;
                }
            }
            if (reg == nullptr)
                reg = fallback;
        }

        StreamingTrackBuffer* buf = nullptr;
        if (reg != nullptr)
            buf = activeSong.region(reg->id);
        if (buf == nullptr)
            buf = activeSong.track(trackId);
        if (buf == nullptr)
            continue;

        const int trackChannels = std::min(2, buf->numChannels());
        float* ptrs[2] = {scratch.getWritePointer(0), trackChannels > 1 ? scratch.getWritePointer(1) : scratch.getWritePointer(0)};
        if (ptrs[0] == nullptr)
            continue;

        const double sr = std::max(1.0, currentSampleRate);
        const int64_t regStart = reg != nullptr
            ? static_cast<int64_t>(std::llround(reg->startSeconds * sr)) : 0;
        const double regDurSec = reg != nullptr ? regionEffectiveDurationSeconds(*reg) : 0.0;
        const int64_t regLen = reg != nullptr
            ? std::max<int64_t>(0, static_cast<int64_t>(std::llround(regDurSec * sr))) : 0;
        const int64_t regEnd = regStart + regLen;
        const int64_t srcOff = reg != nullptr
            ? static_cast<int64_t>(std::llround(reg->sourceOffsetSeconds * sr)) : 0;
        const int64_t fadeInN = reg != nullptr
            ? static_cast<int64_t>(std::llround(std::max(0.0, reg->fadeInSeconds) * sr)) : 0;
        const int64_t fadeOutN = reg != nullptr
            ? static_cast<int64_t>(std::llround(std::max(0.0, reg->fadeOutSeconds) * sr)) : 0;
        const float regGain = reg != nullptr ? dbToGain(reg->gainDb) : 1.0f;
        const double fadeInCurve = reg != nullptr ? reg->fadeInCurve : 0.0;
        const double fadeOutCurve = reg != nullptr ? reg->fadeOutCurve : 0.0;
        const bool loop = reg != nullptr && reg->loop;
        // Available source frames from sourceOffset to end of file.
        const int64_t totalSrc = buf->totalFrames();
        const int64_t sourceAvail = std::max<int64_t>(0, totalSrc - srcOff);

        const bool fullyOutside = reg != nullptr
            && (playheadSample + numSamples <= regStart || playheadSample >= regEnd);

        if (!fullyOutside) {
            // Map song timeline → source file frames for this region.
            // Non-loop: filePos = intoRegion + srcOff (silence past sourceAvail).
            // Loop:     filePos = (intoRegion % sourceAvail) + srcOff so a
            // clip longer than its source material cycles the content.
            //
            // When looping, consecutive samples may wrap -- we still do a
            // single linear read for the common non-wrap case, then patch
            // wrapped samples (rare within one block if sourceAvail is large).
            const int64_t into0 = playheadSample - regStart; // may be negative before start
            auto mapFilePos = [&](int64_t intoRegion) -> int64_t {
                if (intoRegion < 0)
                    return -1;
                if (sourceAvail <= 0)
                    return -1;
                if (loop) {
                    int64_t m = intoRegion % sourceAvail;
                    if (m < 0) m += sourceAvail;
                    return srcOff + m;
                }
                if (intoRegion >= sourceAvail)
                    return -1;
                return srcOff + intoRegion;
            };

            const int64_t filePosAtStart = mapFilePos(into0);
            // Fast path: contiguous non-wrapping read for the whole block.
            const bool wrapInBlock = loop && sourceAvail > 0
                && into0 >= 0
                && (into0 / sourceAvail) != ((into0 + numSamples - 1) / sourceAvail);

            if (!wrapInBlock && filePosAtStart >= 0) {
                buf->read(ptrs, numSamples, filePosAtStart);
            } else if (!wrapInBlock && filePosAtStart < 0 && into0 + numSamples > 0) {
                // Leading silence before region start.
                const int lead = static_cast<int>(std::min<int64_t>(numSamples, -into0));
                const int tail = numSamples - lead;
                if (tail > 0) {
                    float* tailPtrs[2] = {
                        ptrs[0] != nullptr ? ptrs[0] + lead : nullptr,
                        trackChannels > 1 && ptrs[1] != nullptr ? ptrs[1] + lead
                                                               : (ptrs[0] != nullptr ? ptrs[0] + lead : nullptr)};
                    const int64_t fp = mapFilePos(0);
                    if (fp >= 0)
                        buf->read(tailPtrs, tail, fp);
                }
            } else if (wrapInBlock || loop) {
                // Contiguous segments of file frames (one seek per wrap).
                int i = 0;
                while (i < numSamples) {
                    const int64_t fp0 = mapFilePos(into0 + i);
                    if (fp0 < 0) {
                        ++i;
                        continue;
                    }
                    int j = i + 1;
                    while (j < numSamples) {
                        const int64_t fpj = mapFilePos(into0 + j);
                        if (fpj != fp0 + (j - i))
                            break;
                        ++j;
                    }
                    float* segPtrs[2] = {
                        ptrs[0] != nullptr ? ptrs[0] + i : nullptr,
                        trackChannels > 1 && ptrs[1] != nullptr ? ptrs[1] + i
                                                               : (ptrs[0] != nullptr ? ptrs[0] + i : nullptr)};
                    buf->read(segPtrs, j - i, fp0);
                    i = j;
                }
            }

            // Window + fades + region gain (sample-accurate at edges).
            // Non-loop past sourceAvail → silence even if still inside clip.
            if (reg != nullptr) {
                for (int i = 0; i < numSamples; ++i) {
                    const int64_t absS = playheadSample + i;
                    float g = 0.0f;
                    if (absS >= regStart && absS < regEnd && regLen > 0) {
                        const int64_t into = absS - regStart;
                        const bool hasSource = loop
                            ? (sourceAvail > 0)
                            : (into >= 0 && into < sourceAvail);
                        if (hasSource) {
                            g = regGain;
                            if (fadeInN > 0 && into < fadeInN) {
                                const float t = static_cast<float>(into + 1) / static_cast<float>(fadeInN);
                                g *= shapedFadeGain(t, fadeInCurve);
                            }
                            if (fadeOutN > 0 && into >= regLen - fadeOutN) {
                                const float remain = static_cast<float>(regLen - into);
                                const float t = remain / static_cast<float>(fadeOutN);
                                g *= shapedFadeGain(t, fadeOutCurve);
                            }
                        }
                    }
                    for (int ch = 0; ch < trackChannels; ++ch) {
                        float* p = ptrs[ch];
                        if (p != nullptr)
                            p[i] *= g;
                    }
                }
            }
        }
        // else: leave scratch cleared (silence) -- do not pull from the stream
        // past the clip end (that was the meter-flash path).

        // Peak meter after fader/pan (and mono sum when forceMono / mono file).
        if (t < trackMeters.size() && trackMeters[t] != nullptr) {
            float gL = 1.0f;
            float gR = 1.0f;
            bool forceMono = trackChannels < 2;
            bool silenced = true;
            if (snap != nullptr) {
                for (const TrackRoute& route : snap->routes) {
                    if (route.trackIndex != t)
                        continue;
                    if (!route.isAuxSend || silenced) {
                        silenced = route.mute;
                        forceMono = forceMono || route.forceMono;
                        const float g = route.gainLinear * route.sendGainLinear;
                        gL = g * (1.0f - std::max(0.0f, route.pan));
                        gR = g * (1.0f + std::min(0.0f, route.pan));
                        if (!route.isAuxSend)
                            break;
                    }
                }
            }

            // Same floor/ceiling as Metering.cpp::linearToDb -- a single
            // non-finite or absurd sample must not peg the strip at +400 dB.
            auto toDb = [](float p) -> float {
                if (!(p > 1.0e-9f) || !std::isfinite(p))
                    return -144.0f;
                constexpr float kMaxLinear = 32.0f;
                const float c = std::min(p, kMaxLinear);
                return 20.0f * std::log10(c);
            };
            auto finiteSample = [](float s) -> float {
                return std::isfinite(s) ? s : 0.0f;
            };

            if (silenced) {
                trackMeters[t]->write(MeterFrame{});
            } else {
                const float* sL = scratch.getReadPointer(0);
                const float* sR =
                    trackChannels > 1 ? scratch.getReadPointer(1) : sL;
                float peakL = 0.0f;
                float peakR = 0.0f;
                for (int i = 0; i < numSamples; ++i) {
                    const float l = finiteSample(sL != nullptr ? sL[i] : 0.0f);
                    const float r = finiteSample(sR != nullptr ? sR[i] : l);
                    if (forceMono) {
                        const float m = 0.5f * (l + r);
                        peakL = std::max(peakL, std::abs(m * gL));
                        peakR = std::max(peakR, std::abs(m * gR));
                    } else {
                        peakL = std::max(peakL, std::abs(l * gL));
                        peakR = std::max(peakR, std::abs(r * gR));
                    }
                }
                // Mono strip: show the same post-fader mono peak on both bars
                // when pan is centre; with pan, L/R already reflect balance.
                if (forceMono && std::abs(gL - gR) < 1.0e-6f) {
                    const float p = std::max(peakL, peakR);
                    peakL = peakR = p;
                }
                MeterFrame frame;
                frame.peakDb = toDb(std::max(peakL, peakR));
                frame.peakDbL = toDb(peakL);
                frame.peakDbR = toDb(peakR);
                frame.truePeakDb = frame.peakDb;
                trackMeters[t]->write(frame);
            }
        }
    }

    busScratch.clear();
    const int scratchChannels = busScratch.getNumChannels();

    // Pass 2: tracks -> bus scratch buffers.
    for (const TrackRoute& route : snap->routes) {
        if (route.mute || route.trackIndex >= trackIdByIndex.size() || route.busIndex >= busses.size())
            continue;

        StreamingTrackBuffer* buf = activeSong.track(trackIdByIndex[route.trackIndex]);
        if (buf == nullptr)
            continue;

        if (route.trackIndex >= trackScratch.size())
            continue;
        const juce::AudioBuffer<float>& trackBuf = trackScratch[route.trackIndex];
        if (trackBuf.getNumChannels() < 1 || trackBuf.getNumSamples() < numSamples)
            continue;
        const int trackChannels = std::min(2, buf->numChannels());
        const int busChannels = std::min(2, busses[route.busIndex].channelCount);
        const int scratchOffset = static_cast<int>(route.busIndex) * 2;
        if (scratchOffset + busChannels > scratchChannels)
            continue;

        const float* srcL = trackBuf.getReadPointer(0);
        if (srcL == nullptr)
            continue;
        const float* srcR = trackChannels > 1 ? trackBuf.getReadPointer(1) : srcL;
        if (srcR == nullptr)
            srcR = srcL;

        const float g = route.gainLinear * route.sendGainLinear;
        // Balance-style pan targets (L/R attenuation).
        const float targetGL = g * (1.0f - std::max(0.0f, route.pan));
        const float targetGR = g * (1.0f + std::min(0.0f, route.pan));
        // Force-mono track flag or mono file → sum L+R, then pan into bus.
        const float targetMono =
            (route.forceMono || trackChannels < 2) ? 1.0f : 0.0f;

        const size_t smoothIdx =
            static_cast<size_t>(route.trackIndex) * kSmoothBusSlots
            + static_cast<size_t>(route.busIndex % kSmoothBusSlots);
        if (smoothIdx >= trackGainSmooth.size())
            trackGainSmooth.resize(smoothIdx + 1);
        TrackGainSmooth& sm = trackGainSmooth[smoothIdx];
        if (!sm.inited) {
            sm.gL = targetGL;
            sm.gR = targetGR;
            sm.monoMix = targetMono;
            sm.inited = true;
        }

        // ~10 ms exponential dezipper (avoids pan/gain/mono hard jumps → clicks).
        const float sr = static_cast<float>(std::max(1.0, currentSampleRate));
        const float a = 1.0f - std::exp(-1.0f / (0.010f * sr));

        for (int i = 0; i < numSamples; ++i) {
            sm.gL += a * (targetGL - sm.gL);
            sm.gR += a * (targetGR - sm.gR);
            sm.monoMix += a * (targetMono - sm.monoMix);

            const float lIn = srcL[i];
            const float rIn = srcR[i];
            const float mid = 0.5f * (lIn + rIn);
            // Crossfade stereo ↔ mono sum so the mono toggle doesn't click.
            const float preL = lIn + sm.monoMix * (mid - lIn);
            const float preR = rIn + sm.monoMix * (mid - rIn);

            if (busChannels >= 2) {
                busScratch.addSample(scratchOffset + 0, i, preL * sm.gL);
                busScratch.addSample(scratchOffset + 1, i, preR * sm.gR);
            } else {
                busScratch.addSample(
                    scratchOffset + 0, i, 0.5f * (preL * sm.gL + preR * sm.gR));
            }
        }
    }

    // During micro-fades / holds the physical outs are ramped, but meters used
    // to read the UN-faded busScratch and flash a full-scale peak (visible as
    // a pegged master meter with no audible click). Skip metering while
    // ramping so the UI tracks what you actually hear.
    const bool meteringMuted = (underrunFadeOutRemaining > 0 || recoveryFadeInRemaining > 0
                                || outputHeldSilent);

    // Built-in click generator: mixed directly into its target bus's scratch
    // region (mono summed to both channels), same as any other source, so it
    // participates in metering and physical output routing normally.
    // Also mixed into every send bus from builtInClickSends (monitor mixes).
    const bool clickActive = clickTargetBusIndex >= 0 && static_cast<size_t>(clickTargetBusIndex) < busses.size();
    const bool clickHasSends = !clickSendBusIndices.empty();
    if (clickActive || clickHasSends) {
        if (clickScratch.size() < static_cast<size_t>(numSamples))
            clickScratch.resize(static_cast<size_t>(numSamples), 0.0f);
        clickGenerator.render(clickScratch.data(), numSamples, playheadSample);

        if (isClickEnabled) {
            // Balance pan on the mono click (same law as track pan).
            const float targetGL =
                clickGainLinear * (1.0f - std::max(0.0f, clickPan));
            const float targetGR =
                clickGainLinear * (1.0f + std::min(0.0f, clickPan));
            if (!clickSmoothInited) {
                clickSmoothGL = targetGL;
                clickSmoothGR = targetGR;
                clickSmoothInited = true;
            }
            const float sr = static_cast<float>(std::max(1.0, currentSampleRate));
            const float a = 1.0f - std::exp(-1.0f / (0.010f * sr));

            // Main target bus
            if (clickActive) {
                const int scratchOffset = clickTargetBusIndex * 2;
                if (scratchOffset + 2 <= scratchChannels) {
                    for (int i = 0; i < numSamples; ++i) {
                        clickSmoothGL += a * (targetGL - clickSmoothGL);
                        clickSmoothGR += a * (targetGR - clickSmoothGR);
                        const float s = clickScratch[static_cast<size_t>(i)];
                        busScratch.addSample(
                            scratchOffset + 0, i, s * clickSmoothGL);
                        busScratch.addSample(
                            scratchOffset + 1, i, s * clickSmoothGR);
                    }
                }
            }

            // Send buses (aux monitor mixes) — send gain × pan balance,
            // dezippered per-send the same ~10ms exponential way as every
            // other gain path (see the track-route smoother above), so
            // moving a click send knob doesn't zipper/click.
            if (clickSendSmooth.size() < clickSendBusIndices.size())
                clickSendSmooth.resize(clickSendBusIndices.size());
            for (size_t si = 0; si < clickSendBusIndices.size(); ++si) {
                const int sendBusIdx = clickSendBusIndices[si];
                if (static_cast<size_t>(sendBusIdx) >= busses.size())
                    continue;
                const int scratchOffset = sendBusIdx * 2;
                if (scratchOffset + 2 > scratchChannels)
                    continue;
                const float sendGain = clickSendGainLinears[si];
                const float sendTargetGL =
                    sendGain * (1.0f - std::max(0.0f, clickPan));
                const float sendTargetGR =
                    sendGain * (1.0f + std::min(0.0f, clickPan));

                ClickSendSmooth& sm = clickSendSmooth[si];
                if (!sm.inited) {
                    sm.gL = sendTargetGL;
                    sm.gR = sendTargetGR;
                    sm.inited = true;
                }

                for (int i = 0; i < numSamples; ++i) {
                    sm.gL += a * (sendTargetGL - sm.gL);
                    sm.gR += a * (sendTargetGR - sm.gR);
                    const float s = clickScratch[static_cast<size_t>(i)];
                    busScratch.addSample(scratchOffset + 0, i, s * sm.gL);
                    busScratch.addSample(scratchOffset + 1, i, s * sm.gR);
                }
            }

            // Click strip meter: metronome only, post gain+pan (L/R balance).
            // Also accumulate interval-max for the UI poller: a one-block
            // impulse is often overwritten by silence before the next 30 Hz
            // sample, so consumeClickMeterInterval() would otherwise miss it.
            // That max is the true peak of what was rendered in the interval
            // (not a post-silence display hold).
            if (!meteringMuted) {
                float peakL = 0.0f;
                float peakR = 0.0f;
                for (int i = 0; i < numSamples; ++i) {
                    const float s =
                        std::abs(clickScratch[static_cast<size_t>(i)]);
                    peakL = std::max(peakL, s * clickSmoothGL);
                    peakR = std::max(peakR, s * clickSmoothGR);
                }
                atomicMaxFloat(clickPeakIntervalMaxL, peakL);
                atomicMaxFloat(clickPeakIntervalMaxR, peakR);
                MeterFrame frame;
                frame.peakDb = linearPeakToDb(std::max(peakL, peakR));
                frame.peakDbL = linearPeakToDb(peakL);
                frame.peakDbR = linearPeakToDb(peakR);
                frame.truePeakDb = frame.peakDb;
                clickMeterFrame.write(frame);
            } else {
                clickPeakIntervalMaxL.store(0.0f, std::memory_order_relaxed);
                clickPeakIntervalMaxR.store(0.0f, std::memory_order_relaxed);
                clickMeterFrame.write(MeterFrame{});
            }
        } else {
            clickPeakIntervalMaxL.store(0.0f, std::memory_order_relaxed);
            clickPeakIntervalMaxR.store(0.0f, std::memory_order_relaxed);
            clickMeterFrame.write(MeterFrame{});
        }
    } else {
        clickPeakIntervalMaxL.store(0.0f, std::memory_order_relaxed);
        clickPeakIntervalMaxR.store(0.0f, std::memory_order_relaxed);
        clickMeterFrame.write(MeterFrame{});
    }

    // Pass 3: bus scratch buffers -> metering + physical outputs.
    for (const BusOutput& out : snap->outputs) {
        if (out.busIndex >= busses.size())
            continue;
        const int scratchOffset = static_cast<int>(out.busIndex) * 2;
        const int channels = std::min(2, out.channelCount);

        if (!meteringMuted && out.busIndex < busLoudnessMeters.size()) {
            const float* meterChannels[2] = {
                busScratch.getReadPointer(scratchOffset),
                channels > 1 ? busScratch.getReadPointer(scratchOffset + 1) : busScratch.getReadPointer(scratchOffset)};
            busLoudnessMeters[out.busIndex].processBlock(meterChannels, numSamples);
            if (out.busIndex < busMeters.size() && busMeters[out.busIndex] != nullptr)
                busMeters[out.busIndex]->write(busLoudnessMeters[out.busIndex].currentFrame());
        } else if (meteringMuted && out.busIndex < busMeters.size() && busMeters[out.busIndex] != nullptr) {
            busMeters[out.busIndex]->write(MeterFrame{});
        }

        if (out.mute)
            continue;

        for (int ch = 0; ch < channels; ++ch) {
            const int physicalCh = out.startChannel + ch;
            if (physicalCh < 0 || physicalCh >= numOutputChannels || outputChannelData[physicalCh] == nullptr)
                continue;
            const float* src = busScratch.getReadPointer(scratchOffset + ch);
            float* dst = outputChannelData[physicalCh];
            for (int i = 0; i < numSamples; ++i)
                dst[i] += src[i] * out.gainLinear;
        }
    }

    // Spec micro-fade on the summed physical outputs:
    //   - linear fade-out on underrun / song-end (length = whatever armed it)
    //   - linear fade-in on recovery / new song start (PREFERRED over hold,
    //     so selectSongInternal can leave outputHeldSilent set while arming
    //     the ramp and the audio thread never sees a full-gain step)
    //   - HOLD at silence after song-end fade reaches 0 until fade-in arms
    //     (without this, g snaps back to 1.0 mid-block -- the crack)
    if (underrunFadeOutRemaining > 0 || recoveryFadeInRemaining > 0 || outputHeldSilent) {
        const float fadeOutLen = static_cast<float>(
            underrunFadeOutLength > 0 ? underrunFadeOutLength : kSongEndFadeSamples);
        const float fadeInLen = static_cast<float>(
            recoveryFadeInLength > 0 ? recoveryFadeInLength : kSongEndFadeSamples);
        for (int i = 0; i < numSamples; ++i) {
            float g = 1.0f;
            if (underrunFadeOutRemaining > 0) {
                g = static_cast<float>(underrunFadeOutRemaining) / fadeOutLen;
                --underrunFadeOutRemaining;
                if (underrunFadeOutRemaining == 0
                    && pendingSongEndAction != SongEndAction::None) {
                    // Song-end ramp finished: stay silent across the rest of
                    // this block, the remaining real audio until true EOF,
                    // and the message-thread gap before the next song is
                    // staged. Cleared / overridden by fade-in in selectSongInternal.
                    outputHeldSilent = true;
                }
            } else if (recoveryFadeInRemaining > 0) {
                const int done = recoveryFadeInLength - recoveryFadeInRemaining;
                g = static_cast<float>(done + 1) / fadeInLen;
                --recoveryFadeInRemaining;
                if (recoveryFadeInRemaining == 0)
                    outputHeldSilent = false;
            } else if (outputHeldSilent) {
                g = 0.0f;
            }
            for (int ch = 0; ch < numOutputChannels; ++ch)
                if (outputChannelData[ch] != nullptr)
                    outputChannelData[ch][i] *= g;
        }
    }

    // Commit phase: only once the song-end fade-out ramp has fully applied AND
    // the playhead has actually reached the song's real end do we perform the
    // transition. Requiring both (not just the ramp counter reaching 0) means
    // a song shorter than the fade window can't trigger the transition before
    // its own real audio has finished playing.
    if (pendingSongEndAction != SongEndAction::None && underrunFadeOutRemaining == 0
        && playheadSample >= currentSongLengthFrames) {
        if (pendingSongEndAction == SongEndAction::GaplessAdvance) {
            const size_t nextIdx = pendingSongEndTargetSong;
            pendingSongEndAction = SongEndAction::None;
            // Prefer in-callback promote of the warm precache: no 30 Hz timer
            // wait, no multi-file re-open -- just shared_ptr swap + playhead 0.
            // Falls back to message-thread switchToSongGapless if precache miss.
            streamHandoff.store(true, std::memory_order_release);
            if (!tryGaplessPromoteOnAudioThread(nextIdx)) {
                clock.stop();
                pendingGaplessSong.store(static_cast<int>(nextIdx), std::memory_order_release);
                autoAdvancePending.store(true, std::memory_order_release);
                // Don't wait for the 30 Hz UI timer -- finish handoff on the
                // next message-thread turn so the silence gap stays ~1–2 ms.
                juce::MessageManager::callAsync([this, nextIdx]() {
                    if (pendingGaplessSong.load(std::memory_order_acquire) < 0)
                        return; // already consumed / audio-thread finished
                    size_t idx = nextIdx;
                    if (!consumeGaplessAdvance(idx))
                        idx = nextIdx;
                    std::string err;
                    (void)switchToSongGapless(idx, err);
                });
            }
        } else {
            midiDispatcher.stopClock();
            playing.store(false, std::memory_order_release);
            clock.stop();
            pendingSongEndAction = SongEndAction::None;
        }
    }

    // Remember each physical channel's final sample so a Stop/Pause that
    // lands on the very next callback has something real to declick from
    // (see kStopDeclickSamples' doc comment) instead of ramping from silence
    // (which would just BE silence -- no click to avoid, but also no smooth
    // fade of whatever was actually still sounding).
    if (static_cast<int>(lastOutputSample.size()) < numOutputChannels)
        lastOutputSample.resize(static_cast<size_t>(numOutputChannels), 0.0f);
    for (int ch = 0; ch < numOutputChannels; ++ch)
        if (outputChannelData[ch] != nullptr && numSamples > 0)
            lastOutputSample[static_cast<size_t>(ch)] = outputChannelData[ch][numSamples - 1];
}

void AudioEngine::importWavForTrackAsync(size_t songIndex, size_t trackIndex, const std::string& filesystemPath,
                                         std::function<void(bool, std::string)> onComplete) {
    auto fail = [&onComplete](std::string msg) {
        if (onComplete)
            onComplete(false, std::move(msg));
    };

    if (importThread.joinable())
        importThread.join();
    if (pendingFinishImport) {
        auto fn = std::move(pendingFinishImport);
        pendingFinishImport = nullptr;
        fn();
    }
    busyImporting.store(false, std::memory_order_release);
    const TrackDef* track = trackDefInSong(songIndex, trackIndex);
    if (track == nullptr) {
        fail("Invalid track index");
        return;
    }
    if (!loader.isOpen() || loader.archivePath().empty()) {
        std::string err;
        const auto docDir = juce::File::getSpecialLocation(juce::File::userHomeDirectory).getChildFile("Documents").getChildFile("ResoSet_Projects");
        docDir.createDirectory();
        const std::string defaultPath = docDir.getChildFile("UntitledProject.rsnraset").getFullPathName().toStdString();
        if (!saveProject(defaultPath, err)) {
            fail("Failed to auto-create project archive: " + err);
            return;
        }
    }

    // Sanitize archive entry name and figure out the new track name --
    // cheap, message-thread-safe (no I/O) -- before touching anything slow.
    std::string base = filesystemPath;
    const auto slash = base.find_last_of("/\\");
    if (slash != std::string::npos)
        base = base.substr(slash + 1);
    if (base.empty())
        base = track->id + ".wav";
    const std::string entry = "Audio/" + base;
    std::string newTrackName = track->name;
    if (newTrackName.empty() || newTrackName == "New Track") {
        const auto dot = base.find_last_of('.');
        newTrackName = (dot == std::string::npos) ? base : base.substr(0, dot);
    }

    // Update in-memory live track immediately so main thread UI/state has it
    if (TrackDef* liveTrack = trackDefAt(trackIndex)) {
        if (liveTrack->name.empty() || liveTrack->name == "New Track")
            liveTrack->name = newTrackName;
    }
    if (songIndex < loader.project().songs.size()) {
        SongDef& s = loader.project().songs[songIndex];
        const TrackDef* trk = trackDefAt(trackIndex);
        if (trk) {
            Region* regPtr = nullptr;
            for (auto& r : s.regions) {
                if (r.trackId == trk->id) { regPtr = &r; break; }
            }
            if (!regPtr) {
                Region reg;
                reg.id = "reg_" + s.id + "_" + trk->id;
                reg.trackId = trk->id;
                s.regions.push_back(reg);
                regPtr = &s.regions.back();
            }
            regPtr->file = entry;
        }
    }

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    stop();
    joinPendingPeakBuilds(); // also reads `loader`; must finish before we hand it to the import thread
    streaming.stop(); // halts the I/O thread -- loader is exclusively ours until streaming.start() below

    // Private snapshot the background thread writes from
    Project projectSnapshot = loader.project();
    if (songIndex < projectSnapshot.songs.size()) {
        SongDef& s = projectSnapshot.songs[songIndex];
        if (trackIndex < projectSnapshot.tracks.size()) {
            const std::string& trkId = projectSnapshot.tracks[trackIndex].id;
            Region* regPtr = nullptr;
            for (auto& r : s.regions) {
                if (r.trackId == trkId) { regPtr = &r; break; }
            }
            if (!regPtr) {
                Region reg;
                reg.id = "reg_" + s.id + "_" + trkId;
                reg.trackId = trkId;
                s.regions.push_back(reg);
                regPtr = &s.regions.back();
            }
            regPtr->file = entry;
        }
    }

    const std::string archivePath = loader.archivePath();
    const bool isContainer = loader.isDirectoryContainer();
    const std::string tempOut = isContainer ? archivePath : (archivePath + ".new");

    busyImporting.store(true, std::memory_order_release);


    importThread = std::thread([this, songIndex, trackIndex, filesystemPath, entry, archivePath, tempOut, projectSnapshot, songToRestore, wasPlaying,
                                 onComplete]() mutable {
        std::string error;
        std::vector<uint8_t> data;
        bool readOk = true;

        FILE* f = std::fopen(filesystemPath.c_str(), "rb");
        if (f == nullptr) {
            error = "Failed to open file: " + filesystemPath;
            readOk = false;
        } else {
            std::fseek(f, 0, SEEK_END);
            const long sz = std::ftell(f);
            std::fseek(f, 0, SEEK_SET);
            if (sz <= 0 || sz > 512 * 1024 * 1024) {
                error = "Invalid WAV file size";
                readOk = false;
            } else {
                data.resize(static_cast<size_t>(sz));
                if (std::fread(data.data(), 1, data.size(), f) != data.size()) {
                    error = "Failed to read WAV file";
                    readOk = false;
                }
            }
            std::fclose(f);
        }

        bool writeOk = false;
        if (readOk) {
            PeakOverview overview;
            std::string peakError;
            const bool peaksOk = overview.buildFromBuffer(data.data(), data.size(), peakError);

            std::vector<ProjectLoader::ExtraFile> extras;
            ProjectLoader::ExtraFile extra;
            extra.archivePath = entry;
            extra.data = std::move(data);
            extras.push_back(std::move(extra));
            if (peaksOk) {
                extras.push_back(PeakCache::makeCacheExtra(overview, entry));
                if (songIndex < projectSnapshot.songs.size()) {
                    SongDef& s = projectSnapshot.songs[songIndex];
                    if (trackIndex < projectSnapshot.tracks.size()) {
                        const std::string& trkId = projectSnapshot.tracks[trackIndex].id;
                        for (auto& r : s.regions) {
                            if (r.trackId == trkId) {
                                r.durationSeconds = overview.durationSeconds;
                                break;
                            }
                        }
                    }
                }
            }



            writeOk = loader.saveAsWithExtras(tempOut, extras, error, &projectSnapshot);

            if (writeOk && peaksOk) {
                std::lock_guard<std::mutex> lock(peakCacheMutex);
                peakOverviewSessionCache[entry] = std::move(overview);
            }
        }

        auto finishFn = [this, readOk, writeOk, error, tempOut, archivePath, songToRestore, wasPlaying, onComplete]() {
            finishAsyncImport(readOk && writeOk, error, tempOut, archivePath, songToRestore, wasPlaying, onComplete);
        };

        pendingFinishImport = finishFn;

        juce::MessageManager::callAsync([this]() {
            if (pendingFinishImport) {
                auto fn = std::move(pendingFinishImport);
                pendingFinishImport = nullptr;
                fn();
            }
        });
    });
}

void AudioEngine::importSongStemsBatchAsync(size_t songIndex, const std::vector<BatchItem>& items,
                                            std::function<void(bool, std::string)> onComplete) {
    auto fail = [&onComplete](std::string msg) {
        if (onComplete)
            onComplete(false, std::move(msg));
    };

    if (items.empty()) {
        fail("No items to import");
        return;
    }

    if (importThread.joinable())
        importThread.join();
    if (pendingFinishImport) {
        auto fn = std::move(pendingFinishImport);
        pendingFinishImport = nullptr;
        fn();
    }
    busyImporting.store(false, std::memory_order_release);

    if (!loader.isOpen() || loader.archivePath().empty()) {
        newProject("New Project");
    }

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    stop();
    joinPendingPeakBuilds();
    streaming.stop();

    Project projectSnapshot = loader.project();
    std::string archivePath = loader.archivePath();
    busyImporting.store(true, std::memory_order_release);

    importThread = std::thread([this, songIndex, items, archivePath, projectSnapshot, songToRestore, wasPlaying, onComplete]() mutable {
        namespace fs = std::filesystem;
        std::error_code ec;
        fs::path containerDir(archivePath);
        fs::create_directories(containerDir / "Audio", ec);
        fs::create_directories(containerDir / "Peaks", ec);

        std::string error;
        bool allOk = true;

        for (const auto& item : items) {
            std::string base = item.filesystemPath;
            const auto slash = base.find_last_of("/\\");
            if (slash != std::string::npos)
                base = base.substr(slash + 1);
            const std::string entry = "Audio/" + base;

            fs::path destAudio = containerDir / entry;
            fs::copy_file(item.filesystemPath, destAudio, fs::copy_options::overwrite_existing, ec);
            if (ec) {
                error = "Failed to copy audio file: " + item.filesystemPath + " (" + ec.message() + ")";
                allOk = false;
                break;
            }

            if (songIndex < projectSnapshot.songs.size() && item.trackIndex < projectSnapshot.tracks.size()) {
                SongDef& s = projectSnapshot.songs[songIndex];
                const std::string& trkId = projectSnapshot.tracks[item.trackIndex].id;
                Region* regPtr = nullptr;
                for (auto& r : s.regions) {
                    if (r.trackId == trkId) { regPtr = &r; break; }
                }
                if (!regPtr) {
                    Region reg;
                    reg.id = "reg_" + s.id + "_" + trkId;
                    reg.trackId = trkId;
                    s.regions.push_back(reg);
                    regPtr = &s.regions.back();
                }
                regPtr->file = entry;
            }

            std::vector<uint8_t> wavData;
            std::ifstream ifs(destAudio, std::ios::binary | std::ios::ate);
            if (ifs.is_open()) {
                std::streamsize sz = ifs.tellg();
                ifs.seekg(0, std::ios::beg);
                wavData.resize(static_cast<size_t>(sz));
                ifs.read(reinterpret_cast<char*>(wavData.data()), sz);
                ifs.close();
            }

            if (!wavData.empty()) {
                PeakOverview overview;
                std::string peakErr;
                if (overview.buildFromBuffer(wavData.data(), wavData.size(), peakErr)) {
                    ProjectLoader::ExtraFile cacheExtra = PeakCache::makeCacheExtra(overview, entry);
                    fs::path peakDest = containerDir / cacheExtra.archivePath;
                    fs::create_directories(peakDest.parent_path(), ec);
                    std::ofstream ofs(peakDest, std::ios::binary);
                    if (ofs.is_open()) {
                        ofs.write(reinterpret_cast<const char*>(cacheExtra.data.data()), cacheExtra.data.size());
                    }
                    std::lock_guard<std::mutex> lock(peakCacheMutex);
                    peakOverviewSessionCache[entry] = std::move(overview);
                }
            }
        }

        if (allOk) {
            std::string saveErr;
            loader.saveAsWithExtras(archivePath, {}, saveErr, &projectSnapshot);
        }

        auto finishFn = [this, allOk, error, archivePath, songToRestore, wasPlaying, onComplete]() {
            finishAsyncImport(allOk, error, archivePath, archivePath, songToRestore, wasPlaying, onComplete);
        };
        pendingFinishImport = finishFn;

        juce::MessageManager::callAsync([this]() {
            if (pendingFinishImport) {
                auto fn = std::move(pendingFinishImport);
                pendingFinishImport = nullptr;
                fn();
            }
        });
    });
}


void AudioEngine::finishAsyncImport(bool writeSucceeded, std::string writeError, const std::string& tempOut,
                                    const std::string& archivePath, size_t songToRestore, bool wasPlaying,
                                    const std::function<void(bool, std::string)>& onComplete) {
    auto done = [&](bool ok, std::string msg) {
        busyImporting.store(false, std::memory_order_release);
        if (onComplete)
            onComplete(ok, std::move(msg));
    };

    if (!writeSucceeded) {
        std::remove(tempOut.c_str());
        // loader/streaming were never touched by the failed background
        // write -- just restart streaming (halted before the background
        // thread started) and report the error.
        streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);
        done(false, writeError);
        return;
    }

    // Peaks for every file this import touched were already computed and
    // merged into peakOverviewSessionCache on the background thread (see
    // importWavForTrackAsync/importSongFromFolderAsync), keyed by archive
    // path -- so a stale entry from re-importing over the same filename is
    // naturally overwritten with the fresh one, and no other file's cached
    // peaks need to be thrown away just because an unrelated import happened.

    if (std::rename(tempOut.c_str(), archivePath.c_str()) != 0) {
        std::string reopenError;
        (void)loader.reopenArchiveKeepProject(archivePath, reopenError);
        (void)loader.reparseProject(reopenError);
        projectLoaded = loader.isOpen();
        if (projectLoaded)
            streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);
        done(false, "Failed to replace archive after import");
        return;
    }

    std::string openError;
    if (!loader.reopenArchiveKeepProject(archivePath, openError)
        || !loader.reparseProject(openError)) {
        projectLoaded = false;
        done(false, "Import written, but failed to reopen archive: " + openError);
        return;
    }
    projectLoaded = true;
    buildBusListFromProject();
    streaming.start(&loader, streamingIoThreadStart, streamingIoThreadStop);

    currentSong = static_cast<size_t>(-1);
    trackIdByIndex.clear();
    trackScratch.clear();
    trackGainSmooth.clear();
    clickSendSmooth.clear();
    trackMeters.clear();
    trackPeaks.clear();

    if (songToRestore != static_cast<size_t>(-1) && songToRestore < loader.project().songs.size()) {
        std::string selectError;
        if (!selectSong(songToRestore, selectError)) {
            done(false, "Imported, but restage failed: " + selectError);
            return;
        }
        if (wasPlaying)
            play();
    }
    done(true, "");
}

bool AudioEngine::scanFolderForImport(const std::string& folderPath, std::vector<std::string>& outWavPaths,
                                      double& outDetectedBpm, std::string& error) const {
    namespace fs = std::filesystem;
    std::error_code ec;
    const fs::path dir(folderPath);
    if (!fs::is_directory(dir, ec)) {
        error = "Not a folder: " + folderPath;
        return false;
    }

    outWavPaths.clear();
    for (const auto& entry : fs::directory_iterator(dir, ec)) {
        if (!entry.is_regular_file())
            continue;
        std::string ext = entry.path().extension().string();
        for (char& c : ext)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (ext == ".wav")
            outWavPaths.push_back(entry.path().string());
    }
    if (ec) {
        error = "Failed to read folder: " + folderPath;
        return false;
    }
    if (outWavPaths.empty()) {
        error = "No .wav files found in " + folderPath;
        return false;
    }
    std::sort(outWavPaths.begin(), outWavPaths.end());

    outDetectedBpm = 0.0;
    for (const auto& wavPath : outWavPaths) {
        if (extractTempoFromWavFile(wavPath, outDetectedBpm))
            break;
    }
    if (outDetectedBpm <= 0.0)
        parseBpmFromName(dir.filename().string(), outDetectedBpm);

    return true;
}

static std::string autoDetectStemCategory(const std::string& filename) {
    std::string upper = filename;
    for (char& c : upper) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));

    if (upper.find("CLICK") != std::string::npos || upper.find("METRO") != std::string::npos || upper.find("COUNT") != std::string::npos) return "Click";
    if (upper.find("GUIDE") != std::string::npos || upper.find("CUE") != std::string::npos || upper.find("SLATE") != std::string::npos) return "Guide";
    if (upper.find("BASS") != std::string::npos || upper.find("SUB") != std::string::npos) return "Bass";
    if (upper.find("DRUM") != std::string::npos || upper.find("DRM") != std::string::npos || upper.find("KICK") != std::string::npos || upper.find("SNARE") != std::string::npos || upper.find("BEAT") != std::string::npos || upper.find("HAT") != std::string::npos || upper.find("CYMBAL") != std::string::npos || upper.find("TOM") != std::string::npos) return "Drums";
    if (upper.find("PERC") != std::string::npos || upper.find("SHAKER") != std::string::npos || upper.find("CONGA") != std::string::npos || upper.find("TAMB") != std::string::npos || upper.find("CLAP") != std::string::npos) return "Percussion";
    if (upper.find("LOOP") != std::string::npos || upper.find("TOPS") != std::string::npos || upper.find("GROOVE") != std::string::npos) return "Loops";
    if (upper.find("BACK") != std::string::npos || upper.find("BK") != std::string::npos || upper.find("BGV") != std::string::npos || upper.find("BVOX") != std::string::npos || upper.find("BACKING") != std::string::npos || upper.find("CHOIR") != std::string::npos || upper.find("HARMONY") != std::string::npos) return "Backing Vocals";
    if (upper.find("VOX") != std::string::npos || upper.find("VOCAL") != std::string::npos || upper.find("LEAD") != std::string::npos) return "Vocals";
    if (upper.find("KEY") != std::string::npos || upper.find("PIANO") != std::string::npos || upper.find("ORGAN") != std::string::npos || upper.find("RHODES") != std::string::npos) return "Keys";
    if (upper.find("SYNTH") != std::string::npos || upper.find("PAD") != std::string::npos || upper.find("ARP") != std::string::npos) return "Synths";
    if (upper.find("GUITAR") != std::string::npos || upper.find("GTR") != std::string::npos || upper.find("ACOUSTIC") != std::string::npos || upper.find("ELECTRIC") != std::string::npos) return "Guitars";
    if (upper.find("SFX") != std::string::npos || upper.find("FX") != std::string::npos || upper.find("RISER") != std::string::npos || upper.find("SWEEP") != std::string::npos || upper.find("HIT") != std::string::npos || upper.find("DROP") != std::string::npos) return "SFX";

    std::string stem = filename;
    const auto slash = stem.find_last_of("/\\");
    if (slash != std::string::npos) stem = stem.substr(slash + 1);
    const auto dot = stem.find_last_of('.');
    if (dot != std::string::npos) stem = stem.substr(0, dot);
    return stem;
}

void AudioEngine::importSongFromFolderAsync(const std::string& folderPath, const std::string& songName, double bpm,
                                            int tsNumerator, int tsDenominator,
                                            std::function<void(bool, std::string)> onComplete) {
    auto fail = [&onComplete](std::string msg) {
        if (onComplete)
            onComplete(false, std::move(msg));
    };

    if (busyImporting.load(std::memory_order_acquire)) {
        fail("Another import is already in progress");
        return;
    }
    if (!projectLoaded) {
        fail("No project loaded");
        return;
    }
    if (!loader.isOpen() || loader.archivePath().empty()) {
        fail("Save the project first (Save As...) so imported audio has an archive to live in");
        return;
    }
    if (loader.project().busses.empty()) {
        fail("Project has no busses to route imported tracks to");
        return;
    }

    // Fast (header-only reads) -- fine to do synchronously before spawning
    // the background thread for the actual slow work below.
    std::vector<std::string> wavPaths;
    double scannedBpm = 0.0;
    std::string scanError;
    if (!scanFolderForImport(folderPath, wavPaths, scannedBpm, scanError)) {
        fail(scanError);
        return;
    }

    std::vector<std::string> existingIds;
    for (const auto& s : loader.project().songs)
        existingIds.push_back(s.id);
    std::string songId = "song_x";
    for (int n = 1; n < 100000; ++n) {
        std::string candidate = "song_" + std::to_string(n);
        if (std::find(existingIds.begin(), existingIds.end(), candidate) == existingIds.end()) {
            songId = candidate;
            break;
        }
    }

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);
    stop();
    joinPendingPeakBuilds(); // also reads `loader`; must finish before we hand it to the import thread
    streaming.stop(); // halts the I/O thread -- loader is exclusively ours until streaming.start() below

    // Private snapshot the background thread builds the new song into and
    // writes from -- see importWavForTrackAsync's matching comment for why
    // the shared loader.project() must stay untouched until completion.
    Project projectSnapshot = loader.project();
    const std::string defaultBusId = projectSnapshot.busses.front().id;
    const std::string archivePath = loader.archivePath();
    // Container (directory) format must be updated in place: saveAsWithExtras
    // would otherwise write a whole second directory tree at archivePath+
    // ".new", and finishAsyncImport's std::rename() onto the already-existing,
    // non-empty archivePath directory fails with ENOTEMPTY -- unlike the
    // legacy single-file .zip format, where renaming a temp file over the
    // final path is the safe, atomic way to do it. Mirrors
    // importWavForTrackAsync's identical isContainer check.
    const bool isContainer = loader.isDirectoryContainer();

    if (importThread.joinable())
        importThread.join();
    busyImporting.store(true, std::memory_order_release);

    importThread = std::thread([this, folderPath, songName, bpm, tsNumerator, tsDenominator, wavPaths, songId,
                                 defaultBusId, archivePath, isContainer, projectSnapshot, songToRestore, wasPlaying,
                                 onComplete]() mutable {
        std::string error;

        SongDef song;
        song.id = songId;
        song.name = songName.empty() ? std::filesystem::path(folderPath).filename().string() : songName;
        song.bpm = bpm > 0.0 ? bpm : 120.0;
        song.timeSignature.numerator = tsNumerator > 0 ? tsNumerator : 4;
        song.timeSignature.denominator = tsDenominator > 0 ? tsDenominator : 4;
        song.playbackMode = PlaybackMode::WaitForTrigger;

        std::vector<ProjectLoader::ExtraFile> extras;
        extras.reserve(wavPaths.size());
        // Peaks built inline per file below, from bytes already in RAM, and
        // persisted alongside the audio in the same save -- see the matching
        // comment in importWavForTrackAsync for why this (not a post-import
        // sweep) is what keeps a folder import from freezing the app.
        std::vector<ProjectLoader::ExtraFile> peakExtras;
        std::vector<std::pair<std::string, PeakOverview>> newPeakEntries;
        bool readOk = true;

        for (size_t i = 0; readOk && i < wavPaths.size(); ++i) {
            const std::filesystem::path srcPath(wavPaths[i]);
            FILE* f = std::fopen(srcPath.string().c_str(), "rb");
            if (f == nullptr) {
                error = "Failed to open file: " + srcPath.string();
                readOk = false;
                break;
            }
            std::fseek(f, 0, SEEK_END);
            const long sz = std::ftell(f);
            std::fseek(f, 0, SEEK_SET);
            if (sz <= 0 || sz > 512 * 1024 * 1024) {
                std::fclose(f);
                error = "Invalid or oversized WAV file: " + srcPath.string();
                readOk = false;
                break;
            }
            std::vector<uint8_t> data(static_cast<size_t>(sz));
            const bool got = std::fread(data.data(), 1, data.size(), f) == data.size();
            std::fclose(f);
            if (!got) {
                error = "Failed to read WAV file: " + srcPath.string();
                readOk = false;
                break;
            }

            const std::string base = srcPath.filename().string();
            const std::string entry = "Audio/" + base;

            PeakOverview overview;
            std::string peakError;
            if (overview.buildFromBuffer(data.data(), data.size(), peakError)) {
                peakExtras.push_back(PeakCache::makeCacheExtra(overview, entry));
                newPeakEntries.emplace_back(entry, std::move(overview));
            }

            ProjectLoader::ExtraFile extra;
            extra.archivePath = entry;
            extra.data = std::move(data);
            extras.push_back(std::move(extra));

            std::string category = autoDetectStemCategory(srcPath.filename().string());
            if (category == "Click") {
                song.builtInClickEnabled = true;
                continue;
            }

            std::string trackId;
            for (const auto& t : projectSnapshot.tracks) {
                if (juce::String(t.name).equalsIgnoreCase(juce::String(category)) || t.id == category) {
                    trackId = t.id;
                    break;
                }
            }
            if (trackId.empty()) {
                TrackDef track;
                track.id = "trk_" + std::to_string(projectSnapshot.tracks.size() + 1);
                track.name = category;
                track.busId = defaultBusId;
                projectSnapshot.tracks.push_back(track);
                trackId = track.id;
            }

            Region reg;
            reg.id = "reg_" + song.id + "_" + std::to_string(i + 1);
            reg.trackId = trackId;
            reg.file = entry;
            reg.durationSeconds = overview.durationSeconds;

            song.regions.push_back(std::move(reg));

        }

        bool writeOk = false;
        const std::string tempOut = isContainer ? archivePath : (archivePath + ".new");
        if (readOk) {
            projectSnapshot.songs.push_back(std::move(song));
            for (auto& pe : peakExtras)
                extras.push_back(std::move(pe));
            writeOk = loader.saveAsWithExtras(tempOut, extras, error, &projectSnapshot);

            if (writeOk) {
                std::lock_guard<std::mutex> lock(peakCacheMutex);
                for (auto& [path, overview] : newPeakEntries)
                    peakOverviewSessionCache[path] = std::move(overview);
            }
        }

        auto finishFn = [this, readOk, writeOk, error, tempOut, archivePath, songToRestore, wasPlaying, onComplete]() {
            finishAsyncImport(readOk && writeOk, error, tempOut, archivePath, songToRestore, wasPlaying, onComplete);
        };

        pendingFinishImport = finishFn;

        juce::MessageManager::callAsync([this]() {
            if (pendingFinishImport) {
                auto fn = std::move(pendingFinishImport);
                pendingFinishImport = nullptr;
                fn();
            }
        });
    });
}

} // namespace resoset
