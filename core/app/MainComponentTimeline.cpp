// Timeline parity for the SPA: seek + peak-overview JSON for waveforms.

#include "MainComponent.h"
#include "web/BuilderJson.h"

#include <sstream>

namespace resostage {

using namespace builder_json;

namespace {
void writePeakOverviewJson(std::ostringstream& o, const PeakOverview* pk) {
    o << "\"durationSeconds\":" << (pk != nullptr ? pk->durationSeconds : 0.0) << ","
      << "\"levels\":[";
    if (pk != nullptr) {
        for (size_t li = 0; li < pk->levels.size(); ++li) {
            if (li)
                o << ",";
            const PeakLevel& level = pk->levels[li];
            o << "{\"samplesPerBin\":" << level.samplesPerBin << ",\"min\":[";
            for (size_t b = 0; b < level.bins.size(); ++b) {
                if (b)
                    o << ",";
                o << level.bins[b].minVal;
            }
            o << "],\"max\":[";
            for (size_t b = 0; b < level.bins.size(); ++b) {
                if (b)
                    o << ",";
                o << level.bins[b].maxVal;
            }
            o << "],\"rms\":[";
            for (size_t b = 0; b < level.bins.size(); ++b) {
                if (b)
                    o << ",";
                o << level.bins[b].rms;
            }
            o << "]}";
        }
    }
    o << "]";
}
} // namespace

void MainComponent::transportSeek(const std::string& json) {
    glz::json_t doc;
    double seconds = 0.0;
    if (!parseJson(json, doc) || !getDouble(doc, "seconds", seconds))
        return;

    // Optional cross-song seek: absent "songIndex" means "seek within the
    // currently staged song", matching seekToSeconds()'s default-argument
    // sentinel -- see Timeline.tsx's seekFromClientX for the drag-across-
    // song-boundaries case this exists for.
    int songIndexField = -1;
    const size_t targetSong = getInt(doc, "songIndex", songIndexField) && songIndexField >= 0
                                   ? static_cast<size_t>(songIndexField)
                                   : static_cast<size_t>(-1);

    std::string error;
    if (!engine.seekToSeconds(seconds, error, targetSong)) {
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
    std::ostringstream o;
    o.setf(std::ios::fixed);
    o.precision(4);
    o << "{\"tracks\":[";
    for (size_t i = 0; i < engine.trackCount(); ++i) {
        if (i)
            o << ",";
        const PeakOverview* pk = engine.trackPeaksAt(i);
        o << "{\"id\":\"" << engine.trackIdAt(i) << "\",";
        writePeakOverviewJson(o, pk);
        o << "}";
    }
    o << "]}";
    return o.str();
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
    std::ostringstream o;
    o.setf(std::ios::fixed);
    o.precision(4);
    o << "{\"songs\":[";
    const auto& songs = engine.project().songs;
    for (size_t s = 0; s < songs.size(); ++s) {
        if (s)
            o << ",";
        o << "{\"tracks\":[";
        const auto& regions = songs[s].regions;
        for (size_t i = 0; i < regions.size(); ++i) {
            if (i)
                o << ",";
            const PeakOverview* pk = regions[i].file.empty() ? nullptr : engine.cachedPeaksForFile(regions[i].file);
            o << "{\"id\":\"" << regions[i].id << "\","
              << "\"trackId\":\"" << regions[i].trackId << "\",";
            writePeakOverviewJson(o, pk);
            o << "}";
        }
        o << "]}";
    }
    o << "]}";
    return o.str();
}

} // namespace resostage
