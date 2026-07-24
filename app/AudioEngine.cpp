#include "AudioEngine.h"

#include <algorithm>
#include <cmath>

namespace resoset {

namespace {
float dbToGain(double db) {
    if (db <= -144.0)
        return 0.0f;
    return static_cast<float>(std::pow(10.0, db / 20.0));
}
} // namespace

AudioEngine::AudioEngine() {
    formatManager.registerBasicFormats();
    deviceManagerInstance.addAudioCallback(this);
}

AudioEngine::~AudioEngine() {
    stop();
    deviceManagerInstance.removeAudioCallback(this);
    deviceManagerInstance.closeAudioDevice();
}

const SeqLock<MeterFrame>* AudioEngine::busMeterAt(size_t index) const {
    if (index >= busMeters.size())
        return nullptr;
    return busMeters[index].get();
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
    busMeters.resize(busses.size());
    busLoudnessMeters.resize(busses.size());
    for (size_t i = 0; i < busses.size(); ++i) {
        busMeters[i] = std::make_unique<SeqLock<MeterFrame>>();
        busLoudnessMeters[i].prepare(currentSampleRate, 2);
    }

    ensureScratchSize();
}

void AudioEngine::ensureScratchSize() {
    const int channels = std::max<int>(2, static_cast<int>(busses.size()) * 2);
    const int samples = std::max(currentBlockSize, 1);
    busScratch.setSize(channels, samples, false, false, true);
}

bool AudioEngine::loadProject(const std::string& path, std::string& error) {
    stop();

    if (!loader.open(path, error))
        return false;

    buildBusListFromProject();
    currentSong = static_cast<size_t>(-1);
    return true;
}

bool AudioEngine::selectSong(size_t songIndex, std::string& error) {
    stop();

    const Project& proj = loader.project();
    if (songIndex >= proj.songs.size()) {
        error = "Song index out of range";
        return false;
    }
    const SongDef& song = proj.songs[songIndex];

    std::vector<LoadedTrack> newTracks;
    newTracks.reserve(song.tracks.size());

    for (const TrackDef& trackDef : song.tracks) {
        std::vector<uint8_t> bytes;
        if (!loader.extractFile(trackDef.file, bytes, error)) {
            error = "Track '" + trackDef.id + "': " + error;
            return false;
        }

        auto stream = std::make_unique<juce::MemoryInputStream>(bytes.data(), bytes.size(), true);
        std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(std::move(stream)));
        if (reader == nullptr) {
            error = "Track '" + trackDef.id + "': unsupported or corrupt WAV data (" + trackDef.file + ")";
            return false;
        }

        if (std::abs(reader->sampleRate - currentSampleRate) > 0.5) {
            error = "Track '" + trackDef.id + "': sample rate " + std::to_string(reader->sampleRate) +
                    " does not match device rate " + std::to_string(currentSampleRate) +
                    " (Milestone 1 does not resample)";
            return false;
        }

        LoadedTrack loaded;
        loaded.id = trackDef.id;
        loaded.lengthSamples = reader->lengthInSamples;
        loaded.samples.setSize(static_cast<int>(reader->numChannels), static_cast<int>(reader->lengthInSamples));
        reader->read(&loaded.samples, 0, static_cast<int>(reader->lengthInSamples), 0, true, true);

        newTracks.push_back(std::move(loaded));
    }

    // Build the routing snapshot for this song: each track -> its declared bus,
    // plus the (song-independent) global bus -> physical-output assignments.
    auto snapshot = std::make_unique<RoutingSnapshot>();
    snapshot->busCount = static_cast<uint32_t>(busses.size());

    for (size_t i = 0; i < song.tracks.size(); ++i) {
        const TrackDef& trackDef = song.tracks[i];
        auto busIt = busIndexById.find(trackDef.busId);
        if (busIt == busIndexById.end()) {
            error = "Track '" + trackDef.id + "' references unknown bus '" + trackDef.busId + "'";
            return false;
        }

        TrackRoute route;
        route.trackIndex = static_cast<uint32_t>(i);
        route.busIndex = static_cast<uint32_t>(busIt->second);
        route.gainLinear = dbToGain(trackDef.gainDb);
        route.pan = static_cast<float>(trackDef.pan);
        route.mute = trackDef.mute;
        snapshot->routes.push_back(route);
    }

