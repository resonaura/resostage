// Routing snapshot + live mix controls for AudioEngine (message thread).
// Bus/track gain/pan/mute/solo/sends, click strip, scratch buffers.
// Kept in its own translation unit so AudioEngine.cpp doesn't balloon.
//
// Flat bus-index convention used throughout this file's public setters/
// getters (setBusGainDb, busStartChannelAt, ...): 0 = Master, 1..
// proj.sends.size() = Sends (in project order), beyond that = fabricated
// Direct Output lanes (never persisted, not authorable strips). That rail is
// derived from the published MixGraph in buildBusRows() below --
// this file no longer decides ANY routing itself, it only edits the Project
// and republishes.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"
#include "project/ProjectJson.h"
#include "project/RouteId.h"

#include <algorithm>
#include <string>
#include <vector>


namespace resostage {

using audio_engine_detail::dbToGain;

void AudioEngine::ensureTrackMeters(size_t count) {
    trackMeters.resize(count);
    for (size_t i = 0; i < count; ++i) {
        if (trackMeters[i] == nullptr)
            trackMeters[i] = std::make_unique<SeqLock<MeterFrame>>();
    }
    trackBandMeters.resize(count);
    for (auto& band : trackBandMeters)
        band.prepare(currentSampleRate, 2);

    // Reallocate interval-peak arrays only when the count changes (same
    // policy as installBusRows so a fader drag doesn't churn them).
    if (count != trackPeakIntervalCount) {
        trackPeakIntervalCount = count;
        trackPeakIntervalMaxL = std::make_unique<std::atomic<float>[]>(count);
        trackPeakIntervalMaxR = std::make_unique<std::atomic<float>[]>(count);
        trackLastBlockPeakL   = std::make_unique<std::atomic<float>[]>(count);
        trackLastBlockPeakR   = std::make_unique<std::atomic<float>[]>(count);
        for (size_t i = 0; i < count; ++i) {
            trackPeakIntervalMaxL[i].store(0.0f, std::memory_order_relaxed);
            trackPeakIntervalMaxR[i].store(0.0f, std::memory_order_relaxed);
            trackLastBlockPeakL[i].store(0.0f, std::memory_order_relaxed);
            trackLastBlockPeakR[i].store(0.0f, std::memory_order_relaxed);
        }
    }
}

// Derives the mixer's flat bus rail from a freshly-built graph. Pure: touches
// no member the audio thread reads, so it deliberately runs OUTSIDE
// routingMutex -- see publishRoutingSnapshot() for why every microsecond under
// that lock is a chance of an audible click. The rail is a VIEW of the graph --
// Main, then the Sends in project order, then every output lane -- so a row can
// never describe a channel the mix does not have.
std::vector<LoadedBus> AudioEngine::buildBusRows(const MixGraph& graph) const {
    std::vector<LoadedBus> rows;
    const Project& proj = loader.project();
    rows.reserve(1 + proj.sends.size() + (graph.strips.size() - graph.firstLaneStrip));

    // The physical channel a bus row reports: the first (lowest) lane its
    // output feeds. Resolved in ONE pass over the edges rather than a full
    // edge scan per row -- that was O(rows x edges) with an id string parsed
    // at every step, and on a 32-out rig it ran on every frame of every fader
    // drag while the audio thread waited behind it.
    std::unordered_map<uint32_t, int> firstLaneChannel;
    for (const MixEdge& edge : graph.edges) {
        if (edge.to >= graph.strips.size())
            continue;
        const MixStrip& dest = graph.strips[edge.to];
        if (dest.kind != StripKind::OutputLane)
            continue;
        const int channel = outputLaneChannel(dest.id);
        if (channel < 0)
            continue;
        const auto [it, inserted] = firstLaneChannel.try_emplace(edge.from, channel);
        if (!inserted)
            it->second = std::min(it->second, channel);
    }
    const auto firstLaneChannelOf = [&firstLaneChannel](uint32_t strip) -> int {
        if (strip == MixGraph::kNoStrip)
            return 0;
        const auto it = firstLaneChannel.find(strip);
        return it == firstLaneChannel.end() ? 0 : it->second;
    };

    const auto addRow = [&](const std::string& id, const std::string& name, int channels,
                            bool isDirectOut, bool available, int startChannel) {
        LoadedBus row;
        row.id = id;
        row.name = name;
        row.channelCount = channels;
        row.isDirectOut = isDirectOut;
        row.available = available;
        row.startChannel = startChannel;
        row.stripIndex = graph.find(id);
        rows.push_back(std::move(row));
    };

    {
        const uint32_t mainStrip = graph.find("audio::main");
        addRow("audio::main", proj.main.name.empty() ? "Main" : proj.main.name,
               proj.main.channels, /*isDirectOut=*/false, /*available=*/true,
               firstLaneChannelOf(mainStrip));
    }

    for (const SendBus& send : proj.sends) {
        const uint32_t strip = graph.find(send.id);
        // A send folded into Main leaves through Main's channels.
        const int channel = send.output.type == OutputType::Main
                                ? rows[0].startChannel
                                : firstLaneChannelOf(strip);
        addRow(send.id, send.name.empty() ? send.id : send.name, send.channels,
               /*isDirectOut=*/false, /*available=*/true, channel);
    }

    for (uint32_t s = graph.firstLaneStrip; s < graph.strips.size(); ++s) {
        const MixStrip& lane = graph.strips[s];
        if (lane.kind != StripKind::OutputLane)
            continue;
        const int channel = outputLaneChannel(lane.id);
        addRow(lane.id, lane.name, 1, /*isDirectOut=*/true,
               /*available=*/lane.physicalChannel >= 0, channel < 0 ? 0 : channel);
    }

    return rows;
}

// Swaps a prebuilt rail in. Caller must hold routingMutex: `busses` and the
// meter pools are read by the render callback.
void AudioEngine::installBusRows(std::vector<LoadedBus> rows) {
    const size_t previousCount = busses.size();

    busses = std::move(rows);
    busIndexById.clear();
    for (size_t i = 0; i < busses.size(); ++i)
        busIndexById[busses[i].id] = i;

    // Meter pools are only reallocated when the row count genuinely changed --
    // a knob move republishes the graph on every drag and must not churn them.
    if (busses.size() == previousCount)
        return;

    busMeters.clear();
    busLoudnessMeters.clear();
    busMeters.resize(busses.size());
    busLoudnessMeters.resize(busses.size());
    for (size_t i = 0; i < busses.size(); ++i) {
        busMeters[i] = std::make_unique<SeqLock<MeterFrame>>();
        busLoudnessMeters[i].prepare(currentSampleRate, 2);
    }

    busMuted.assign(busses.size(), false);

    busPeakIntervalCount = busses.size();
    busLastBlockPeakL = std::make_unique<std::atomic<float>[]>(busPeakIntervalCount);
    busLastBlockPeakR = std::make_unique<std::atomic<float>[]>(busPeakIntervalCount);
    busPeakIntervalMaxL = std::make_unique<std::atomic<float>[]>(busPeakIntervalCount);
    busPeakIntervalMaxR = std::make_unique<std::atomic<float>[]>(busPeakIntervalCount);
    for (size_t i = 0; i < busPeakIntervalCount; ++i) {
        busPeakIntervalMaxL[i].store(0.0f, std::memory_order_relaxed);
        busPeakIntervalMaxR[i].store(0.0f, std::memory_order_relaxed);
    }

    // Sub-block peaks per bus. Rings are heap-held one apiece because an
    // atomic is neither copyable nor movable, so the vector cannot grow with
    // them inline. No per-bus state beyond the ring: the measurement carries
    // nothing between blocks.
    busEnvelopeRings.clear();
    busEnvelopeRings.reserve(busses.size());
    busLastPeak.assign(busses.size(), MeterEnvelopePoint{});
    for (size_t i = 0; i < busses.size(); ++i)
        busEnvelopeRings.push_back(std::make_unique<MeterEnvelopeRing<kMeterRingPoints>>());
}

void AudioEngine::publishRoutingSnapshot() {
    if (!projectLoaded)
        return;

    markDirty();

    // ── Everything below, up to the lock, runs UNLOCKED on purpose ──────────
    //
    // The render callback try_locks routingMutex and, when it misses, returns
    // having written nothing -- a whole block of silence into a playing show.
    // It cannot do better: a render callback must never wait on a
    // non-real-time thread. So the only lever is how long this function holds
    // that lock, and it used to hold it across two JUCE device queries (both
    // allocate), a full graph rebuild (strings, hash maps, an edge sort) and
    // the bus-rail derivation. Every fader drag fires this once per frame, and
    // ~6% of those frames landed on top of a callback and silenced it -- which
    // is exactly the crackle reported while turning sends, pan and gain, and
    // (through builderCycleUpdate -> notifyProjectStructureChanged) while
    // dragging loop locators.
    //
    // None of this touches state the audio thread reads. buildMixGraph only
    // READS the project, and the audio thread only reads it too, so the two
    // are not in conflict.
    //
    // The whole routing decision -- solo groups, audibility, ext-out lane
    // placement, send levels, shadow lanes -- lives in buildMixGraph(). This
    // function only feeds it the device channel map, derives the UI's bus
    // rail from the result and publishes. Every setter just edits the Project
    // and calls back in here, so there is exactly one path from "a value
    // changed" to "the audio thread hears it" -- and no way for the master to
    // be left out of it, which is what the old hand-rolled per-strip snapshot
    // code kept managing to do.
    OutputLaneConfig outputs;
    const auto setup = deviceManagerInstance.getAudioDeviceSetup();
    int total = 0;
    for (int i = 0; i < 512; ++i)
        if (setup.outputChannels[i])
            total = i + 1;
    if (auto* device = deviceManagerInstance.getCurrentAudioDevice())
        total = std::max(total, device->getOutputChannelNames().size());
    outputs.totalChannels = total > 0 ? total : 2;
    if (!setup.useDefaultOutputChannels) {
        outputs.active.resize(static_cast<size_t>(outputs.totalChannels));
        for (int i = 0; i < outputs.totalChannels; ++i)
            outputs.active[static_cast<size_t>(i)] = setup.outputChannels[i];
    }

    auto graph = std::make_shared<const MixGraph>(buildMixGraph(loader.project(), outputs));
    const uint32_t clickStrip = graph->find("audio::click");
    std::vector<LoadedBus> rows = buildBusRows(*graph);
    const size_t needed = graph->strips.size() + 16;

    // ── Critical section: swap the prebuilt state in ────────────────────────
    {
        std::lock_guard<std::recursive_mutex> lock(routingMutex);
        clickStripIndex = clickStrip;
        installBusRows(std::move(rows));
        // Sizing the renderer reallocates buffers the callback reads, so it
        // must happen here -- but only ever grows, i.e. never on a knob move.
        if (mixRenderer.capacity() < needed)
            mixRenderer.prepare(currentSampleRate, std::max(currentBlockSize, 1), needed);
        publishedGraph = graph;
    }

    // Atomic shared_ptr swap -- its own synchronisation, no lock needed, and
    // deliberately outside so the callback picks the new graph up even if it
    // is mid-block.
    routing.publish(std::move(graph));
}

void AudioEngine::republishRouting() {
    publishRoutingSnapshot();
}

void AudioEngine::rebuildBussesFromProject() {
    publishRoutingSnapshot();
    // Every builder edit lands here, including adding or removing a timeline
    // event -- and the fired-flag vector has to follow the event list or the
    // new trigger is outside the loop bound that fires them. See
    // syncEventFiredFlags().
    syncEventFiredFlags();
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
    t->channels = mono ? 1 : 2;
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
    // `busId` is the flat route id the SPA speaks -- see engine/project/
    // RouteId.h for the whole vocabulary and the single place it is decoded.
    applyRouteId(t->output, busId, loader.project());
    publishRoutingSnapshot();
}

void AudioEngine::setTrackSend(size_t songIndex, size_t trackIndex, size_t sendIndex, const SendConfig& send) {
    (void)songIndex;
    TrackDef* t = trackDefAt(trackIndex);
    if (t == nullptr || sendIndex >= t->output.sends.size())
        return;
    if (busIndexById.find(send.bus) == busIndexById.end())
        return;
    t->output.sends[sendIndex] = send;
    publishRoutingSnapshot();
}

void AudioEngine::addTrackSend(size_t songIndex, size_t trackIndex, const SendConfig& send) {
    (void)songIndex;
    TrackDef* t = trackDefAt(trackIndex);
    if (t == nullptr)
        return;
    if (busIndexById.find(send.bus) == busIndexById.end())
        return;
    t->output.sends.push_back(send);
    publishRoutingSnapshot();
}

void AudioEngine::removeTrackSend(size_t songIndex, size_t trackIndex, size_t sendIndex) {
    (void)songIndex;
    TrackDef* t = trackDefAt(trackIndex);
    if (t == nullptr || sendIndex >= t->output.sends.size())
        return;
    t->output.sends.erase(t->output.sends.begin() + static_cast<std::ptrdiff_t>(sendIndex));
    publishRoutingSnapshot();
}

void AudioEngine::setBusGainDb(size_t busIndex, double gainDb) {
    Project& proj = loader.project();
    if (busIndex == 0) {
        proj.main.gainDb = gainDb;
    } else {
        const size_t si = busIndex - 1;
        if (si >= proj.sends.size())
            return;
        proj.sends[si].gainDb = gainDb;
    }
    publishRoutingSnapshot();
}

void AudioEngine::setBusPan(size_t busIndex, double pan) {
    Project& proj = loader.project();
    const double clamped = std::clamp(pan, -1.0, 1.0);
    if (busIndex == 0) {
        proj.main.pan = clamped;
    } else {
        const size_t si = busIndex - 1;
        if (si >= proj.sends.size())
            return;
        proj.sends[si].pan = clamped;
    }
    publishRoutingSnapshot();
}

void AudioEngine::setBusMute(size_t busIndex, bool mute) {
    Project& proj = loader.project();
    if (busIndex == 0) {
        proj.main.mute = mute;
    } else {
        const size_t si = busIndex - 1;
        if (si >= proj.sends.size())
            return;
        proj.sends[si].mute = mute;
    }
    if (busIndex < busMuted.size())
        busMuted[busIndex] = mute;
    publishRoutingSnapshot();
}

void AudioEngine::setBusSolo(size_t busIndex, bool solo) {
    Project& proj = loader.project();
    if (busIndex == 0) {
        // Master's solo group has only itself -- stored for UI fidelity, but
        // publishRoutingSnapshot() never lets it silence anything.
        proj.main.solo = solo;
    } else {
        const size_t si = busIndex - 1;
        if (si >= proj.sends.size())
            return;
        proj.sends[si].solo = solo;
    }
    publishRoutingSnapshot();
}

void AudioEngine::setBusChannels(size_t busIndex, int channels) {
    Project& proj = loader.project();
    const int c = (channels >= 2) ? 2 : 1;
    if (busIndex == 0) {
        proj.main.channels = c;
    } else {
        const size_t si = busIndex - 1;
        if (si >= proj.sends.size())
            return;
        proj.sends[si].channels = c;
    }
    rebuildBussesFromProject();
}

void AudioEngine::setClickSolo(bool solo) {
    loader.project().click.solo = solo;
    publishRoutingSnapshot();
}

void AudioEngine::refreshClickState() {
    if (!projectLoaded)
        return;

    // Gain, pan, mono, mute, routing and metering for the metronome all live
    // on its strip in the MixGraph now, exactly like a track's -- so the only
    // thing left that is genuinely click-specific is its tempo grid.
    const Project& proj = loader.project();

    double bpm = 120.0;
    int tsNum = 4;
    int tsDen = 4;
    if (currentSong < proj.songs.size()) {
        const SongDef& song = proj.songs[currentSong];
        bpm = song.bpm;
        tsNum = song.timeSignature.numerator;
        tsDen = song.timeSignature.denominator;
    }

    // Full tempo + meter grid (numerator = strong/weak period, denominator =
    // beat unit). Playhead-locked render keeps bar 1 = accented downbeat.
    //
    // Only the generator itself needs the render callback locked out, and the
    // republish below deliberately runs UNLOCKED (see publishRoutingSnapshot).
    // routingMutex is recursive, so holding it across that call would quietly
    // put the whole graph rebuild back under the lock the callback try_locks
    // -- undoing the fix for every path that edits a song's tempo or meter
    // while the transport is live.
    double prevBpm = 0.0;
    int prevBpb = 0;
    int prevUnit = 0;
    {
        std::lock_guard<std::recursive_mutex> lock(routingMutex);
        prevBpm = clickGenerator.currentBpm();
        prevBpb = clickGenerator.currentBeatsPerBar();
        prevUnit = clickGenerator.currentBeatUnit();
        if (currentSampleRate > 0.0)
            clickGenerator.prepare(currentSampleRate, bpm, tsNum, tsDen);
    }

    publishRoutingSnapshot();

    // Live song update of bpm/meter while playing: keep MIDI clock + SPP in
    // step with the new click grid. Skip pure gain/pan/routing edits.
    const bool tempoOrMeterChanged =
        std::abs(prevBpm - bpm) > 1.0e-9 || prevBpb != tsNum || prevUnit != tsDen;
    if (tempoOrMeterChanged && playing.load(std::memory_order_relaxed))
        syncMidiTransportToCurrentSong(/*sendContinue=*/false);
}

void AudioEngine::syncMidiTransportToCurrentSong(bool sendContinue) {
    if (!projectLoaded || currentSong == static_cast<size_t>(-1)
        || currentSong >= loader.project().songs.size())
        return;
    const SongDef& song = loader.project().songs[currentSong];
    // Tempo matches project beat BPM (same unit as the click + UI bar|beat).
    midiDispatcher.setClockBpm(song.bpm);

    // Song Position Pointer: absolute MIDI-beats (sixteenth notes) since the
    // project start. globalBeatsElapsed folds each prior song at its own bpm,
    // then the current song at the current playhead -- same cumulative beat
    // counter the UI absolute bar|beat readout uses.
    const double globalBeats = globalBeatsElapsed();
    const long long sixteenths = std::llround(globalBeats * 4.0);
    const uint16_t midiBeats16 =
        static_cast<uint16_t>(std::clamp<long long>(sixteenths, 0, 16383));
    midiDispatcher.sendSongPositionPointer(midiBeats16);

    if (sendContinue)
        midiDispatcher.continueClock(song.bpm);
}

void AudioEngine::setBusOutputChannel(size_t busIndex, int startChannel) {
    Project& proj = loader.project();
    const int sc = std::max(0, startChannel);
    if (busIndex == 0) {
        proj.main.output.type = OutputType::ExtOut;
        proj.main.output.target = extOutTarget(sc, proj.main.channels);
    } else {
        const size_t si = busIndex - 1;
        if (si >= proj.sends.size())
            return;
        proj.sends[si].output.type = OutputType::ExtOut;
        proj.sends[si].output.target = extOutTarget(sc, proj.sends[si].channels);
    }
    publishRoutingSnapshot();
}

void AudioEngine::ensureScratchSizes() {
    std::lock_guard<std::recursive_mutex> lock(routingMutex);

    // Only the buffers this file still owns: one decode scratch per track and
    // the metronome's. Everything downstream of a source -- bus sums, the
    // master, the physical lanes -- is MixRenderer's, sized in
    // publishRoutingSnapshot() against the published graph.
    // Capacity, not the current block size.
    //
    // Everything here is read from the render callback, and the callback may
    // never allocate: a heap allocation takes a global lock whose wait is
    // unbounded, which is exactly how a machine with a busy heap produces a
    // dropout while the CPU graph stays flat. Sizing to the largest block the
    // device can ever hand us means growing the buffer is something that
    // happens HERE, on the device thread during a reconfigure, and never
    // there.
    //
    // The old code sized to currentBlockSize exactly and left the callback a
    // defensive resize() for anything bigger -- a line that reads like a
    // safety net and is in fact the one allocation on the audio thread.
    const int samples = std::max(currentBlockSize, 1);
    const int capacity = std::max(samples, kMaxSupportedBlockSize);

    for (auto& scratch : trackScratch)
        scratch.setSize(2, capacity, false, false, true);
    regionMixScratch.setSize(2, capacity, false, false, true);
    pitchInScratch.setSize(2, capacity, false, false, true);
    pitchOutScratch.setSize(2, capacity, false, false, true);

    // Configure the vocoder pool here, off the audio thread: configure() and
    // the first reset() both allocate, and the callback must never do that.
    // Re-run on every device change, since the FFT sizing is derived from the
    // sample rate.
    const double rate = currentSampleRate > 0.0 ? currentSampleRate : 48000.0;
    if (pitchSlots.size() != kPitchSlots)
        pitchSlots.resize(kPitchSlots);
    for (auto& slot : pitchSlots) {
        slot.stretch.presetDefault(2, static_cast<float>(rate));
        slot.stretch.reset();
        // Reserve past a UUID's 36 characters so claiming a slot on the
        // audio thread reuses this buffer instead of allocating.
        slot.regionId.reserve(64);
        slot.regionId.clear();
        slot.nextInputSample = 0;
        slot.semitones = 0.0;
        slot.everUsed = false;
    }

    // The renderer is sized by strip COUNT in publishRoutingSnapshot, which a
    // buffer-size change does not touch -- so without this its rows stayed at
    // whatever block size the strips were last published for while the driver
    // started handing us four or eight times as many samples. Growing it here,
    // on the device thread before the first callback at the new size, is the
    // one place that can allocate safely.
    if (mixRenderer.capacity() > 0 && mixRenderer.maxBlockSize() < capacity)
        mixRenderer.prepare(currentSampleRate, capacity, mixRenderer.capacity());

    clickScratch.assign(static_cast<size_t>(capacity), 0.0f);
    // Shaped-playback scratch, sized the same way and for the same reason:
    // the audio thread must never grow it.
    shapedKernelWeights.assign(static_cast<size_t>(capacity), nullptr);
    shapedKernelBase.assign(static_cast<size_t>(capacity), 0);
    // One slot per physical channel, so the stop-declick never has to grow it
    // from the callback either. 64 covers every interface this runs on; a
    // wider one simply declicks the first 64 lanes.
    if (lastOutputSample.size() < kMaxSupportedOutputChannels)
        lastOutputSample.assign(kMaxSupportedOutputChannels, 0.0f);
}

const char* AudioEngine::busSoloGroupAt(size_t index) const {
    if (publishedGraph == nullptr || index >= busses.size())
        return "none";
    const uint32_t strip = busses[index].stripIndex;
    if (strip >= publishedGraph->strips.size())
        return "none";
    return soloGroupName(publishedGraph->strips[strip].soloGroup);
}

const char* AudioEngine::trackSoloGroup() const {
    // Tracks and the metronome always share one group -- see SoloGroup in
    // engine/audio/MixGraph.h for why.
    return soloGroupName(SoloGroup::Sources);
}

bool AudioEngine::anySoloInGroup(const char* groupName) const {
    if (publishedGraph == nullptr || groupName == nullptr)
        return false;
    for (const SoloGroup group : {SoloGroup::Sources, SoloGroup::Sends, SoloGroup::Main})
        if (std::string(soloGroupName(group)) == groupName)
            return publishedGraph->anySoloIn(group);
    return false;
}

int AudioEngine::busStartChannelAt(size_t index) const {
    return index < busses.size() ? busses[index].startChannel : 0;
}

int AudioEngine::busChannelCountAt(size_t index) const {
    return index < busses.size() ? busses[index].channelCount : 2;
}

bool AudioEngine::busIsDirectAt(size_t index) const {
    return index < busses.size() && busses[index].isDirectOut;
}

bool AudioEngine::busAvailableAt(size_t index) const {
    return index >= busses.size() || busses[index].available;
}

void AudioEngine::rebuildDirectOutBusses() {
    // Output lanes are derived by buildMixGraph() from the device's active
    // channel map, together with shadow lanes for channels the project still
    // references. So "the device changed" is just "republish".
    publishRoutingSnapshot();
}

} // namespace resostage
