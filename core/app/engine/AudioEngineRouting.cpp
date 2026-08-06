// Routing snapshot + live mix controls for AudioEngine (message thread).
// Bus/track gain/pan/mute/solo/sends, click strip, scratch buffers.
// Kept in its own translation unit so AudioEngine.cpp doesn't balloon.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"

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

    // Append the global Direct Output busses (not persisted -- see
    // rebuildDirectOutBusses()) so tracks/metronome can route into them via
    // busIndexById like any project bus.
    for (const DirectOutBus& dob : directOutBusses) {
        LoadedBus lb;
        lb.id = dob.id;
        lb.channelCount = dob.channels;
        busIndexById[dob.id] = busses.size();
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

    // Interval peak slots (click-on-bus capture for the UI poller).
    busPeakIntervalCount = busses.size();
    busPeakIntervalMaxL = std::make_unique<std::atomic<float>[]>(busPeakIntervalCount);
    busPeakIntervalMaxR = std::make_unique<std::atomic<float>[]>(busPeakIntervalCount);
    busPeakDeliveryL.assign(busPeakIntervalCount, 0.0f);
    busPeakDeliveryR.assign(busPeakIntervalCount, 0.0f);
    for (size_t i = 0; i < busPeakIntervalCount; ++i) {
        busPeakIntervalMaxL[i].store(0.0f, std::memory_order_relaxed);
        busPeakIntervalMaxR[i].store(0.0f, std::memory_order_relaxed);
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

        // Main (FOH) route. A compound id ("direct:1,direct:2") fans the track out
        // to BOTH mono Direct Output lanes.
        std::vector<size_t> mainTargets;
        audio_engine_detail::collectRouteBusIndices(
            trackDef.busId, busIndexById, mainTargets);
        // A stereo source routed to a pair of mono Direct Output lanes must
        // keep its image: L -> first lane, R -> second lane (NOT sum into both,
        // which collapses the pair to mono). Additional/residual targets stay
        // summed (-1).
        const bool stereoPair = mainTargets.size() == 2;
        for (size_t k = 0; k < mainTargets.size(); ++k) {
            const size_t busIndex = mainTargets[k];
            TrackRoute route;
            route.trackIndex = static_cast<uint32_t>(i);
            route.busIndex = static_cast<uint32_t>(busIndex);
            route.gainLinear = trackGain;
            route.sendGainLinear = 1.0f;
            route.pan = trackPan;
            route.mute = trackSilenced;
            route.isAuxSend = false;
            route.forceMono = trackDef.mono;
            route.sourceChannel = stereoPair ? (k == 0 ? 0 : 1) : -1;
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
        out.pan = static_cast<float>(std::clamp(busDef.pan, -1.0, 1.0));
        out.mute = busDef.mute || (anyBusSolo && !busDef.solo);
        snapshot->outputs.push_back(out);
    }

    // Global Direct Output buses: unity pass-throughs to their physical
    // channel(s). Mono lanes write a single physical channel (singleChannel),
    // stereo pair lanes write L/R. Never muted/soloed -- they're just physical
    // egress points owned by the device config, not authorable strips.
    for (const DirectOutBus& dob : directOutBusses) {
        if (!dob.available)
            continue; // shadow lane: keep the route id, but no physical output
        auto busIt = busIndexById.find(dob.id);
        if (busIt == busIndexById.end())
            continue;
        BusOutput out;
        out.busIndex = static_cast<uint32_t>(busIt->second);
        out.startChannel = dob.startChannel;
        out.channelCount = dob.channels;
        out.gainLinear = 1.0f;
        out.pan = 0.0f;
        out.mute = false;
        out.singleChannel = dob.singleChannel;
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
    // Route target is a single id or a comma compound of mono Direct Output
    // lanes ("direct:1,direct:2"). Rendering fans the track into every
    // currently-live lane; a missing lane (unavailable output) is dropped to
    // silence and self-restores, so we never reject or mangle the mapping.
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

void AudioEngine::setBusPan(size_t busIndex, double pan) {
    auto& buses = loader.project().busses;
    if (busIndex >= buses.size())
        return;
    buses[busIndex].pan = std::clamp(pan, -1.0, 1.0);
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


    if (!projectLoaded)
        return;
    // Routing/gain/sends are project-global. Tempo grid follows the staged
    // song when one exists; empty projects use a 120 BPM / 4/4 default so
    // the metronome can still be toggled and metered.
    const Project& proj = loader.project();
    clickTargetBusIndices.clear();
    clickSendBusIndices.clear();
    clickSendGainLinears.clear();
    isClickEnabled = proj.builtInClickEnabled;

    // Gain/pan are project-global. Always refresh so Sends Only still has a
    // level even without a main target bus.
    clickGainLinear = dbToGain(proj.builtInClickGainDb);
    clickPan = static_cast<float>(
        std::clamp(proj.builtInClickPan, -1.0, 1.0));
    clickMono = proj.builtInClickMono;

    // Empty builtInClickBusId = Sends Only (no main target). Do NOT fall
    // back to the first bus -- that made "Sends Only" unselectable.
    clickTargetBusIndices.clear();
    if (!proj.builtInClickBusId.empty()) {
        audio_engine_detail::collectRouteBusIndices(
            proj.builtInClickBusId, busIndexById, clickTargetBusIndices);
    }

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
    const double prevBpm = clickGenerator.currentBpm();
    const int prevBpb = clickGenerator.currentBeatsPerBar();
    const int prevUnit = clickGenerator.currentBeatUnit();
    if (currentSampleRate > 0.0) {
        clickGenerator.prepare(currentSampleRate, bpm, tsNum, tsDen);
    }

    for (const TrackSendDef& cs : proj.builtInClickSends) {
        if (!cs.enabled)
            continue;
        auto it = busIndexById.find(cs.busId);
        if (it == busIndexById.end())
            continue;
        clickSendBusIndices.push_back(static_cast<int>(it->second));
        clickSendGainLinears.push_back(dbToGain(cs.gainDb));
    }

    // Live songUpdate of bpm/meter while playing: keep MIDI clock + SPP in
    // step with the new click grid. Skip pure gain/pan/bus routing edits.
    const bool tempoOrMeterChanged =
        std::abs(prevBpm - bpm) > 1.0e-9
        || prevBpb != tsNum
        || prevUnit != tsDen;
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

int AudioEngine::busStartChannelAt(size_t index) const {
    const auto& bp = loader.project().busses;
    if (index < bp.size())
        return bp[static_cast<size_t>(index)].output.startChannel;
    const size_t d = static_cast<size_t>(index) - bp.size();
    if (d < directOutBusses.size())
        return directOutBusses[d].startChannel;
    return 0;
}

int AudioEngine::busChannelCountAt(size_t index) const {
    const auto& bp = loader.project().busses;
    if (index < bp.size())
        return bp[static_cast<size_t>(index)].channels;
    const size_t d = static_cast<size_t>(index) - bp.size();
    if (d < directOutBusses.size())
        return directOutBusses[d].channels;
    return 2;
}

bool AudioEngine::busIsDirectAt(size_t index) const {
    return index >= project().busses.size();
}

bool AudioEngine::busAvailableAt(size_t index) const {
    const auto& bp = loader.project().busses;
    if (index < bp.size())
        return true; // project busses are always present
    const size_t d = static_cast<size_t>(index) - bp.size();
    if (d < directOutBusses.size())
        return directOutBusses[d].available;
    return true;
}

void AudioEngine::rebuildDirectOutBusses() {
    std::lock_guard<std::recursive_mutex> lock(routingMutex);

    directOutBusses.clear();

    const auto setup = deviceManagerInstance.getAudioDeviceSetup();
    const juce::BigInteger active = setup.outputChannels;
    const bool defaultMode = setup.useDefaultOutputChannels;
    int highest = -1;
    for (int i = 0; i < 512; ++i) {
        if (active[i])
            highest = i;
    }
    int total = highest + 1;
    if (auto* dev = deviceManagerInstance.getCurrentAudioDevice()) {
        total = std::max(total, dev->getOutputChannelNames().size());
    }
    if (total <= 0)
        total = 2; // default stereo output

    const auto activeAt = [&](int i) -> bool {
        if (i >= total)
            return false;
        // Nothing explicitly configured yet -- assume all device channels active.
        if (defaultMode)
            return true;
        return active[i];
    };

    // ONE mono lane per active output channel, numbered 1-based: physical
    // channel 0 => id "direct:1". No stereo-pair "direct:a/b" lanes at all --
    // a stereo route is expressed by a track/bus targeting both mono lanes
    // (see rebuildShadowRoutingRefs' compound handling). IDs always count from
    // 1 so the UI never shows a 0-based output.
    for (int i = 0; i < total; ++i) {
        if (!activeAt(i))
            continue;
        DirectOutBus b;
        b.id = "direct:" + std::to_string(i + 1); // 1-based
        b.name = "Out " + std::to_string(i + 1);
        b.startChannel = i; // 0-based physical index
        b.channels = 1;
        b.singleChannel = true;
        b.available = true;
        directOutBusses.push_back(std::move(b));
    }

    // Append "shadow" lanes for direct ids still referenced by the project
    // (tracks / metronome) whose physical output is currently inactive. They
    // keep the bus list + routing id stable so track settings are untouched
    // and mapping survives a device drop / missing-output project. Each is
    // flagged unavailable (routes to silence) and re-wires itself once its
    // output comes back, because its id is deterministic from the channel.
    {
        std::vector<std::string> refs;
        auto collect = [&](const std::string& id) {
            // A route id may be a compound ("direct:1,direct:2"); split so each
            // mono lane is considered independently for shadowing.
            std::size_t pos = 0;
            while (pos <= id.size()) {
                const std::size_t end = id.find(',', pos);
                std::string tok = id.substr(
                    pos, end == std::string::npos ? std::string::npos : end - pos);
                pos = (end == std::string::npos) ? id.size() + 1 : end + 1;
                if (!tok.empty() && tok.rfind("direct:", 0) == 0)
                    refs.push_back(tok);
            }
        };
        const Project& proj = loader.project();
        for (const TrackDef& t : proj.tracks) {
            collect(t.busId);
            for (const TrackSendDef& s : t.sends)
                collect(s.busId);
        }
        collect(proj.builtInClickBusId);
        for (const TrackSendDef& cs : proj.builtInClickSends)
            collect(cs.busId);

        std::vector<bool> seen(directOutBusses.size(), false);
        auto hasLane = [&](const std::string& id) -> bool {
            for (size_t i = 0; i < directOutBusses.size(); ++i)
                if (!seen[i] && directOutBusses[i].id == id) {
                    seen[i] = true;
                    return true;
                }
            return false;
        };

        for (const std::string& ref : refs) {
            if (hasLane(ref))
                continue;
            // "direct:{N}" where N is 1-based (physical channel N-1).
            int n = 0;
            try {
                n = std::stoi(ref.substr(7));
            } catch (...) {
                continue;
            }
            if (n < 1)
                continue;
            // Skip outright any Direct output the user has switched OFF in
            // Settings → Active output channels. A lane the owner disabled is
            // not a temporary device drop -- it must not reappear as a bus.
            // (Temporary gaps -- a channel merely absent from the current
            // device, or default-mode drops -- still keep their shadow lane so
            // routing survives a re-plug.)
            if (!defaultMode && n - 1 < total && !active[n - 1])
                continue;
            DirectOutBus b;
            b.id = ref;
            b.startChannel = n - 1; // 0-based physical index
            b.channels = 1;
            b.singleChannel = true;
            b.name = "Out " + std::to_string(n);
            b.available = false;
            directOutBusses.push_back(std::move(b));
        }
    }

    buildBusListFromProject();
    publishRoutingSnapshot();
}

} // namespace resostage