    for (const BusDef& busDef : loader.project().busses) {
        BusOutput out;
        out.busIndex = static_cast<uint32_t>(busIndexById.at(busDef.id));
        out.startChannel = busDef.output.startChannel;
        out.channelCount = busDef.channels;
        out.gainLinear = dbToGain(busDef.gainDb);
        out.mute = false;
        snapshot->outputs.push_back(out);
    }

    tracks = std::move(newTracks);
    currentSong = songIndex;
    routing.publish(std::move(snapshot));

    return true;
}

void AudioEngine::play() {
    if (currentSong == static_cast<size_t>(-1))
        return;
    clock.start(currentSampleRate, 0);
    playing.store(true, std::memory_order_release);
}

void AudioEngine::stop() {
    playing.store(false, std::memory_order_release);
    clock.stop();
}

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice* device) {
    currentSampleRate = device->getCurrentSampleRate();
    currentBlockSize = device->getCurrentBufferSizeSamples();
    hwSamplePosition.store(0, std::memory_order_relaxed);

    for (auto& meter : busLoudnessMeters)
        meter.prepare(currentSampleRate, 2);

    ensureScratchSize();
}

void AudioEngine::audioDeviceStopped() {
    playing.store(false, std::memory_order_release);
    clock.stop();
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

    const uint64_t hostTimeNanos =
        (context.hostTimeNs != nullptr) ? *context.hostTimeNs : SystemMonotonicClock{}.nowNanos();
    const int64_t hwPos = hwSamplePosition.fetch_add(numSamples, std::memory_order_relaxed);
    clock.onAudioCallback(hostTimeNanos, hwPos);

    transportTelemetry.playheadSamples.store(clock.currentSamplePosition(), std::memory_order_relaxed);
    transportTelemetry.playheadSeconds.store(clock.currentSeconds(), std::memory_order_relaxed);
    transportTelemetry.sampleRate.store(clock.sampleRate(), std::memory_order_relaxed);
    transportTelemetry.driftFactor.store(clock.driftFactor(), std::memory_order_relaxed);
    transportTelemetry.running.store(playing.load(std::memory_order_relaxed), std::memory_order_relaxed);

    if (!playing.load(std::memory_order_acquire))
        return;

    const RoutingSnapshot* snap = routing.acquireForRender();
    if (snap == nullptr || busses.empty())
        return;

    busScratch.clear();
    const int scratchChannels = busScratch.getNumChannels();
    const int64_t playheadSample = clock.currentSamplePosition();

    // Tracks -> bus scratch buffers.
    for (const TrackRoute& route : snap->routes) {
        if (route.mute || route.trackIndex >= tracks.size() || route.busIndex >= busses.size())
            continue;

        const LoadedTrack& track = tracks[route.trackIndex];
        const int trackChannels = track.samples.getNumChannels();
        if (trackChannels == 0)
            continue;

        const int busChannels = std::min(2, busses[route.busIndex].channelCount);
        const int scratchOffset = static_cast<int>(route.busIndex) * 2;
        if (scratchOffset + busChannels > scratchChannels)
            continue;

        for (int i = 0; i < numSamples; ++i) {
            const int64_t srcSample = playheadSample + i;
            if (srcSample < 0 || srcSample >= track.lengthSamples)
                continue;
            const int s = static_cast<int>(srcSample);

            if (trackChannels >= 2 && busChannels >= 2) {
                busScratch.addSample(scratchOffset + 0, i, track.samples.getSample(0, s) * route.gainLinear);
                busScratch.addSample(scratchOffset + 1, i, track.samples.getSample(1, s) * route.gainLinear);
            } else {
                const float mono = track.samples.getSample(0, s);
                if (busChannels >= 2) {
                    const float gL = route.gainLinear * (1.0f - std::max(0.0f, route.pan));
                    const float gR = route.gainLinear * (1.0f + std::min(0.0f, route.pan));
                    busScratch.addSample(scratchOffset + 0, i, mono * gL);
                    busScratch.addSample(scratchOffset + 1, i, mono * gR);
                } else {
                    busScratch.addSample(scratchOffset + 0, i, mono * route.gainLinear);
                }
            }
        }
    }

    // Bus scratch buffers -> metering + physical outputs.
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
}

} // namespace resoset
