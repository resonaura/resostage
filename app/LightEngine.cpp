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

// Write one resolved fixture output into the correct DMX channels.
// Non-addressable fixtures (or addressable ones with no per-LED effect
// active) get a uniform RGB triplet scaled by intensity across the whole
// bar. Addressable fixtures whose active cue IS Meter get a real
// progressive bottom-up LED fill (see meterLedColor) -- this is what makes
// an addressable ResoLight bar actually look like a VU meter instead of
// just uniformly dimming, matching how every other meter in the app
// (LevelMeterBar.tsx) already fills bottom-to-top. Converge/GradientFlow
// get their own per-LED shape via addressableEffectLedColor -- travelling
// lines / a scrolling rainbow only mean something once you have individual
// LEDs to place them on.
void writeDmxChannels(const ResolvedFixtureOutput& out,
                      const ResoLightChannelAssignment& assign,
                      const LightFixture& fixture,
                      std::map<int, std::vector<uint8_t>>& frames) {
    auto& universe = frames[assign.universe];
    if (universe.empty())
        universe.assign(512, 0);

    const auto scaled = [&](uint8_t ch, double ledLevel) -> uint8_t {
        return static_cast<uint8_t>(
            std::clamp(static_cast<double>(ch) * out.value.intensity * ledLevel, 0.0, 255.0));
    };

    const int startIdx = assign.startChannel - 1; // 0-based index

    if (!fixture.addressable || fixture.ledCount <= 1) {
        // Uniform RGB for the whole bar -- no per-LED concept applies.
        if (startIdx + 2 < 512) {
            universe[startIdx + 0] = scaled(out.value.r, 1.0);
            universe[startIdx + 1] = scaled(out.value.g, 1.0);
            universe[startIdx + 2] = scaled(out.value.b, 1.0);
        }
        return;
    }

    const int leds = std::min(fixture.ledCount, (512 - startIdx) / 3);
    // meterLevel01 is only ever non-zero when the active cue's effect is
    // actually Meter (see LightOutputResolver.h) -- safe to use its
    // presence as the "should this bar do a VU fill" signal.
    const bool meterActive = out.meterLevel01 > 0.0f;
    const bool spatialEffectActive = !meterActive &&
        out.effectType != EffectParams::Type::None;
    const int litCount = meterActive
        ? std::clamp(static_cast<int>(std::lround(out.meterLevel01 * leds)), 0, leds)
        : leds; // not metering: every LED "lit" at the resolved uniform color

    for (int i = 0; i < leds; ++i) {
        uint8_t r = out.value.r, g = out.value.g, b = out.value.b;
        double ledLevel = 1.0;
        if (meterActive) {
            meterLedColor(i, litCount, leds, out.gradient, out.value.r, out.value.g, out.value.b, r, g, b);
        } else if (spatialEffectActive) {
            addressableEffectLedColor(i, leds, out.effectType, out.effectTSec, out.effectRateHz,
                                       out.value.r, out.value.g, out.value.b, r, g, b, ledLevel);
        }
        const int base = startIdx + i * 3;
        universe[base + 0] = scaled(r, ledLevel);
        universe[base + 1] = scaled(g, ledLevel);
        universe[base + 2] = scaled(b, ledLevel);
    }
}

inline std::vector<ResoLightChannelAssignment>
buildChannelMap(const std::vector<LightFixture>& fixtures) {
    return assignResoLightChannels(fixtures);
}

} // namespace

// ─── LightEngine ─────────────────────────────────────────────────────────────

void LightEngine::start(MasterClock& clock,
                        EventDispatcher& dispatcher,
                        BusMeterFn busPeakDb,
                        TrackMeterFn trackPeakDb,
                        double initialBpm) {
    if (running_.exchange(true, std::memory_order_acq_rel))
        return; // already running

    clock_       = &clock;
    dispatch_    = &dispatcher;
    busPeakDb_   = std::move(busPeakDb);
    trackPeakDb_ = std::move(trackPeakDb);
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

    // Dispatches by effectSourceType so a single resolver call can pull
    // from either meter pool interchangeably.
    const SourceLevelDbFn sourceLevelDb = [this](const std::string& type, const std::string& id) -> float {
        if (type == "track")
            return trackPeakDb_ ? trackPeakDb_(id) : -100.0f;
        return busPeakDb_ ? busPeakDb_(id) : -100.0f;
    };

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

        const auto channelMap = buildChannelMap(proj->lighting.fixtures);
        std::map<std::string, std::pair<int, const LightFixture*>> fixtureLut;
        for (int i = 0; i < static_cast<int>(channelMap.size()); ++i) {
            const auto& a = channelMap[static_cast<size_t>(i)];
            for (const auto& f : proj->lighting.fixtures) {
                if (f.id == a.fixtureId) {
                    fixtureLut[f.id] = {i, &f};
                    break;
                }
            }
        }

        const auto resolved = resolveLightOutputs(
            proj->lightTracks, song.lightCues, tSec, bpm_.load(std::memory_order_relaxed), sourceLevelDb);

        std::map<int, std::vector<uint8_t>> frames; // universe → 512 bytes
        for (const auto& out : resolved) {
            auto lutIt = fixtureLut.find(out.fixtureId);
            if (lutIt == fixtureLut.end())
                continue;
            const auto& [assignIdx, fixture] = lutIt->second;
            writeDmxChannels(out, channelMap[static_cast<size_t>(assignIdx)], *fixture, frames);
        }

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
