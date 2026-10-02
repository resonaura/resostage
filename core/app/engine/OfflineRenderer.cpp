/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "OfflineRenderer.h"
#include "OfflineMidiEvents.h"
#include "OfflineWAVWriter.h"
#include "OfflineOutputFile.h"

#include "audio/dsp/ClickGenerator.h"
#include "audio/graph/MixGraph.h"
#include "audio/graph/MixRenderer.h"
#include "audio/streaming/WAVStreamDecoder.h"
#include "automation/AutomationEvaluator.h"
#include "project/ProjectLoader.h"
#include "project/MidiRegionLoop.h"
#include "plugins/PluginParameterBinding.h"
#include "timing/TempoMap.h"
#include "signalsmith-stretch/signalsmith-stretch.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <memory>
#include <random>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace resostage {
using offline_detail::OfflineMidiEvent;
using offline_detail::buildOfflineMidiEvents;
using offline_detail::WAVWriter;

void OfflineProcessorSession::setPluginParameterById(const std::string& slotId,
    std::string_view parameterId, float normalizedValue) noexcept {
    const int index = resolvePluginParameterBinding({}, parameterId);
    if (index >= 0) setPluginParameter(slotId, index, normalizedValue);
}

namespace {

constexpr int kBlockSize = 1024;
constexpr int64_t kSourceCacheFrames = 8192;
constexpr uint64_t kMaximumTapDelayBytes = 64ull * 1024ull * 1024ull;

bool parseAutomationIndex(std::string_view id, std::string_view prefix,
                          int& index) noexcept {
    if (id.starts_with(prefix))
        id.remove_prefix(prefix.size());
    if (id.empty())
        return false;
    const auto parsed = std::from_chars(id.data(), id.data() + id.size(), index);
    return parsed.ec == std::errc{} && parsed.ptr == id.data() + id.size();
}

float normalizedAutomationValue(const AutomationLane& lane, float value) noexcept {
    const float minValue = lane.target.minValue;
    const float maxValue = lane.target.maxValue;
    if (maxValue <= minValue + 1.0e-6f)
        return std::clamp(value, 0.0f, 1.0f);
    return std::clamp((value - minValue) / (maxValue - minValue), 0.0f, 1.0f);
}

float dbToGain(double db) {
    return static_cast<float>(std::pow(10.0, db / 20.0));
}

float shapedFade(double t, double curve) {
    const double x = std::clamp(t, 0.0, 1.0);
    return static_cast<float>(std::pow(x, std::pow(2.0, -std::clamp(curve, -1.0, 1.0) * 2.0)));
}

class StereoTapDelay {
public:
    explicit StereoTapDelay(uint32_t delaySamples)
        : left(delaySamples, 0.0f), right(delaySamples, 0.0f) {}

    void process(const float* inputLeft, const float* inputRight,
                 float* outputLeft, float* outputRight, int frames) noexcept {
        if (left.empty()) {
            std::copy_n(inputLeft, frames, outputLeft);
            std::copy_n(inputRight, frames, outputRight);
            return;
        }
        for (int frame = 0; frame < frames; ++frame) {
            const float sourceLeft = inputLeft[frame];
            const float sourceRight = inputRight[frame];
            outputLeft[frame] = left[cursor];
            outputRight[frame] = right[cursor];
            left[cursor] = sourceLeft;
            right[cursor] = sourceRight;
            if (++cursor == left.size())
                cursor = 0;
        }
    }

private:
    std::vector<float> left;
    std::vector<float> right;
    size_t cursor = 0;
};

class WavSource {
public:
    bool open(const ProjectLoader& loader, const std::string& path, std::string& error) {
        cursor = loader.openStream(path, error);
        if (!cursor.isValid()) return false;
        const auto read = [this](void* dst, size_t bytes) { return cursor.read(dst, bytes); };
        if (!decoder.parseHeader(read, error)) return false;
        dataOffset = cursor.tell();
        if (dataOffset < 0) {
            error = "Source is not seekable: " + path;
            return false;
        }
        cache.resize(static_cast<size_t>(std::max(1, decoder.numChannels())));
        for (auto& channel : cache) channel.resize(static_cast<size_t>(kSourceCacheFrames + 2));
        return true;
    }

    double sampleRate() const { return decoder.sampleRate(); }
    int64_t totalFrames() const { return decoder.totalFrames(); }

