// Timeline parity for the SPA: seek + peak-overview JSON for waveforms.

#include "MainComponent.h"

#include "server/WireTypes.h"

namespace resostage {

using namespace wire;

namespace {

WPeakOverview toWire(const PeakOverview* pk) {
    WPeakOverview dto{};
    if (pk != nullptr) {
        dto.durationSeconds = pk->durationSeconds;
        dto.levels.reserve(pk->levels.size());
        for (const auto& level : pk->levels) {
            WPeakLevel wLevel{};
            wLevel.samplesPerBin = level.samplesPerBin;
            wLevel.min.reserve(level.bins.size());
            wLevel.max.reserve(level.bins.size());
            wLevel.rms.reserve(level.bins.size());
            for (const auto& bin : level.bins) {
                wLevel.min.push_back(bin.minVal);
                wLevel.max.push_back(bin.maxVal);
                wLevel.rms.push_back(bin.rms);
            }
            dto.levels.push_back(std::move(wLevel));
        }
    }
    return dto;
}

} // namespace

void MainComponent::transportSeek(const std::string& json) {
    WSeekPayload payload{};
    if (glz::read_json(payload, json))
        return;

    const size_t targetSong = (payload.songIndex.has_value() && *payload.songIndex >= 0)
                                   ? static_cast<size_t>(*payload.songIndex)
                                   : static_cast<size_t>(-1);

    std::string error;
    if (!engine.seekToSeconds(payload.seconds, error, targetSong)) {
        setStatus("Seek failed: " + juce::String(error));
        return;
    }
    // seekToSeconds restages the song (see its own doc comment), which
    // kicks off a fresh background peak build same as any other song
    // (re)selection -- make sure the next tick's maybePublishPeaks() notices.
    lastPeaksPublishSongIndex = -2;
}

void MainComponent::maybePublishPeaks() {
    // Cheap string mirror so the HTTP thread can serve on-demand raw-sample
    // fetches (extreme-zoom waveform rendering) without ever touching
    // AudioEngine's loader directly -- see WebServer::serveWaveformRaw().
    webServer.publishArchivePath(engine.projectPath());

    const int songIdx = (engine.currentSongIndex() == static_cast<size_t>(-1))
                            ? -1
                            : static_cast<int>(engine.currentSongIndex());

    int filled = 0;
    bool complete = engine.trackCount() > 0;
    for (size_t i = 0; i < engine.trackCount(); ++i) {
        const PeakOverview* pk = engine.trackPeaksAt(i);
        if (pk != nullptr && !pk->empty()) {
            ++filled;
        } else {
            // Tracks with no audio region stay empty forever -- do not treat
            // them as "still building" or we never flip complete and keep
            // re-serializing multi-MB JSON at 2 Hz for the life of the session.
            // Heuristic: an empty slot after we already have some filled peaks
            // and no active builds is "done empty", not "pending".
            complete = false;
        }
    }
    // If every non-empty peak is in and nothing is still decoding, mark complete
    // even when some tracks have no region (blank lanes).
    if (engine.activePeakBuildCount() == 0 && filled > 0)
        complete = true;
    if (engine.trackCount() == 0)
        complete = true;

    if (songIdx == lastPeaksPublishSongIndex && lastPeaksPublishComplete
        && filled == lastPeaksPublishFilledCount)
        return; // nothing new since the last publish

    // While peaks are still streaming in, republish at most ~2 Hz -- BUT
    // always publish immediately when the filled count advances so the SPA
    // sees each track as it lands ("пики не грузит динамически").
    const juce::uint32 nowMs = juce::Time::getMillisecondCounter();
    const bool filledAdvanced = filled != lastPeaksPublishFilledCount;
    if (songIdx == lastPeaksPublishSongIndex && !complete && !filledAdvanced
        && (nowMs - lastPeaksPublishMs) < 500)
        return;

    webServer.publishPeaks(buildPeaksJson());
    lastPeaksPublishSongIndex = songIdx;
    lastPeaksPublishComplete = complete;
    lastPeaksPublishFilledCount = filled;
    lastPeaksPublishMs = nowMs;
}

std::string MainComponent::buildPeaksJson() const {
    WPeaksPayload wire{};
    wire.tracks.reserve(engine.trackCount());
    for (size_t i = 0; i < engine.trackCount(); ++i) {
        const PeakOverview* pk = engine.trackPeaksAt(i);
        WTrackPeakOverview tPeak{};
        tPeak.id = engine.trackIdAt(i);
        auto ov = toWire(pk);
        tPeak.durationSeconds = ov.durationSeconds;
        tPeak.levels = std::move(ov.levels);
        wire.tracks.push_back(std::move(tPeak));
    }
    std::string json;
    (void)glz::write_json(wire, json);
    return json;
}

void MainComponent::maybePublishAllPeaks() {
    if (!engine.isProjectLoaded())
        return;

    // Kick the background sweep only until everything is cached. Calling
    // ensureAllSongPeaksBuilt() every 30 Hz after completion was cheap, but
    // the file-count walk + repeated publishAllPeaks below was not.
    if (!lastAllPeaksComplete)
        engine.ensureAllSongPeaksBuilt();

    int totalFiles = 0, builtFiles = 0;
    for (const auto& song : engine.project().songs) {
        for (const auto& r : song.regions) {
            if (r.file.empty())
                continue;
            ++totalFiles;
            if (engine.cachedPeaksForFile(r.file) != nullptr)
                ++builtFiles;
        }
    }
    const bool complete = (totalFiles == 0) || (builtFiles == totalFiles);
    if (builtFiles == lastAllPeaksBuiltCount && complete == lastAllPeaksComplete)
        return; // nothing new since the last publish

    const juce::uint32 nowMs = juce::Time::getMillisecondCounter();
    if (!complete && (nowMs - lastAllPeaksPublishMs) < 500)
        return; // throttle incomplete multi-MB JSON rebuilds

    webServer.publishAllPeaks(buildAllPeaksJson());
    lastAllPeaksBuiltCount = builtFiles;
    lastAllPeaksComplete = complete;
    lastAllPeaksPublishMs = nowMs;
}

std::string MainComponent::buildAllPeaksJson() const {
    WAllPeaksPayload wire{};
    const auto& songs = engine.project().songs;
    wire.songs.reserve(songs.size());
    for (const auto& song : songs) {
        WSongPeaks songPeaks{};
        songPeaks.tracks.reserve(song.regions.size());
        for (const auto& r : song.regions) {
            const PeakOverview* pk = r.file.empty() ? nullptr : engine.cachedPeaksForFile(r.file);
            WRegionPeakOverview rPeak{};
            rPeak.id = r.id;
            rPeak.trackId = r.trackId;
            auto ov = toWire(pk);
            rPeak.durationSeconds = ov.durationSeconds;
            rPeak.levels = std::move(ov.levels);
            songPeaks.tracks.push_back(std::move(rPeak));
        }
        wire.songs.push_back(std::move(songPeaks));
    }
    std::string json;
    (void)glz::write_json(wire, json);
    return json;
}

} // namespace resostage
