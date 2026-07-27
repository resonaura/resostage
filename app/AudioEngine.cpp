#include "AudioEngine.h"

#include "audio/PeakCache.h"
#include "audio/WavMetadata.h"
#include "platform/AudioWorkgroup.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <thread>

namespace resoset {

namespace {
float dbToGain(double db) {
    if (db <= -144.0)
        return 0.0f;
    return static_cast<float>(std::pow(10.0, db / 20.0));
}

// A few seconds of lookahead is enough to absorb realistic disk-I/O
// slowness and short audio-callback stalls without an audible gap; large
// stalls beyond this are handled by StreamingTrackBuffer's catch-up skip
// (silence during the skip, correct resync afterward) rather than by
// growing this buffer -- see StreamingTrackBuffer's class comment.
constexpr double kRingBufferSeconds = 4.0;

// ~/Library/Application Support/ResoStage/Drafts/draft_<timestamp>.rsnraset
// (platform-appropriate equivalent elsewhere). Auto-created for every
// newProject() so imports have somewhere real to write to immediately,
// without forcing a manual Save As first. Deliberately never auto-deleted
// except on successful promotion to a real Save As location (see
// AudioEngine::saveProject) -- an abandoned draft from a crash or a quit
// without saving is a recoverable backup, not litter.
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
    const juce::String filename = "draft_" + juce::String(juce::Time::getCurrentTime().toMilliseconds()) + ".rsnraset";
    outPath = draftsDir.getChildFile(filename).getFullPathName().toStdString();
    return true;
}
} // namespace

