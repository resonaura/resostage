#include "LightEngine.h"

#include <algorithm>
#include <chrono>
#include <map>
#include <pthread.h>
#include <set>
#include <thread>

namespace resostage {

// ─── Helpers ─────────────────────────────────────────────────────────────────

namespace {

// Map (0..1 audio level) through an 8-segment LED quantiser for the Meter
// effect so it looks like a real VU bar (segments light bottom-to-top).
// The quantised value is the intensity multiplier for the fixture.
inline float quantiseToLedSegments(float level, int segments = 8) {
    level = std::clamp(level, 0.0f, 1.0f);
    return std::floor(level * segments) / static_cast<float>(segments);
}

// Convert -inf..0 dBFS to a 0..1 linear level.
// Maps [-60 dBFS, 0 dBFS] → [0, 1]; anything below -60 dBFS is silence.
inline float dbToLinear(float peakDb) {
    return std::max(0.0f, std::min(1.0f, (peakDb + 60.0f) / 60.0f));
}

// Write one LightCueValue into the correct DMX channels for the given
// fixture assignment. Fills `frames` (universe → 512 byte array).
void writeDmxChannels(const LightCueValue& val,
                      const ResoLightChannelAssignment& assign,
                      const LightFixture& fixture,
                      std::map<int, std::vector<uint8_t>>& frames) {
    auto& universe = frames[assign.universe];
    if (universe.empty())
        universe.assign(512, 0);

    const auto scaled = [&](uint8_t ch) -> uint8_t {
        return static_cast<uint8_t>(
            std::clamp(static_cast<double>(ch) * val.intensity, 0.0, 255.0));
    };

    const int startIdx = assign.startChannel - 1; // 0-based index

    if (!fixture.addressable || fixture.ledCount <= 1) {
        // Uniform RGB for the whole bar.
        if (startIdx + 2 < 512) {
            universe[startIdx + 0] = scaled(val.r);
            universe[startIdx + 1] = scaled(val.g);
            universe[startIdx + 2] = scaled(val.b);
        }
    } else {
        // Per-LED RGB: fill all LEDs with the same color (uniform for now;
        // per-LED addressing can be layered on in Phase B).
        const int leds = std::min(fixture.ledCount, (512 - startIdx) / 3);
        for (int i = 0; i < leds; ++i) {
            const int base = startIdx + i * 3;
            universe[base + 0] = scaled(val.r);
            universe[base + 1] = scaled(val.g);
            universe[base + 2] = scaled(val.b);
        }
    }
}

// Build channel assignments for ResoLightBar fixtures and a lookup map
// fixture id → assignment index.
inline std::vector<ResoLightChannelAssignment>
buildChannelMap(const std::vector<LightFixture>& fixtures) {
    return assignResoLightChannels(fixtures);
}

} // namespace

// ─── LightEngine ─────────────────────────────────────────────────────────────

void LightEngine::start(MasterClock& clock,
                        EventDispatcher& dispatcher,
                        BusMeterFn busPeakDb,
                        double initialBpm) {
    if (running_.exchange(true, std::memory_order_acq_rel))
        return; // already running

    clock_       = &clock;
    dispatch_    = &dispatcher;
    busPeakDb_   = std::move(busPeakDb);
    bpm_.store(initialBpm, std::memory_order_relaxed);

    thread_ = std::thread([this] { threadLoop(); });
}

void LightEngine::stop() {
    if (!running_.exchange(false, std::memory_order_acq_rel))
        return;
    if (thread_.joinable())
        thread_.join();
}

void LightEngine::setProject(std::shared_ptr<const Project> proj) {
    std::lock_guard<std::mutex> lock(snapshotMutex_);
    snapshot_ = std::move(proj);
}

// ─── Effect param builder ─────────────────────────────────────────────────────

EffectParams LightEngine::buildEffectParams(const LightCue& cue,
                                             int fixtureIndex,
                                             double tSec) const {
    EffectParams p;
    p.type         = parseEffectType(cue.effectType);
    p.intensity    = cue.effectIntensity;
    p.fixtureIndex = fixtureIndex;
    // Anchor effect time relative to cue start on the song timeline so phase is deterministic.
    p.tSec         = std::max(0.0, tSec - cue.startSeconds);

    if (cue.tempoSync) {
        const double bpm = bpm_.load(std::memory_order_relaxed);
        p.rateHz = subdivToHz(cue.tempoSubdiv, bpm, cue.effectRateHz);
    } else {
        p.rateHz = cue.effectRateHz;
    }

    // Meter effect: sample the target bus level.
    if (p.type == EffectParams::Type::Meter && busPeakDb_) {
        const float db = busPeakDb_(cue.effectBusId);
        p.audioLevel = quantiseToLedSegments(dbToLinear(db));
    }

    return p;
}

// ─── Main thread loop ─────────────────────────────────────────────────────────

void LightEngine::threadLoop() {
    // Elevate to near-realtime priority so DMX output stays stable even under
    // UI / disk load. Priority 45 sits above normal threads but well below the
    // audio callback (~96) to avoid starving audio.
    {
        sched_param sp{};
        sp.sched_priority = 45;
        pthread_setschedparam(pthread_self(), SCHED_RR, &sp);
    }

    constexpr auto kFrameInterval =
        std::chrono::microseconds(1'000'000 / kFrameRateHz);

    auto nextFrame = std::chrono::steady_clock::now();

    while (running_.load(std::memory_order_acquire)) {
        // Sleep until next frame deadline.
        std::this_thread::sleep_until(nextFrame);
        nextFrame += kFrameInterval;

        // Load project snapshot safely under mutex.
        std::shared_ptr<const Project> proj;
        {
            std::lock_guard<std::mutex> lock(snapshotMutex_);
            proj = snapshot_;
        }
        if (!proj || !proj->lighting.enabled)
            continue; // no project or lighting disabled — send nothing

        const int songIdx = clock_->currentSongIndex();
        if (songIdx < 0 || songIdx >= static_cast<int>(proj->songs.size()))
            continue;

        const SongDef& song = proj->songs[static_cast<size_t>(songIdx)];
        const double tSec = clock_->currentSeconds();

        // Build channel assignments for this frame.
        const auto channelMap = buildChannelMap(proj->lighting.fixtures);

        // Build a lookup: fixtureId → (channel assignment index, LightFixture*)
        struct FixtureLookup {
            int assignIdx = -1;
            const LightFixture* fixture = nullptr;
        };
        std::map<std::string, FixtureLookup> fixtureLut;
        for (int i = 0; i < static_cast<int>(channelMap.size()); ++i) {
            const auto& a = channelMap[static_cast<size_t>(i)];
            for (const auto& f : proj->lighting.fixtures) {
                if (f.id == a.fixtureId) {
                    fixtureLut[f.id] = {i, &f};
                    break;
                }
            }
        }

        // Collect cues per trackId for fast lookup.
        std::map<std::string, std::vector<const LightCue*>> cuesByTrack;
        for (const auto& cue : song.lightCues)
            cuesByTrack[cue.trackId].push_back(&cue);

        // Assemble DMX frames.
        std::map<int, std::vector<uint8_t>> frames; // universe → 512 bytes

        for (const auto& track : proj->lightTracks) {
            // Gather cues for this track.
            std::vector<LightCue> trackCues;
            if (auto it = cuesByTrack.find(track.id); it != cuesByTrack.end())
                for (const LightCue* cp : it->second)
                    trackCues.push_back(*cp);

            if (trackCues.empty())
                continue;

            // Resolve base color+intensity at the current timeline position.
            LightCueValue val = resolveLightCueValue(trackCues, tSec);

            // Determine which cue is active so we can read its effect params.
            const LightCue* activeCue = nullptr;
            {
                double latestStart = -1.0;
                for (const auto& c : trackCues) {
                    if (tSec >= c.startSeconds &&
                        tSec < c.startSeconds + c.durationSeconds &&
                        c.startSeconds > latestStart) {
                        latestStart = c.startSeconds;
                        activeCue = &c;
                    }
                }
            }

            // Apply per-fixture: effect modulation + DMX write.
            int fixturePos = 0;
            for (const auto& fxId : track.fixtureIds) {
                auto lutIt = fixtureLut.find(fxId);
                if (lutIt == fixtureLut.end()) {
                    ++fixturePos;
                    continue;
                }
                const auto& lookup = lutIt->second;

                LightCueValue fxVal = val;
                if (activeCue) {
                    const EffectParams ep =
                        buildEffectParams(*activeCue, fixturePos, tSec);
                    fxVal = applyEffect(fxVal, ep);
                }

                writeDmxChannels(fxVal,
                                  channelMap[static_cast<size_t>(lookup.assignIdx)],
                                  *lookup.fixture,
                                  frames);
                ++fixturePos;
            }
        }

        // Send one DMX packet per universe.
        for (auto& [uni, data] : frames) {
            DmxTriggerCommand cmd;
            cmd.universe = uni;
            cmd.data     = std::move(data);
            dispatch_->enqueueDmx(cmd);
        }
    }

    // Blackout: zero all universes we know about before exiting.
    std::shared_ptr<const Project> proj;
    {
        std::lock_guard<std::mutex> lock(snapshotMutex_);
        proj = snapshot_;
    }
    if (proj && dispatch_) {
        const auto channelMap = buildChannelMap(proj->lighting.fixtures);
        std::set<int> universes;
        for (const auto& a : channelMap)
            universes.insert(a.universe);
        for (int uni : universes) {
            DmxTriggerCommand cmd;
            cmd.universe = uni;
            cmd.data.assign(512, 0);
            dispatch_->enqueueDmx(cmd);
        }
    }
}


} // namespace resostage