    float sample(int channel, double frame) {
        if (frame < 0.0 || frame >= static_cast<double>(totalFrames())) return 0.0f;
        const int64_t first = static_cast<int64_t>(std::floor(frame));
        if (!contains(first) || !contains(std::min(first + 1, totalFrames() - 1))) {
            if (!load(first)) return 0.0f;
        }
        const int ch = std::clamp(channel, 0, std::max(0, decoder.numChannels() - 1));
        const int64_t i0 = first - cacheStart;
        const int64_t i1 = std::min<int64_t>(i0 + 1, cacheCount - 1);
        const float frac = static_cast<float>(frame - static_cast<double>(first));
        const float a = cache[static_cast<size_t>(ch)][static_cast<size_t>(i0)];
        const float b = cache[static_cast<size_t>(ch)][static_cast<size_t>(i1)];
        return a + (b - a) * frac;
    }

private:
    bool contains(int64_t frame) const {
        return frame >= cacheStart && frame < cacheStart + cacheCount;
    }

    bool load(int64_t requestedFrame) {
        cacheStart = std::clamp<int64_t>(requestedFrame, 0, std::max<int64_t>(0, totalFrames() - 1));
        const int64_t wanted = std::min<int64_t>(kSourceCacheFrames + 1, totalFrames() - cacheStart);
        if (wanted <= 0) return false;
        const int64_t byteOffset = dataOffset + cacheStart * decoder.bytesPerFrame();
        if (!cursor.seekAbsolute(byteOffset)) return false;
        decoder.resetDataCursor();
        std::vector<float*> ptrs;
        ptrs.reserve(cache.size());
        for (auto& channel : cache) ptrs.push_back(channel.data());
        const auto read = [this](void* dst, size_t bytes) { return cursor.read(dst, bytes); };
        cacheCount = decoder.decodeFrames(read, ptrs.data(), wanted);
        return cacheCount > 0;
    }

    ProjectLoader::StreamCursor cursor;
    WAVStreamDecoder decoder;
    int64_t dataOffset = -1;
    int64_t cacheStart = -1;
    int64_t cacheCount = 0;
    std::vector<std::vector<float>> cache;
};

struct RegionReader {
    const Region* region = nullptr;
    std::unique_ptr<WavSource> source;
    signalsmith::stretch::SignalsmithStretch<float> pitch;
    bool pitchReady = false;

    void preparePitch(double sampleRate) {
        if (region == nullptr || std::abs(region->playback.semitones) < 1.0e-6) return;
        pitch.presetDefault(2, static_cast<float>(sampleRate));
        pitch.setTransposeSemitones(static_cast<float>(region->playback.semitones));
        pitch.setFormantFactor(1.0f, true);
        pitch.reset();
        pitchReady = true;
    }
};

double tempoAtBeat(const TempoMap& tempoMap, double beat) noexcept {
    const auto& points = tempoMap.points();
    if (points.empty()) return 120.0;
    size_t index = 0;
    for (size_t i = 1; i < points.size() && points[i].beat <= beat; ++i)
        index = i;
    const auto& point = points[index];
    if (index + 1 >= points.size() || std::abs(point.curve) < 1.0e-9)
        return point.bpm;
    const auto& next = points[index + 1];
    if (next.beat <= point.beat)
        return next.bpm;
    const double t = std::clamp((beat - point.beat) / (next.beat - point.beat), 0.0, 1.0);
    return point.bpm + (next.bpm - point.bpm) * t;
}

double regionDuration(const RegionReader& reader) {
    if (reader.region == nullptr || reader.source == nullptr) return 0.0;
    if (reader.region->durationSeconds > 0.0) return reader.region->durationSeconds;
    return std::max(0.0, static_cast<double>(reader.source->totalFrames())
                              / reader.source->sampleRate());
}

double songDuration(const SongDef& song, const std::vector<RegionReader>& readers) {
    if (song.endSeconds > 0.0) return song.endSeconds;
    double end = 0.0;
    for (const auto& reader : readers)
        end = std::max(end, reader.region->startSeconds + regionDuration(reader));
    for (const auto& event : song.events) end = std::max(end, event.timeSeconds);
    const TempoMap tempoMap(song.bpm, song.tempoPoints);
    for (const auto& region : song.midiRegions)
        end = std::max(end, tempoMap.beatsToSeconds(
            region.startBeats + region.durationBeats));
    return end;
}

uint32_t targetStrip(const MixGraph& graph, RenderTargetKind kind, const std::string& id) {
    switch (kind) {
        case RenderTargetKind::Master: return graph.find("audio::main");
        case RenderTargetKind::Click: return graph.find("audio::click");
        case RenderTargetKind::Bus:
        case RenderTargetKind::Track: return graph.find(id);
    }
    return MixGraph::kNoStrip;
}

} // namespace