AudioEngine::AudioEngine() {
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
    trackPeaks.resize(song.regions.size()); // blank lanes -- filled in as the background build below completes

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
    std::thread([this, generation, songIndexForBuild, archivePathForBuild, files = std::move(trackFiles)]() {
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
            for (size_t i = 0; i < files.size(); ++i) {
                if (peakBuildGeneration.load(std::memory_order_acquire) != generation)
                    break; // superseded by a newer selectSong -- abandon, don't waste I/O

                // Cheapest first: this session already computed it (e.g.
                // switching back to a song via Prev/Next -- no on-disk cache
                // exists yet for a freshly imported, not-yet-saved song, so
                // without this every reselect would redecode the whole file).
                {
                    std::lock_guard<std::mutex> cacheLock(peakCacheMutex);
                    if (auto it = peakOverviewSessionCache.find(files[i]); it != peakOverviewSessionCache.end()) {
                        buildResults[i] = it->second;
                        continue;
                    }
                }

                std::string error;
                // Prefer on-disk peak cache inside the .rsnraset (Peaks/*.rpk).
                bool built = PeakCache::loadFromArchive(peakLoader, files[i], buildResults[i], error);
                if (!built) {
                    // 4096 bins (PeakOverview::build's max) rather than a
                    // coarser count: at 512 bins, a multi-minute stem works
                    // out to ~13px per bin at typical timeline zoom,
                    // rendering as visibly blocky stepped rectangles instead
                    // of a smooth waveform. 4096 keeps that under ~2px/bin
                    // at the same zoom.
                    built = buildResults[i].build(peakLoader, files[i], 4096, error);
                    if (built)
                        buildExtras.push_back(PeakCache::makeCacheExtra(buildResults[i], files[i]));
                }
                if (built) {
                    std::lock_guard<std::mutex> cacheLock(peakCacheMutex);
                    peakOverviewSessionCache[files[i]] = buildResults[i];
                } else {
                    buildResults[i] = PeakOverview{};
                }
            }
        }

        // Done touching the archive -- unblock anything waiting in
        // joinPendingPeakBuilds() (load/save/new/import/quit) even though
        // this thread still has a message-thread hop left to do below.
        activePeakBuilds.fetch_sub(1, std::memory_order_release);

        juce::MessageManager::callAsync(
            [this, generation, songIndexForBuild, results = std::move(buildResults), newExtras = std::move(buildExtras)]() mutable {
                // Song changed again while this build was in flight -- discard.
                if (peakBuildGeneration.load(std::memory_order_acquire) != generation || currentSong != songIndexForBuild)
                    return;
                trackPeaks = std::move(results);
                if (songIndexForBuild < loader.project().songs.size()) {
                    auto& s = loader.project().songs[songIndexForBuild];
                    for (size_t i = 0; i < trackPeaks.size() && i < s.regions.size(); ++i) {
                        if (s.regions[i].durationSeconds <= 0.0 && trackPeaks[i].durationSeconds > 0.0) {
                            s.regions[i].durationSeconds = trackPeaks[i].durationSeconds;
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
            for (const auto& file : files) {
                PeakOverview overview;
                std::string error;
                bool built = PeakCache::loadFromArchive(peakLoader, file, overview, error);
                if (!built) {
                    built = overview.build(peakLoader, file, 4096, error);
                    if (built)
                        newExtras.push_back(PeakCache::makeCacheExtra(overview, file));
                }
                if (built) {
                    std::lock_guard<std::mutex> cacheLock(peakCacheMutex);
                    peakOverviewSessionCache[file] = std::move(overview);
                }
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

void AudioEngine::ensureTrackMeters(size_t count) {
    trackMeters.resize(count);
    for (size_t i = 0; i < count; ++i) {
        if (trackMeters[i] == nullptr)
            trackMeters[i] = std::make_unique<SeqLock<MeterFrame>>();
    }
}

void AudioEngine::buildBusListFromProject() {
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
    if (!projectLoaded || currentSong == static_cast<size_t>(-1))
        return;
    const Project& proj = loader.project();
    if (currentSong >= proj.songs.size())
        return;
    const SongDef& song = proj.songs[currentSong];

    bool anyTrackSolo = false;
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

void AudioEngine::refreshClickState() {
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
        clickGainLinear = dbToGain(song.builtInClickGainDb);
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

    if (!loader.open(path, error))
        return false;

    buildBusListFromProject();
    currentSong = static_cast<size_t>(-1);
    trackIdByIndex.clear();
    trackScratch.clear();
    trackMeters.clear();
    projectLoaded = true;
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

    streaming.start(&loader, [] { joinCurrentThreadToDefaultOutputWorkgroup(); },
                    [] { leaveCurrentThreadWorkgroupIfJoined(); });
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

    if (!loader.project().songs.empty()) {
        std::string err;
        selectSong(0, err);
    } else {
        currentSong = static_cast<size_t>(-1);
        trackIdByIndex.clear();
        trackScratch.clear();
        trackMeters.clear();
    }

    streaming.start(&loader, [] { joinCurrentThreadToDefaultOutputWorkgroup(); },
                    [] { leaveCurrentThreadWorkgroupIfJoined(); });
}

bool AudioEngine::saveProject(const std::string& path, std::string& error) {
    if (!projectLoaded) {
        error = "No project loaded";
        return false;
    }

    const size_t songToRestore = currentSong;
    const bool wasPlaying = playing.load(std::memory_order_acquire);

    stop();
    joinPendingPeakBuilds();
    streaming.stop();

    // If overwriting the open archive, we must release the zip handle first.
    const bool overwriteOpen = (path == loader.archivePath());
    // Saving a draft to a different, user-chosen path is a "promote the
    // draft" operation (subsequent edits should go to the real file the user
    // just picked, not the invisible draft), not a "keep editing the old
    // source, export a copy elsewhere" operation -- so it follows the same
    // close/replace/reopen sequence as overwriteOpen rather than the
    // save-a-copy branch below.
    const bool promotingDraft = usingDraftArchive && !overwriteOpen;
    const std::string oldDraftPath = usingDraftArchive ? loader.archivePath() : std::string();
    Project snapshot = loader.project(); // keep metadata if open fails after close
    std::string sourcePath = loader.archivePath();

    if (overwriteOpen || promotingDraft) {
        // saveAs needs a reader open to copy Audio/* -- clone via a temporary
        // source path strategy: saveAs to .new, close, replace, reopen.
        // Include any newly computed peak-cache files so next open is free.
        const std::string tempOut = path + ".new";
        if (!loader.saveAsWithExtras(tempOut, pendingPeakCacheExtras, error))
            return false;

        loader.close();
        // Atomically-ish replace original with .new
        std::remove(path.c_str());
        if (std::rename(tempOut.c_str(), path.c_str()) != 0) {
            error = "Failed to replace original archive after save";
            // Best effort: try to reopen whatever still exists.
            (void)loader.open(sourcePath, error);
            projectLoaded = loader.isOpen();
            if (projectLoaded)
                streaming.start(&loader, [] { joinCurrentThreadToDefaultOutputWorkgroup(); },
                    [] { leaveCurrentThreadWorkgroupIfJoined(); });
            return false;
        }
        if (!loader.open(path, error)) {
            projectLoaded = false;
            return false;
        }
        // Preserve in-memory edits that may have raced? We closed after saveAs
        // which already serialized the live project -- re-open reloads that.
        if (promotingDraft) {
            usingDraftArchive = false;
            if (!oldDraftPath.empty() && oldDraftPath != path)
                std::remove(oldDraftPath.c_str()); // clean up the now-orphaned draft
        }
    } else {
        if (!loader.saveAsWithExtras(path, pendingPeakCacheExtras, error))
            return false;

        if (!loader.isOpen()) {
            // No source archive was open (first save of a project created via
            // newProject(), never loaded from disk) -- open the file we just
            // wrote so archivePath() is populated and subsequent streaming /
            // WAV-import calls have a real zip handle to read Audio/* back
            // from, instead of silently having nothing to stream from.
            if (!loader.open(path, error)) {
                projectLoaded = false;
                return false;
            }
        }
        // Otherwise keep the current archive open for continued editing of
        // the source; if the user wanted save-as-and-switch they can load
        // the new path.
        (void)snapshot;
    }

    buildBusListFromProject();
    projectLoaded = true;
    streaming.start(&loader, [] { joinCurrentThreadToDefaultOutputWorkgroup(); },
                    [] { leaveCurrentThreadWorkgroupIfJoined(); });

    currentSong = static_cast<size_t>(-1);
    trackIdByIndex.clear();
    trackScratch.clear();
    trackMeters.clear();

    const auto& projTracks = loader.project().tracks;
    if (!projTracks.empty()) {
        for (const auto& t : projTracks) {
            trackIdByIndex.push_back(t.id);
        }
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
    return true;
}

bool AudioEngine::selectSong(size_t songIndex, std::string& error, bool fireOnLoadEventsFlag) {
    return selectSongInternal(songIndex, error, fireOnLoadEventsFlag, /*gaplessKeepPlaying=*/false);
}

bool AudioEngine::selectSongInternal(size_t songIndex, std::string& error, bool fireOnLoadEventsFlag,
                                     bool gaplessKeepPlaying) {
    if (!gaplessKeepPlaying)
        stop();
    else
        midiDispatcher.stopClock();

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

    const int64_t ringCapacityFrames = static_cast<int64_t>(currentSampleRate * kRingBufferSeconds);
    if (!streaming.stageSong(songIndex, song, ringCapacityFrames, currentSampleRate, error))
        return false;

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

    trackIdByIndex = std::move(newTrackIds);
    trackScratch.assign(trackIdByIndex.size(), juce::AudioBuffer<float>());
    ensureTrackMeters(trackIdByIndex.size());
    ensureScratchSizes();

    // Song length = longest track (frames at the song's native/device sample
    // rate), used to detect song end for playback-mode handling below.
    currentSongLengthFrames = 0;
    {
        StreamingEngine::ActiveSongHandle activeSong = streaming.acquireActiveSong();
        if (activeSong) {
            for (const std::string& trackId : trackIdByIndex) {
                if (StreamingTrackBuffer* buf = activeSong.track(trackId))
                    currentSongLengthFrames = std::max(currentSongLengthFrames, buf->totalFrames());
            }
        }
    }

    eventFiredFlags.assign(song.events.size(), 0);

    clickTargetBusIndex = -1;
    clickSendBusIndices.clear();
    clickSendGainLinears.clear();
    isClickEnabled = song.builtInClickEnabled;

    auto clickBusIt = busIndexById.find(song.builtInClickBusId.empty() ? (busses.empty() ? "" : busses.front().id) : song.builtInClickBusId);
    if (clickBusIt != busIndexById.end()) {
        clickTargetBusIndex = static_cast<int>(clickBusIt->second);
        clickGainLinear = dbToGain(song.builtInClickGainDb);
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

    currentSong = songIndex;
    publishRoutingSnapshot();
    rebuildTrackPeaks();

    // Reset playhead to the start of the newly staged song.
    clock.start(currentSampleRate, 0);
    underrunFadeOutRemaining = 0;
    recoveryFadeInRemaining = 0;
    lastCallbackWasUnderrun = false;

    if (gaplessKeepPlaying) {
        // Stay in PLAYING: restart timeline at 0 without a stop/start gap.
        playing.store(true, std::memory_order_release);
        transportTelemetry.playheadSamples.store(0, std::memory_order_relaxed);
        transportTelemetry.playheadSeconds.store(0.0, std::memory_order_relaxed);
        transportTelemetry.running.store(true, std::memory_order_relaxed);
        midiDispatcher.startClock(song.bpm, SystemMonotonicClock{}.nowNanos());
        recoveryFadeInRemaining = kUnderrunFadeSamples; // soft edge between songs
    } else {
        clock.stop();
        transportTelemetry.playheadSamples.store(0, std::memory_order_relaxed);
        transportTelemetry.playheadSeconds.store(0.0, std::memory_order_relaxed);
        transportTelemetry.running.store(false, std::memory_order_relaxed);
    }

    if (fireOnLoadEventsFlag)
        fireOnLoadEvents(song);

    if (songIndex + 1 < proj.songs.size())
        streaming.precacheSong(songIndex + 1, proj.songs[songIndex + 1], ringCapacityFrames, currentSampleRate);

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
    if (currentSong < proj.songs.size())
        midiDispatcher.startClock(proj.songs[currentSong].bpm, SystemMonotonicClock{}.nowNanos());

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
}

bool AudioEngine::seekToSeconds(double seconds, std::string& error) {
    if (!projectLoaded || currentSong == static_cast<size_t>(-1)) {
        error = "No song selected";
        return false;
    }

    const bool wasPlaying = playing.load(std::memory_order_acquire);
    const size_t songIndex = currentSong;

    // Restage from the start of the song so the disk stream can catch up to
    // any absolute position (StreamingTrackBuffer only fast-forwards).
    // Do not re-fire on_load MIDI/PC — seek is not a song change.
    if (!selectSong(songIndex, error, /*fireOnLoadEvents=*/false))
        return false;

    double maxSec = currentSongLengthSeconds();
    if (maxSec <= 0.0)
        maxSec = 24 * 3600.0;
    seconds = std::clamp(seconds, 0.0, maxSec);
    const int64_t sample = static_cast<int64_t>(seconds * currentSampleRate);

    // Mark past events as already fired so seek doesn't re-trigger them.
    const Project& proj = loader.project();
    if (songIndex < proj.songs.size()) {
        const SongDef& song = proj.songs[songIndex];
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

    clock.start(currentSampleRate, sample);
    transportTelemetry.playheadSamples.store(sample, std::memory_order_relaxed);
    transportTelemetry.playheadSeconds.store(seconds, std::memory_order_relaxed);

    if (wasPlaying) {
        if (songIndex < proj.songs.size())
            midiDispatcher.startClock(proj.songs[songIndex].bpm, SystemMonotonicClock{}.nowNanos());
        playing.store(true, std::memory_order_release);
        transportTelemetry.running.store(true, std::memory_order_relaxed);
    } else {
        clock.stop();
        transportTelemetry.running.store(false, std::memory_order_relaxed);
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
    const int64_t hwPos = hwSamplePosition.fetch_add(numSamples, std::memory_order_relaxed);
    clock.onAudioCallback(hostTimeNanos, hwPos);

    systemHealth.noteAudioCallback();
    // Underrun heuristic: gap between consecutive callbacks more than 2.5x the
    // expected block duration (or an explicit simulateUnderrun stall).
    bool underrunThisCallback = false;
    if (lastCallbackHostNanos != 0 && currentSampleRate > 0.0 && numSamples > 0) {
        const double expectedNs = (static_cast<double>(numSamples) / currentSampleRate) * 1.0e9;
        const double gapNs = static_cast<double>(hostTimeNanos - lastCallbackHostNanos);
        if (gapNs > expectedNs * 2.5 || stallMs > 0.0) {
            systemHealth.noteUnderrun();
            underrunThisCallback = true;
            underrunFadeOutRemaining = kUnderrunFadeSamples;
        }
    }
    // After an underrun gap, start a short fade-in so recovery isn't a click.
    if (lastCallbackWasUnderrun && !underrunThisCallback)
        recoveryFadeInRemaining = kUnderrunFadeSamples;
    lastCallbackWasUnderrun = underrunThisCallback;
    lastCallbackHostNanos = hostTimeNanos;

    transportTelemetry.playheadSamples.store(clock.currentSamplePosition(), std::memory_order_relaxed);
    transportTelemetry.playheadSeconds.store(clock.currentSeconds(), std::memory_order_relaxed);
    transportTelemetry.sampleRate.store(clock.sampleRate(), std::memory_order_relaxed);
    transportTelemetry.driftFactor.store(clock.driftFactor(), std::memory_order_relaxed);
    transportTelemetry.running.store(playing.load(std::memory_order_relaxed), std::memory_order_relaxed);

    if (!playing.load(std::memory_order_acquire)) {
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
            metersSilencedSinceStop = true;
        }
        return;
    }
    metersSilencedSinceStop = false;

    const std::shared_ptr<const RoutingSnapshot> snap = routing.acquireForRender();
    if (snap == nullptr || busses.empty())
        return;

    StreamingEngine::ActiveSongHandle activeSong = streaming.acquireActiveSong();
    if (!activeSong)
        return;

    const int64_t playheadSample = clock.currentSamplePosition();

    const Project& proj = loader.project();
    if (currentSong < proj.songs.size()) {
        const SongDef& song = proj.songs[currentSong];

        const double blockStartSeconds = static_cast<double>(playheadSample) / currentSampleRate;
        const double blockEndSeconds = static_cast<double>(playheadSample + numSamples) / currentSampleRate;
        fireDueEvents(song, blockStartSeconds, blockEndSeconds, hostTimeNanos);

        if (currentSongLengthFrames > 0 && playheadSample >= currentSongLengthFrames) {
            midiDispatcher.stopClock();
            if (song.playbackMode == PlaybackMode::AutoplayNext && currentSong + 1 < proj.songs.size()) {
                // Gapless path: freeze clock at end, keep PLAYING flag, ask the
                // message thread to promote the precached next song immediately.
                clock.stop();
                pendingGaplessSong.store(static_cast<int>(currentSong + 1), std::memory_order_release);
                autoAdvancePending.store(true, std::memory_order_release); // legacy alias
            } else {
                playing.store(false, std::memory_order_release);
                clock.stop();
            }
            return;
        }
    }

    // Pass 1: pull this block's audio from each track's stream exactly once
    // (a track may feed multiple busses, but must only be read from its ring
    // buffer once per block -- see StreamingTrackBuffer's class comment).
    for (size_t t = 0; t < trackIdByIndex.size(); ++t) {
        juce::AudioBuffer<float>& scratch = trackScratch[t];
        scratch.clear();

        StreamingTrackBuffer* buf = activeSong.track(trackIdByIndex[t]);
        if (buf == nullptr)
            continue;

        const int trackChannels = std::min(2, buf->numChannels());
        float* ptrs[2] = {scratch.getWritePointer(0), trackChannels > 1 ? scratch.getWritePointer(1) : scratch.getWritePointer(0)};
        buf->read(ptrs, numSamples, playheadSample);

        // Lightweight peak-only track meter for the Mixer UI (no LUFS on tracks).
        if (t < trackMeters.size() && trackMeters[t] != nullptr) {
            float peak = 0.0f;
            for (int ch = 0; ch < trackChannels; ++ch) {
                const float* s = scratch.getReadPointer(ch);
                for (int i = 0; i < numSamples; ++i)
                    peak = std::max(peak, std::abs(s[i]));
            }
            MeterFrame frame;
            frame.peakDb = peak > 1.0e-9f ? 20.0f * std::log10(peak) : -144.0f;
            frame.truePeakDb = frame.peakDb;
            trackMeters[t]->write(frame);
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

        const juce::AudioBuffer<float>& trackBuf = trackScratch[route.trackIndex];
        const int trackChannels = std::min(2, buf->numChannels());
        const int busChannels = std::min(2, busses[route.busIndex].channelCount);
        const int scratchOffset = static_cast<int>(route.busIndex) * 2;
        if (scratchOffset + busChannels > scratchChannels)
            continue;

        const float* srcL = trackBuf.getReadPointer(0);
        const float* srcR = trackChannels > 1 ? trackBuf.getReadPointer(1) : srcL;

        const float g = route.gainLinear * route.sendGainLinear;
        if (trackChannels >= 2 && busChannels >= 2) {
            for (int i = 0; i < numSamples; ++i) {
                busScratch.addSample(scratchOffset + 0, i, srcL[i] * g);
                busScratch.addSample(scratchOffset + 1, i, srcR[i] * g);
            }
        } else {
            const float gL = g * (1.0f - std::max(0.0f, route.pan));
            const float gR = g * (1.0f + std::min(0.0f, route.pan));
            for (int i = 0; i < numSamples; ++i) {
                const float mono = srcL[i];
                if (busChannels >= 2) {
                    busScratch.addSample(scratchOffset + 0, i, mono * gL);
                    busScratch.addSample(scratchOffset + 1, i, mono * gR);
                } else {
                    busScratch.addSample(scratchOffset + 0, i, mono * g);
                }
            }
        }
    }

    // Built-in click generator: mixed directly into its target bus's scratch
    // region (mono summed to both channels), same as any other source, so it
    // participates in metering and physical output routing normally.
    // Also mixed into every send bus from builtInClickSends (monitor mixes).
    const bool clickActive = clickTargetBusIndex >= 0 && static_cast<size_t>(clickTargetBusIndex) < busses.size();
    const bool clickHasSends = !clickSendBusIndices.empty();
    if (clickActive || clickHasSends) {
        clickGenerator.render(clickScratch.data(), numSamples, playheadSample);

        if (isClickEnabled) {
            // Main target bus
            if (clickActive) {
                const int scratchOffset = clickTargetBusIndex * 2;
                if (scratchOffset + 2 <= scratchChannels) {
                    for (int i = 0; i < numSamples; ++i) {
                        const float v = clickScratch[static_cast<size_t>(i)] * clickGainLinear;
                        busScratch.addSample(scratchOffset + 0, i, v);
                        busScratch.addSample(scratchOffset + 1, i, v);
                    }
                }
            }

            // Send buses (aux monitor mixes)
            for (size_t si = 0; si < clickSendBusIndices.size(); ++si) {
                const int sendBusIdx = clickSendBusIndices[si];
                if (static_cast<size_t>(sendBusIdx) >= busses.size())
                    continue;
                const int scratchOffset = sendBusIdx * 2;
                if (scratchOffset + 2 > scratchChannels)
                    continue;
                const float sendGain = clickSendGainLinears[si];
                for (int i = 0; i < numSamples; ++i) {
                    const float v = clickScratch[static_cast<size_t>(i)] * sendGain;
                    busScratch.addSample(scratchOffset + 0, i, v);
                    busScratch.addSample(scratchOffset + 1, i, v);
                }
            }
        }
    }

    // Pass 3: bus scratch buffers -> metering + physical outputs.
    for (const BusOutput& out : snap->outputs) {
        if (out.busIndex >= busses.size())
            continue;
        const int scratchOffset = static_cast<int>(out.busIndex) * 2;
        const int channels = std::min(2, out.channelCount);

        if (out.busIndex < busLoudnessMeters.size()) {
            const float* meterChannels[2] = {
                busScratch.getReadPointer(scratchOffset),
                channels > 1 ? busScratch.getReadPointer(scratchOffset + 1) : busScratch.getReadPointer(scratchOffset)};
            busLoudnessMeters[out.busIndex].processBlock(meterChannels, numSamples);
            if (out.busIndex < busMeters.size() && busMeters[out.busIndex] != nullptr)
                busMeters[out.busIndex]->write(busLoudnessMeters[out.busIndex].currentFrame());
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

    // Spec micro-fade: 128-sample linear fade-out after underrun detection and
    // fade-in on recovery. Applied to the summed physical outputs only.
    if (underrunFadeOutRemaining > 0 || recoveryFadeInRemaining > 0) {
        for (int i = 0; i < numSamples; ++i) {
            float g = 1.0f;
            if (underrunFadeOutRemaining > 0) {
                g = static_cast<float>(underrunFadeOutRemaining) / static_cast<float>(kUnderrunFadeSamples);
                --underrunFadeOutRemaining;
            } else if (recoveryFadeInRemaining > 0) {
                const int done = kUnderrunFadeSamples - recoveryFadeInRemaining;
                g = static_cast<float>(done + 1) / static_cast<float>(kUnderrunFadeSamples);
                --recoveryFadeInRemaining;
            }
            for (int ch = 0; ch < numOutputChannels; ++ch)
                if (outputChannelData[ch] != nullptr)
                    outputChannelData[ch][i] *= g;
        }
    }
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

    busyImporting.store(true, std::memory_order_release);

    importThread = std::thread([this, filesystemPath, entry, archivePath, projectSnapshot, songToRestore, wasPlaying,
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
        const std::string tempOut = archivePath + ".new";
        if (readOk) {
            ProjectLoader::ExtraFile extra;
            extra.archivePath = entry;
            extra.data = std::move(data);
            writeOk = loader.saveAsWithExtras(tempOut, {extra}, error, &projectSnapshot);
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
        streaming.start(&loader, [] { joinCurrentThreadToDefaultOutputWorkgroup(); },
                        [] { leaveCurrentThreadWorkgroupIfJoined(); });
        done(false, writeError);
        return;
    }

    // A successful import may have replaced the audio behind an existing
    // archive path (re-importing a WAV with the same filename) -- drop the
    // whole session peak cache rather than trying to track which entries
    // are still valid; imports are rare enough that recomputing is cheap.
    peakOverviewSessionCache.clear();

    if (std::rename(tempOut.c_str(), archivePath.c_str()) != 0) {
        std::string reopenError;
        (void)loader.reopenArchiveKeepProject(archivePath, reopenError);
        projectLoaded = loader.isOpen();
        if (projectLoaded)
            streaming.start(&loader, [] { joinCurrentThreadToDefaultOutputWorkgroup(); },
                            [] { leaveCurrentThreadWorkgroupIfJoined(); });
        done(false, "Failed to replace archive after import");
        return;
    }

    std::string openError;
    if (!loader.reopenArchiveKeepProject(archivePath, openError)) {
        projectLoaded = false;
        done(false, "Import written, but failed to reopen archive: " + openError);
        return;
    }
    projectLoaded = true;
    buildBusListFromProject();
    streaming.start(&loader, [] { joinCurrentThreadToDefaultOutputWorkgroup(); },
                    [] { leaveCurrentThreadWorkgroupIfJoined(); });

    currentSong = static_cast<size_t>(-1);
    trackIdByIndex.clear();
    trackScratch.clear();
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

    if (importThread.joinable())
        importThread.join();
    busyImporting.store(true, std::memory_order_release);

    importThread = std::thread([this, folderPath, songName, bpm, tsNumerator, tsDenominator, wavPaths, songId,
                                 defaultBusId, archivePath, projectSnapshot, songToRestore, wasPlaying,
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
            song.regions.push_back(std::move(reg));
        }

        bool writeOk = false;
        const std::string tempOut = archivePath + ".new";
        if (readOk) {
            projectSnapshot.songs.push_back(std::move(song));
            writeOk = loader.saveAsWithExtras(tempOut, extras, error, &projectSnapshot);
        }

        juce::MessageManager::callAsync([this, readOk, writeOk, error, tempOut, archivePath, songToRestore,
                                          wasPlaying, onComplete]() mutable {
            finishAsyncImport(readOk && writeOk, error, tempOut, archivePath, songToRestore, wasPlaying, onComplete);
        });
    });
}

} // namespace resoset
