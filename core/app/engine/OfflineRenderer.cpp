#include "OfflineRenderer.h"

#include "audio/ClickGenerator.h"
#include "audio/MixGraph.h"
#include "audio/MixRenderer.h"
#include "audio/WavStreamDecoder.h"
#include "project/ProjectLoader.h"
#include "signalsmith-stretch/signalsmith-stretch.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <memory>
#include <random>
#include <unordered_map>
#include <vector>

namespace resostage {
namespace {

constexpr int kBlockSize = 1024;
constexpr int64_t kSourceCacheFrames = 8192;

float dbToGain(double db) {
    return static_cast<float>(std::pow(10.0, db / 20.0));
}

float shapedFade(double t, double curve) {
    const double x = std::clamp(t, 0.0, 1.0);
    return static_cast<float>(std::pow(x, std::pow(2.0, -std::clamp(curve, -1.0, 1.0) * 2.0)));
}

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
    WavStreamDecoder decoder;
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

class WavWriter {
public:
    ~WavWriter() { close(); }

    bool open(const std::string& path, int sampleRate, int bitDepth, std::string& error) {
        sampleRate_ = sampleRate;
        bitDepth_ = bitDepth;
        file = std::fopen(path.c_str(), "wb");
        if (file == nullptr) {
            error = "Cannot create output file: " + path;
            return false;
        }
        uint8_t empty[44]{};
        if (std::fwrite(empty, 1, sizeof(empty), file) != sizeof(empty)) {
            error = "Cannot write WAV header: " + path;
            close();
            return false;
        }
        return true;
    }

    bool write(const float* left, const float* right, int frames) {
        if (file == nullptr || frames <= 0) return false;
        const int bytes = bitDepth_ / 8;
        scratch.resize(static_cast<size_t>(frames * 2 * bytes));
        uint8_t* p = scratch.data();
        for (int i = 0; i < frames; ++i) {
            const float values[2] = {left[i], right[i]};
            for (float value : values) {
                const float v = std::clamp(value, -1.0f, 1.0f);
                if (bitDepth_ == 16) {
                    const int16_t s = static_cast<int16_t>(std::lrint(v * 32767.0f));
                    std::memcpy(p, &s, 2); p += 2;
                } else if (bitDepth_ == 24) {
                    const int32_t s = static_cast<int32_t>(std::lrint(v * 8388607.0f));
                    *p++ = static_cast<uint8_t>(s);
                    *p++ = static_cast<uint8_t>(s >> 8);
                    *p++ = static_cast<uint8_t>(s >> 16);
                } else {
                    std::memcpy(p, &v, 4); p += 4;
                }
            }
        }
        const size_t n = static_cast<size_t>(p - scratch.data());
        // Classic RIFF stores sizes as uint32. Refuse to silently wrap and
        // produce a corrupt file; RF64 can be added as an explicit format.
        if (dataBytes + n > static_cast<uint64_t>(UINT32_MAX) - 36u) return false;
        dataBytes += n;
        return std::fwrite(scratch.data(), 1, n, file) == n;
    }

