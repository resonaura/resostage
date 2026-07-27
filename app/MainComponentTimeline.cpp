// Timeline parity for the web UI: click/drag-to-seek and per-track peak
// overview data (waveform bars). Mirrors TimelineView.cpp's seek handling
// (see PlayerPanel.cpp's onSeekRequest) and reuses the exact same
// AudioEngine::trackPeaksAt() data the native ClipTrimEditor/TimelineView
// already render from -- no separate client-side audio decode needed.

#include "MainComponent.h"
#include "web/BuilderJson.h"

#include <sstream>

namespace resoset {

using namespace builder_json;

void MainComponent::transportSeek(const std::string& json) {
    simdjson::dom::parser parser;
    simdjson::dom::element doc;
    double seconds = 0.0;
    if (parser.parse(json).get(doc) || !getDouble(doc, "seconds", seconds))
        return;

    std::string error;
    if (!engine.seekToSeconds(seconds, error)) {
        setStatus("Seek failed: " + juce::String(error));
        return;
    }
    playerPanel.refreshTransport();
    // seekToSeconds restages the song (see its own doc comment), which
    // kicks off a fresh background peak build same as any other song
    // (re)selection -- make sure the next tick's maybePublishPeaks() notices.
    lastPeaksPublishSongIndex = -2;
}

void MainComponent::maybePublishPeaks() {
    const int songIdx = (engine.currentSongIndex() == static_cast<size_t>(-1))
                            ? -1
                            : static_cast<int>(engine.currentSongIndex());

    bool complete = engine.trackCount() > 0;
    for (size_t i = 0; i < engine.trackCount(); ++i) {
        const PeakOverview* pk = engine.trackPeaksAt(i);
        if (pk == nullptr || pk->peaks.empty()) {
            complete = false;
            break;
        }
    }

    if (songIdx == lastPeaksPublishSongIndex && lastPeaksPublishComplete)
        return; // nothing new since the last publish

    webServer.publishPeaks(buildPeaksJson());
    lastPeaksPublishSongIndex = songIdx;
    lastPeaksPublishComplete = complete;
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
        o << "{\"id\":\"" << engine.trackIdAt(i) << "\","
          << "\"durationSeconds\":" << (pk != nullptr ? pk->durationSeconds : 0.0) << ","
          << "\"peaks\":[";
        if (pk != nullptr) {
            for (size_t b = 0; b < pk->peaks.size(); ++b) {
                if (b)
                    o << ",";
                o << pk->peaks[b];
            }
        }
        o << "]}";
    }
    o << "]}";
    return o.str();
}

} // namespace resoset