OfflineRenderResult OfflineRenderer::render(const Project& project,
                                             const std::string& projectPath,
                                             const OfflineRenderRequest& request,
                                             const Progress& onProgress,
                                             const std::atomic<bool>* cancel,
                                             const ProcessorFactory& processorFactory) const {
    OfflineRenderResult result;
    if (request.sampleRate < 8000 || request.sampleRate > 384000) {
        result.error = "Sample rate must be between 8 kHz and 384 kHz"; return result;
    }
    if (request.bitDepth != 16 && request.bitDepth != 24 && request.bitDepth != 32) {
        result.error = "Bit depth must be 16, 24, or 32"; return result;
    }
    if (project.songs.empty()) { result.error = "Project has no songs"; return result; }

    std::vector<OfflineRenderTarget> targets = request.targets;
    if (targets.empty()) {
        targets.push_back({request.targetKind, request.targetId, request.outputPath});
    }
    if (targets.empty()) { result.error = "No render outputs selected"; return result; }
    for (const auto& target : targets) {
        if (target.outputPath.empty()) { result.error = "Output path is empty"; return result; }
        if (std::find(result.outputPaths.begin(), result.outputPaths.end(), target.outputPath)
            != result.outputPaths.end()) {
            result.error = "Two render outputs resolve to the same file";
            return result;
        }
        result.outputPaths.push_back(target.outputPath);
    }
    result.outputPath = result.outputPaths.front();

    std::vector<int> songIndices;
    if (request.songIndex >= 0) {
        if (request.songIndex >= static_cast<int>(project.songs.size())) {
            result.error = "Song index is out of range"; return result;
        }
        songIndices.push_back(request.songIndex);
    } else {
        for (int i = 0; i < static_cast<int>(project.songs.size()); ++i) songIndices.push_back(i);
    }

    ProjectLoader loader;
    if (!projectPath.empty()) {
        std::string openError;
        if (!loader.open(projectPath, openError)) { result.error = openError; return result; }
    }
    std::error_code ec;
    std::vector<std::unique_ptr<WAVWriter>> writers;
    writers.reserve(targets.size());
    for (const auto& target : targets) {
        std::filesystem::create_directories(
            offline_detail::outputFilePath(target.outputPath).parent_path(), ec);
        auto writer = std::make_unique<WAVWriter>();
        if (!writer->open(target.outputPath, request.sampleRate, request.bitDepth,
                          request.dither, request.normalization,
                          request.normalizationCeilingDb, result.error)) {
            for (auto& opened : writers) opened->abort();
            return result;
        }
        writers.push_back(std::move(writer));
    }

    const auto fail = [&](std::string message) {
        result.error = std::move(message);
        for (auto& writer : writers) writer->abort();
        return result;
    };

    // Progress is duration-weighted against the hard maximum. It may reach
    // completion early when Leave observes its quiet hold before maxTail.
    double totalSeconds = 0.0;
    for (int si : songIndices) {
        const auto& song = project.songs[static_cast<size_t>(si)];
        double d = song.endSeconds;
        if (d <= 0.0) {
            for (const auto& region : song.regions)
                d = std::max(d, region.startSeconds + std::max(0.0, region.durationSeconds));
            d = std::max(d, songDuration(song, {}));
        }
        const double rangeStart = songIndices.size() == 1
            ? std::clamp(request.rangeStartSeconds, 0.0, std::max(0.0, d)) : 0.0;
        const double rangeEnd = songIndices.size() == 1 && request.rangeEndSeconds > rangeStart
            ? std::min(request.rangeEndSeconds, d) : d;
        d = std::max(0.01, rangeEnd - rangeStart)
            + std::max(0.0, request.tailSeconds)
            + (request.tailPolicy == RenderTailPolicy::Leave
                   ? std::clamp(request.maxTailSeconds, 0.0, 60.0) : 0.0);
        if (request.tailPolicy == RenderTailPolicy::Wrap) d *= 2.0;
        totalSeconds += d;
    }

    double completedSeconds = 0.0;
    int64_t processedWorkFrames = 0;
    for (size_t selection = 0; selection < songIndices.size(); ++selection) {
        if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
            return fail("Render cancelled");
        }
        const SongDef& song = project.songs[static_cast<size_t>(songIndices[selection])];

        bool needsEveryTrack = false;
        std::unordered_map<std::string, bool> requestedTracks;
        for (const auto& target : targets) {
            if (target.kind == RenderTargetKind::Master || target.kind == RenderTargetKind::Bus)
                needsEveryTrack = true;
            if (target.kind == RenderTargetKind::Track)
                requestedTracks[target.id] = true;
        }
        std::vector<RegionReader> regions;
        regions.reserve(song.regions.size());
        for (const Region& region : song.regions) {
            // A tracks/click-only job need not decode unrelated sources. Any
            // bus or master tap must retain every input because sends and
            // routing can make an apparently unrelated track audible there.
            if (!needsEveryTrack && !requestedTracks.contains(region.trackId))
                continue;
            RegionReader rr;
            rr.region = &region;
            rr.source = std::make_unique<WavSource>();
            if (!rr.source->open(loader, region.source.file, result.error)) {
                return fail(result.error);
            }
            rr.preparePitch(request.sampleRate);
            regions.push_back(std::move(rr));
        }

        double authoredEnd = song.endSeconds;
        if (authoredEnd <= 0.0) {
            // Use all authored region durations even if this job deliberately
            // skipped decoding unselected tracks.
            for (const auto& region : song.regions)
                authoredEnd = std::max(authoredEnd,
                    region.startSeconds + std::max(0.0, region.durationSeconds));
            authoredEnd = std::max(authoredEnd, songDuration(song, regions));
        }
        const double rangeStart = songIndices.size() == 1
            ? std::clamp(request.rangeStartSeconds, 0.0, std::max(0.0, authoredEnd)) : 0.0;
        const double rangeEnd = songIndices.size() == 1 && request.rangeEndSeconds > rangeStart
            ? std::min(request.rangeEndSeconds, authoredEnd) : authoredEnd;
        const int64_t contentFrames = std::max<int64_t>(1,
            static_cast<int64_t>(std::ceil(std::max(0.0, rangeEnd - rangeStart) * request.sampleRate)));
        const int64_t fixedTailFrames = static_cast<int64_t>(
            std::max(0.0, request.tailSeconds) * request.sampleRate);
        const int64_t maxTailFrames = request.tailPolicy == RenderTailPolicy::Leave
            ? static_cast<int64_t>(std::clamp(request.maxTailSeconds, 0.0, 60.0)
                                   * request.sampleRate)
            : 0;
        const int64_t quietFramesNeeded = std::max<int64_t>(1,
            static_cast<int64_t>(std::clamp(request.tailQuietSeconds, 0.05, 10.0)
                                 * request.sampleRate));
        const float tailThreshold = dbToGain(
            std::clamp(request.tailThresholdDb, -144.0, -24.0));
        OutputLaneConfig outputs;
        outputs.totalChannels = 2;
        const MixGraph graph = buildMixGraph(project, outputs);
        std::vector<uint32_t> selectedStrips;
        selectedStrips.reserve(targets.size());
        for (const auto& target : targets) {
            const uint32_t strip = targetStrip(graph, target.kind, target.id);
            if (strip == MixGraph::kNoStrip)
                return fail("Render target does not exist: " + target.id);
            selectedStrips.push_back(strip);
        }
        MixRenderer mixer;
        mixer.prepare(request.sampleRate, kBlockSize, graph.strips.size(),
                      graph.edges.size());
        std::unique_ptr<OfflineProcessorSession> processorSession;
        if (processorFactory) {
            processorSession = processorFactory(
                project, graph, request.sampleRate, kBlockSize, result.error);
            if (processorSession == nullptr && !result.error.empty())
                return fail(result.error);
            if (processorSession != nullptr) {
                for (auto& warning : processorSession->warnings()) {
                    if (std::find(result.warnings.begin(), result.warnings.end(),
                                  warning) == result.warnings.end()) {
                        result.warnings.push_back(std::move(warning));
                    }
                }
            }
        }
        const MixProcessorView processors = processorSession != nullptr
            ? processorSession->processorView() : MixProcessorView{};
        const int64_t declaredTailFrames =
            request.tailPolicy == RenderTailPolicy::Leave
            && processorSession != nullptr
                ? std::min<int64_t>(
                    maxTailFrames,
                    static_cast<int64_t>(std::ceil(std::max(
                        0.0, processorSession->declaredTailSeconds())
                        * request.sampleRate)))
                : 0;
        uint32_t selectedMaximumLatency = 0;
        if (processors.stripOutputLatencySamples != nullptr) {
            for (const uint32_t strip : selectedStrips) {
                if (strip < processors.stripOutputLatencyCount) {
                    selectedMaximumLatency = std::max(
                        selectedMaximumLatency,
                        processors.stripOutputLatencySamples[strip]);
                }
            }
        }
        std::vector<std::unique_ptr<StereoTapDelay>> tapDelays(
            selectedStrips.size());
        uint64_t tapDelayBytes = 0;
        for (size_t outputIndex = 0;
             outputIndex < selectedStrips.size(); ++outputIndex) {
            const uint32_t strip = selectedStrips[outputIndex];
            const uint32_t stripLatency =
                processors.stripOutputLatencySamples != nullptr
                    && strip < processors.stripOutputLatencyCount
                ? processors.stripOutputLatencySamples[strip] : 0;
            const uint32_t delaySamples =
                selectedMaximumLatency > stripLatency
                    ? selectedMaximumLatency - stripLatency : 0;
            tapDelayBytes += static_cast<uint64_t>(delaySamples)
                             * 2ull * sizeof(float);
            if (tapDelayBytes > kMaximumTapDelayBytes) {
                return fail(
                    "Selected stem delay compensation exceeds the 64 MiB memory budget");
            }
            if (delaySamples > 0) {
                tapDelays[outputIndex] =
                    std::make_unique<StereoTapDelay>(delaySamples);
            }
        }
        ClickGenerator click;
        click.prepare(request.sampleRate, song.bpm, song.timeSignature.numerator,
                      song.timeSignature.denominator);
        const TempoMap tempoMap(song.bpm, song.tempoPoints);
        std::vector<OfflineMidiEvent> midiEvents;
        const int64_t sourceStartFrame = static_cast<int64_t>(std::llround(rangeStart * request.sampleRate));
        const int64_t renderContentEndFrame = sourceStartFrame + contentFrames;
        if (!buildOfflineMidiEvents(project, song, graph, tempoMap,
                                    processorSession.get(),
                                    request.sampleRate, sourceStartFrame,
                                    renderContentEndFrame,
                                    midiEvents, result.error))
            return fail(result.error);

        std::vector<float> regionL(kBlockSize), regionR(kBlockSize);
        std::vector<float> pitchL(kBlockSize), pitchR(kBlockSize);
        std::vector<float> clickMono(kBlockSize);
        const int64_t outputEndFrame =
            contentFrames + fixedTailFrames + maxTailFrames;
        const int64_t trimLatencyFrames =
            request.trimOutputLatency
                && request.tailPolicy != RenderTailPolicy::Wrap
            ? static_cast<int64_t>(selectedMaximumLatency) : 0;
        const int64_t renderEndFrame = outputEndFrame + trimLatencyFrames;
        const int passCount = request.tailPolicy == RenderTailPolicy::Wrap ? 2 : 1;
        int64_t processedSongFrames = 0;
        for (int pass = 0; pass < passCount; ++pass) {
          const bool recordPass = pass == passCount - 1;
          int64_t renderFrame = 0;
          size_t midiEventIndex = static_cast<size_t>(std::lower_bound(
              midiEvents.begin(), midiEvents.end(), sourceStartFrame,
              [](const OfflineMidiEvent& event, int64_t sample) {
                  return event.sample < sample;
              }) - midiEvents.begin());
          int64_t quietFrames = 0;
          float tailEnvelope = 0.0f;
          while (renderFrame < renderEndFrame) {
            if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
                return fail("Render cancelled");
            }
            const int count = static_cast<int>(std::min<int64_t>(
                kBlockSize, renderEndFrame - renderFrame));
            const bool contentActive = renderFrame < contentFrames;
            const int contentCount = contentActive
                ? static_cast<int>(std::min<int64_t>(
                    count, contentFrames - renderFrame)) : 0;
            const int64_t sourceFrameBase = sourceStartFrame + renderFrame;
            const int writeOffset = recordPass
                ? static_cast<int>(std::clamp<int64_t>(
                    trimLatencyFrames - renderFrame, 0, count))
                : count;
            const int writeCount = recordPass ? count - writeOffset : 0;
            mixer.beginBlock(graph, count);

            for (uint32_t ti = 0; ti < project.tracks.size() && contentCount > 0; ++ti) {
                float* trackL = mixer.sourceChannel(ti, 0);
                float* trackR = mixer.sourceChannel(ti, 1);
                if (trackL == nullptr || trackR == nullptr) continue;
                for (auto& rr : regions) {
                    if (rr.region->trackId != project.tracks[ti].id) continue;
                    std::fill_n(regionL.data(), count, 0.0f);
                    std::fill_n(regionR.data(), count, 0.0f);
                    const double durationSec = regionDuration(rr);
                    const double sourceOffset = std::max(0.0, rr.region->source.offsetSeconds);
                    const double sourceAvail = std::max(0.0,
                        static_cast<double>(rr.source->totalFrames()) / rr.source->sampleRate() - sourceOffset);
                    const double speed = std::max(0.01, std::abs(rr.region->playback.speed));
                    const double loopLength = rr.region->loop.lengthSeconds > 0.0
                        ? std::min(sourceAvail, rr.region->loop.lengthSeconds) : sourceAvail;
                    const float gain = dbToGain(rr.region->gainDb);
                    for (int i = 0; i < contentCount; ++i) {
                        const double time = static_cast<double>(sourceFrameBase + i) / request.sampleRate;
                        const double into = time - rr.region->startSeconds;
                        if (into < 0.0 || into >= durationSec || sourceAvail <= 0.0) continue;
                        double sourceInto = into * speed;
                        if (rr.region->loop.enabled && loopLength > 0.0)
                            sourceInto = std::fmod(sourceInto, loopLength);
                        else if (sourceInto >= sourceAvail)
                            continue;
                        if (rr.region->playback.reverse)
                            sourceInto = std::max(0.0, sourceAvail - sourceInto - 1.0 / rr.source->sampleRate());
                        const double sourceFrame = (sourceOffset + sourceInto) * rr.source->sampleRate();
                        float g = gain;
                        if (rr.region->fade.inSeconds > 0.0 && into < rr.region->fade.inSeconds)
                            g *= shapedFade(into / rr.region->fade.inSeconds, rr.region->fade.inCurve);
                        const double remaining = durationSec - into;
                        if (rr.region->fade.outSeconds > 0.0 && remaining < rr.region->fade.outSeconds)
                            g *= shapedFade(remaining / rr.region->fade.outSeconds, rr.region->fade.outCurve);
                        regionL[static_cast<size_t>(i)] = rr.source->sample(0, sourceFrame) * g;
                        regionR[static_cast<size_t>(i)] = rr.source->sample(1, sourceFrame) * g;
                    }
                    const float* addL = regionL.data();
                    const float* addR = regionR.data();
                    if (rr.pitchReady) {
                        float* in[2] = {regionL.data(), regionR.data()};
                        float* out[2] = {pitchL.data(), pitchR.data()};
                        rr.pitch.process(in, contentCount, out, contentCount);
                        addL = pitchL.data(); addR = pitchR.data();
                    }
                    for (int i = 0; i < contentCount; ++i) {
                        trackL[i] += addL[i];
                        trackR[i] += addR[i];
                    }
                }
            }

            const uint32_t clickStrip = graph.find("audio::click");
            // Match live playback: disabled metronome means no generated
            // signal, not a muted strip. Offline rendering has no count-in.
            if (project.click.enabled && clickStrip != MixGraph::kNoStrip && contentCount > 0) {
                click.render(clickMono.data(), contentCount, sourceFrameBase);
                float* l = mixer.sourceChannel(clickStrip, 0);
                float* r = mixer.sourceChannel(clickStrip, 1);
                if (l != nullptr && r != nullptr)
                    for (int i = 0; i < contentCount; ++i)
                        l[i] = r[i] = clickMono[static_cast<size_t>(i)];
            }

            if (processorSession != nullptr) {
                OfflineProcessorTransport transport;
                transport.sample = sourceFrameBase;
                transport.sampleRate = request.sampleRate;
                transport.bpm = tempoAtBeat(
                    tempoMap, tempoMap.samplesToBeats(sourceFrameBase, request.sampleRate));
                transport.numerator = song.timeSignature.numerator;
                transport.denominator = song.timeSignature.denominator;
                transport.looping = request.tailPolicy == RenderTailPolicy::Wrap;
                transport.loopStartSample = sourceStartFrame;
                transport.loopEndSample = sourceStartFrame + contentFrames;
                processorSession->publishTransport(transport);

                const double automationBeat = tempoMap.samplesToBeats(
                    sourceFrameBase, request.sampleRate);
                const auto applyAutomationLane = [&](const AutomationLane& lane,
                                                     double laneBeat,
                                                     uint32_t strip) {
                    if (!lane.enabled || lane.muted || lane.points.empty())
                        return;
                    const float value = AutomationEvaluator::evaluatePoints(
                        lane.points, laneBeat, lane.target.defaultValue);
                    if (lane.target.domain == AutomationDomain::Plugin) {
                        processorSession->setPluginParameterById(
                            lane.target.entityId, lane.target.parameterId,
                            normalizedAutomationValue(lane, value));
                    } else if (lane.target.domain == AutomationDomain::MidiCC
                               && processorSession->stripHasInstrument(strip)) {
                        const std::string_view parameterId(lane.target.parameterId);
                        if (parameterId == "pitchBend" || parameterId == "pitch-bend") {
                            const int bend14 = static_cast<int>(std::lround(
                                normalizedAutomationValue(lane, value) * 16383.0f));
                            processorSession->queueMidiMessage(
                                strip, 0xE0, static_cast<uint8_t>(bend14 & 0x7f),
                                static_cast<uint8_t>((bend14 >> 7) & 0x7f), 2, 0);
                        } else {
                            int controller = -1;
                            if (parseAutomationIndex(parameterId, "cc:", controller)
                                || parseAutomationIndex(parameterId, "cc", controller)
                                || parseAutomationIndex(parameterId, "", controller)) {
                                controller = std::clamp(controller, 0, 127);
                                const int ccValue = static_cast<int>(std::lround(
                                    normalizedAutomationValue(lane, value) * 127.0f));
                                processorSession->queueMidiMessage(
                                    strip, 0xB0, static_cast<uint8_t>(controller),
                                    static_cast<uint8_t>(std::clamp(ccValue, 0, 127)), 2, 0);
                            }
                        }
                    }
                };

                for (const auto& lane : song.automationLanes) {
                    if (lane.target.domain == AutomationDomain::Plugin) {
                        applyAutomationLane(lane, automationBeat, MixGraph::kNoStrip);
                    } else if (lane.target.domain == AutomationDomain::MidiCC) {
                        for (const auto& track : project.tracks) {
                            if (track.id != lane.target.entityId)
                                continue;
                            const uint32_t strip = graph.find(track.effectiveStripId());
                            if (strip != MixGraph::kNoStrip)
                                applyAutomationLane(lane, automationBeat, strip);
                            break;
                        }
                    }
                }
                const double automationSeconds =
                    static_cast<double>(sourceFrameBase) / request.sampleRate;
                for (const auto& regionReader : regions) {
                    const Region& region = *regionReader.region;
                    if (region.automationLanes.empty()
                        || automationSeconds < region.startSeconds
                        || (region.durationSeconds > 0.0
                            && automationSeconds >= region.startSeconds + region.durationSeconds))
                        continue;
                    const int64_t regionStartSample = static_cast<int64_t>(
                        std::llround(region.startSeconds * request.sampleRate));
                    const double regionStartBeat = tempoMap.samplesToBeats(
                        regionStartSample, request.sampleRate);
                    const double regionBeat = automationBeat - regionStartBeat;
                    for (const auto& lane : region.automationLanes)
                        if (lane.target.domain == AutomationDomain::Plugin)
                            applyAutomationLane(lane, regionBeat, MixGraph::kNoStrip);
                }
                for (const auto& region : song.midiRegions) {
                    if (region.muted || automationBeat < region.startBeats
                        || automationBeat >= region.startBeats + region.durationBeats)
                        continue;
                    const auto track = std::find_if(project.tracks.begin(), project.tracks.end(),
                        [&region](const TrackDef& candidate) {
                            return candidate.id == region.trackId;
                        });
                    if (track == project.tracks.end())
                        continue;
                    const uint32_t strip = graph.find(track->effectiveStripId());
                    if (strip == MixGraph::kNoStrip)
                        continue;
                    const double regionBeat = midiRegionSourceBeat(
                        automationBeat - region.startBeats,
                        region.clipOffsetBeats, region.loopStartBeats,
                        region.loopLengthBeats, region.loop);
                    for (const auto& lane : region.automationLanes)
                        applyAutomationLane(lane, regionBeat, strip);
                }

                while (midiEventIndex < midiEvents.size()
                       && midiEvents[midiEventIndex].sample < sourceFrameBase + count) {
                    const auto& event = midiEvents[midiEventIndex++];
                    if (event.sample < sourceFrameBase
                        || event.sample > renderContentEndFrame
                        || (event.noteOn && event.sample == renderContentEndFrame))
                        continue;
                    if (event.raw) {
                        processorSession->queueMidiMessage(
                            event.strip, event.status, event.data1, event.data2,
                            event.dataLength, static_cast<int>(event.sample - sourceFrameBase));
                    } else {
                        processorSession->queueMidiNote(
                            event.strip, event.channel, event.pitch, event.velocity,
                            event.releaseVelocity, event.noteOn,
                            static_cast<int>(event.sample - sourceFrameBase));
                    }
                }
            }
            mixer.process(graph, count, processors);
            float blockPeak = 0.0f;
            for (size_t outputIndex = 0; outputIndex < selectedStrips.size(); ++outputIndex) {
                const uint32_t strip = selectedStrips[outputIndex];
                const float* left = mixer.postChannel(strip, 0);
                const float* right = mixer.postChannel(strip, 1);
                if (left == nullptr || right == nullptr)
                    return fail("Render target produced no channels");
                if (!graph.strips[strip].audible) {
                    std::fill_n(regionL.data(), count, 0.0f);
                    left = right = regionL.data();
                }
                if (tapDelays[outputIndex] != nullptr) {
                    tapDelays[outputIndex]->process(
                        left, right, regionL.data(), regionR.data(), count);
                    left = regionL.data();
                    right = regionR.data();
                }
                for (int i = writeOffset; i < count; ++i)
                    blockPeak = std::max(blockPeak,
                        std::max(std::abs(left[i]), std::abs(right[i])));
                if (writeCount > 0
                    && !writers[outputIndex]->write(
                        left + writeOffset, right + writeOffset, writeCount))
                    return fail("Failed while writing output WAV");
            }
            if (recordPass)
                result.framesWritten += writeCount;
            processedWorkFrames += count;
            processedSongFrames += count;
            renderFrame += count;
            const int64_t writtenFrame = std::clamp<int64_t>(
                renderFrame - trimLatencyFrames, 0, outputEndFrame);

            if (writtenFrame >= contentFrames + fixedTailFrames
                && request.tailPolicy == RenderTailPolicy::Leave) {
                const float release = static_cast<float>(std::exp(
                    -static_cast<double>(std::max(1, writeCount))
                    / (request.sampleRate * 0.1)));
                tailEnvelope = std::max(blockPeak, release * tailEnvelope);
                quietFrames = tailEnvelope < tailThreshold
                    ? quietFrames + writeCount : 0;
                if (writtenFrame >= contentFrames + fixedTailFrames
                                       + declaredTailFrames
                    && quietFrames >= quietFramesNeeded)
                    break;
            }
            if (onProgress) {
                const double passWork = static_cast<double>(
                    pass * renderEndFrame + renderFrame);
                const double songDone = passWork / request.sampleRate;
                const double progress = std::clamp(
                    (completedSeconds + songDone) / std::max(0.01, totalSeconds), 0.0, 0.98);
                onProgress({progress, processedWorkFrames,
                            static_cast<int64_t>(std::ceil(totalSeconds * request.sampleRate)),
                            !recordPass ? "preparing"
                                        : (writtenFrame >= contentFrames
                                               ? "tail" : "rendering")});
            }
          }
        }
        completedSeconds += static_cast<double>(processedSongFrames) / request.sampleRate;
    }

    if (onProgress) onProgress({0.99, processedWorkFrames, processedWorkFrames, "finalizing"});
    std::vector<std::string> committedPaths;
    for (size_t i = 0; i < writers.size(); ++i) {
        if (!writers[i]->finish(result.error)) {
            for (const auto& path : committedPaths)
                std::filesystem::remove(offline_detail::outputFilePath(path), ec);
            return fail(result.error);
        }
        committedPaths.push_back(targets[i].outputPath);
    }
    if (onProgress) onProgress({1.0, processedWorkFrames, processedWorkFrames, "finalizing"});
    result.ok = true;
    return result;
}

} // namespace resostage