    bool close() {
        if (file == nullptr) return true;
        const uint16_t format = bitDepth_ == 32 ? 3 : 1;
        const uint16_t channels = 2;
        const uint32_t byteRate = static_cast<uint32_t>(sampleRate_ * channels * (bitDepth_ / 8));
        const uint16_t blockAlign = static_cast<uint16_t>(channels * (bitDepth_ / 8));
        const uint32_t riffSize = static_cast<uint32_t>(36 + dataBytes);
        const uint32_t dataSize = static_cast<uint32_t>(dataBytes);
        std::fseek(file, 0, SEEK_SET);
        std::fwrite("RIFF", 1, 4, file); std::fwrite(&riffSize, 4, 1, file);
        std::fwrite("WAVEfmt ", 1, 8, file);
        const uint32_t fmtSize = 16;
        std::fwrite(&fmtSize, 4, 1, file); std::fwrite(&format, 2, 1, file);
        std::fwrite(&channels, 2, 1, file);
        const uint32_t rate = static_cast<uint32_t>(sampleRate_);
        std::fwrite(&rate, 4, 1, file); std::fwrite(&byteRate, 4, 1, file);
        std::fwrite(&blockAlign, 2, 1, file);
        const uint16_t bits = static_cast<uint16_t>(bitDepth_);
        std::fwrite(&bits, 2, 1, file); std::fwrite("data", 1, 4, file);
        std::fwrite(&dataSize, 4, 1, file);
        const bool ok = std::fflush(file) == 0 && std::ferror(file) == 0;
        std::fclose(file);
        file = nullptr;
        return ok;
    }

private:
    FILE* file = nullptr;
    int sampleRate_ = 48000;
    int bitDepth_ = 24;
    uint64_t dataBytes = 0;
    std::vector<uint8_t> scratch;
};

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
    return end;
}

uint32_t targetStrip(const MixGraph& graph, const OfflineRenderRequest& request) {
    switch (request.targetKind) {
        case RenderTargetKind::Master: return graph.find("audio::main");
        case RenderTargetKind::Click: return graph.find("audio::click");
        case RenderTargetKind::Bus:
        case RenderTargetKind::Track: return graph.find(request.targetId);
    }
    return MixGraph::kNoStrip;
}

} // namespace

OfflineRenderResult OfflineRenderer::render(const Project& project,
                                             const std::string& projectPath,
                                             const OfflineRenderRequest& request,
                                             const Progress& onProgress,
                                             const std::atomic<bool>* cancel) const {
    OfflineRenderResult result;
    result.outputPath = request.outputPath;
    if (request.outputPath.empty()) { result.error = "Output path is empty"; return result; }
    if (request.sampleRate < 8000 || request.sampleRate > 384000) {
        result.error = "Sample rate must be between 8 kHz and 384 kHz"; return result;
    }
    if (request.bitDepth != 16 && request.bitDepth != 24 && request.bitDepth != 32) {
        result.error = "Bit depth must be 16, 24, or 32"; return result;
    }
    if (project.songs.empty()) { result.error = "Project has no songs"; return result; }

    ProjectLoader loader;
    if (!projectPath.empty()) {
        std::string openError;
        if (!loader.open(projectPath, openError)) { result.error = openError; return result; }
    }
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(request.outputPath).parent_path(), ec);
    WavWriter writer;
    if (!writer.open(request.outputPath, request.sampleRate, request.bitDepth, result.error)) {
        std::filesystem::remove(request.outputPath, ec);
        return result;
    }

    std::vector<int> songIndices;
    if (request.songIndex >= 0) {
        if (request.songIndex >= static_cast<int>(project.songs.size())) {
            result.error = "Song index is out of range"; return result;
        }
        songIndices.push_back(request.songIndex);
    } else {
        for (int i = 0; i < static_cast<int>(project.songs.size()); ++i) songIndices.push_back(i);
    }

    // Progress is duration-weighted. Source-open failures are hard failures:
    // a render that quietly omits a stem is more dangerous than no render.
    double totalSeconds = 0.0;
    std::vector<double> estimatedDurations;
    for (int si : songIndices) {
        const auto& song = project.songs[static_cast<size_t>(si)];
        double d = song.endSeconds;
        if (d <= 0.0) {
            for (const auto& region : song.regions)
                d = std::max(d, region.startSeconds + std::max(0.0, region.durationSeconds));
        }
        d = std::max(0.01, d + std::max(0.0, request.tailSeconds));
        estimatedDurations.push_back(d);
        totalSeconds += d;
    }

    double completedSeconds = 0.0;
    for (size_t selection = 0; selection < songIndices.size(); ++selection) {
        if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
            result.error = "Render cancelled"; writer.close(); std::filesystem::remove(request.outputPath, ec); return result;
        }
        const SongDef& song = project.songs[static_cast<size_t>(songIndices[selection])];
        std::vector<RegionReader> regions;
        regions.reserve(song.regions.size());
        for (const Region& region : song.regions) {
            // A direct source render cannot be affected by other source
            // strips. Avoid opening/decoding gigabytes of unrelated stems;
            // bus/main renders still walk every input because sends and
            // pre-fader routes can make any of them audible there.
            if (request.targetKind == RenderTargetKind::Click)
                continue;
            if (request.targetKind == RenderTargetKind::Track
                && region.trackId != request.targetId)
                continue;
            RegionReader rr;
            rr.region = &region;
            rr.source = std::make_unique<WavSource>();
            if (!rr.source->open(loader, region.source.file, result.error)) {
                writer.close(); std::filesystem::remove(request.outputPath, ec); return result;
            }
            rr.preparePitch(request.sampleRate);
            regions.push_back(std::move(rr));
        }

        const double duration = songDuration(song, regions) + std::max(0.0, request.tailSeconds);
        const int64_t totalFrames = std::max<int64_t>(1, static_cast<int64_t>(std::ceil(duration * request.sampleRate)));
        OutputLaneConfig outputs;
        outputs.totalChannels = 2;
        const MixGraph graph = buildMixGraph(project, outputs);
        const uint32_t selectedStrip = targetStrip(graph, request);
        if (selectedStrip == MixGraph::kNoStrip) {
            result.error = "Render target does not exist: " + request.targetId;
            writer.close(); std::filesystem::remove(request.outputPath, ec); return result;
        }
        MixRenderer mixer;
        mixer.prepare(request.sampleRate, kBlockSize, graph.strips.size());
        ClickGenerator click;
        click.prepare(request.sampleRate, song.bpm, song.timeSignature.numerator,
                      song.timeSignature.denominator);

        std::vector<float> regionL(kBlockSize), regionR(kBlockSize);
        std::vector<float> pitchL(kBlockSize), pitchR(kBlockSize);
        std::vector<float> clickMono(kBlockSize);
        for (int64_t frame = 0; frame < totalFrames; frame += kBlockSize) {
            if (cancel != nullptr && cancel->load(std::memory_order_relaxed)) {
                result.error = "Render cancelled"; writer.close(); std::filesystem::remove(request.outputPath, ec); return result;
            }
            const int count = static_cast<int>(std::min<int64_t>(kBlockSize, totalFrames - frame));
            mixer.beginBlock(graph, count);

            for (uint32_t ti = 0; ti < project.tracks.size(); ++ti) {
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
                    for (int i = 0; i < count; ++i) {
                        const double time = static_cast<double>(frame + i) / request.sampleRate;
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
                        rr.pitch.process(in, count, out, count);
                        addL = pitchL.data(); addR = pitchR.data();
                    }
                    for (int i = 0; i < count; ++i) {
                        trackL[i] += addL[i];
                        trackR[i] += addR[i];
                    }
                }
            }

            const uint32_t clickStrip = graph.find("audio::click");
            if (clickStrip != MixGraph::kNoStrip) {
                click.render(clickMono.data(), count, frame);
                float* l = mixer.sourceChannel(clickStrip, 0);
                float* r = mixer.sourceChannel(clickStrip, 1);
                if (l != nullptr && r != nullptr)
                    for (int i = 0; i < count; ++i) l[i] = r[i] = clickMono[static_cast<size_t>(i)];
            }

            mixer.process(graph, count);
            const float* left = mixer.postChannel(selectedStrip, 0);
            const float* right = mixer.postChannel(selectedStrip, 1);
            if (left == nullptr || right == nullptr) {
                result.error = "Render target produced no channels"; writer.close(); std::filesystem::remove(request.outputPath, ec); return result;
            }
            if (!graph.strips[selectedStrip].audible) {
                std::fill_n(regionL.data(), count, 0.0f);
                left = right = regionL.data();
            }
            if (!writer.write(left, right, count)) {
                result.error = "Failed while writing output WAV"; writer.close(); std::filesystem::remove(request.outputPath, ec); return result;
            }
            result.framesWritten += count;
            if (onProgress) {
                const double songDone = static_cast<double>(frame + count) / request.sampleRate;
                onProgress(std::clamp((completedSeconds + songDone) / std::max(0.01, totalSeconds), 0.0, 1.0));
            }
        }
        completedSeconds += duration;
    }

    if (!writer.close()) { result.error = "Failed to finalize output WAV"; return result; }
    if (onProgress) onProgress(1.0);
    result.ok = true;
    return result;
}

} // namespace resostage
