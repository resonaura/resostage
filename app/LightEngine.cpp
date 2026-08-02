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
// and the rest of the spatial effects get their own per-LED shape via
// addressableEffectLedColor. All of that per-LED math lives in the shared
// resolveLedWireColors() so the websocket stream can never diverge from
// what this real output path writes.
void writeDmxChannels(const ResolvedFixtureOutput& out,
                      const ResoLightChannelAssignment& assign,
                      const LightFixture& fixture,
                      std::map<int, std::vector<uint8_t>>& frames) {
    auto& universe = frames[assign.universe];
    if (universe.empty())
        universe.assign(512, 0);

    const std::vector<LedWireColor> wireColors = resolveLedWireColors(out, fixture);
    const int startIdx = assign.startChannel - 1; // 0-based index

    // Real bytes-per-pixel this fixture occupies. A ResoLightBar's color
    // type (Dimmer/RGB/RGBW) genuinely changes this -- see
    // colorProfileByteCount, the same function assignResoLightChannels used
    // to size its channel reservation, so the two can never disagree. A
    // DmxGeneric fixture's declared channel count is a real reservation
    // against whatever's patched right after it (see
    // assignResoLightChannels/lightingFixtureAdd's collision avoidance),
    // clamped to 1..3 since resolveLedWireColors only ever populates r/g/b
    // for it (see that function's doc comment on why leading-channel
    // personalities like Dimmer+RGB aren't offered for DmxGeneric).
    const int perPixelBytes = fixture.kind == LightFixture::Kind::ResoLightBar
        ? colorProfileByteCount(fixture.channelProfile)
        : std::clamp(fixture.dmxChannelCount, 1, 3);

    const auto writeOne = [&](int base, const LedWireColor& c) {
        if (base < 0 || base + perPixelBytes - 1 >= 512)
            return;
        const auto idx = static_cast<size_t>(base);
        if (perPixelBytes >= 1) universe[idx + 0] = c.r;
        if (perPixelBytes >= 2) universe[idx + 1] = c.g;
        if (perPixelBytes >= 3) universe[idx + 2] = c.b;
        if (perPixelBytes >= 4) universe[idx + 3] = c.w;
    };

    if (wireColors.size() <= 1) {
        writeOne(startIdx, wireColors.empty() ? LedWireColor{} : wireColors[0]);
        return;
    }

    const int leds = std::min(static_cast<int>(wireColors.size()), (512 - startIdx) / perPixelBytes);
    for (int i = 0; i < leds; ++i)
        writeOne(startIdx + i * perPixelBytes, wireColors[static_cast<size_t>(i)]);
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
    const SourceLevelDbFn sourceLevelDb = [this](const std::string& type, const std::string& id) -> SourceLevels {
        if (type == "track")
            return trackPeakDb_ ? trackPeakDb_(id) : SourceLevels{};
        return busPeakDb_ ? busPeakDb_(id) : SourceLevels{};
    };

    // Idle-transition fade state -- local to this thread's loop, never
    // touched from outside, so plain locals suffice (no member vars/locks
    // needed). `lastResolvedOutputs` is whatever the rig was ACTUALLY
    // showing the instant before an idle override (blackout/staticColor)
    // kicked in -- captured continuously whenever we're NOT idle-fading
    // (so it's current, whether that "before" state was live playback or a
    // frozen holdLast resolve), so a fade always starts from the truth
    // instead of snapping.
    constexpr double kIdleFadeSeconds = 1.5;
    std::vector<ResolvedFixtureOutput> lastResolvedOutputs;
    bool wasIdleFading = false;
    auto idleFadeStart = std::chrono::steady_clock::now();

    // Per-universe send throttling -- resolves happen every tick (cheap),
    // but a universe only actually goes out to the network at its own
    // configured rate (LightFixture::refreshRateHz, or
    // LightingConfig::defaultRefreshRateHz for fixtures that don't
    // override it). A universe is one shared wire, so it can only be sent
    // at one rate; the SLOWEST rate among fixtures patched into it governs
    // -- that's the one a faster send could actually hurt (flicker/dropped
    // frames on older or glitchy gear), see LightFixture::refreshRateHz's
    // doc comment.
    std::map<int, std::chrono::steady_clock::time_point> lastSentPerUniverse;

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

        // Stopped transport + a configured idle behavior (blackout/static
        // color) overrides the normal cue-driven resolve entirely -- see
        // buildIdleLightOutputs's doc comment. "holdLast" (the default)
        // keeps calling resolveLightOutputs() exactly as before this
        // setting existed, i.e. whatever the frozen playhead resolves to.
        const bool useIdleOverride = !clock_->isRunning() && proj->lighting.idleBehavior != "holdLast";
        std::vector<ResolvedFixtureOutput> resolved;
        if (!useIdleOverride) {
            resolved = resolveLightOutputs(
                proj->lightTracks, song.lightCues, tSec, bpm_.load(std::memory_order_relaxed), sourceLevelDb);
            lastResolvedOutputs = resolved;
            wasIdleFading = false;
        } else {
            if (!wasIdleFading) {
                idleFadeStart = std::chrono::steady_clock::now();
                wasIdleFading = true;
            }
            const auto target = buildIdleLightOutputs(proj->lighting.fixtures, proj->lighting.idleBehavior,
                                                        proj->lighting.idleColorR, proj->lighting.idleColorG,
                                                        proj->lighting.idleColorB, proj->lighting.idleIntensity);
            const double elapsed =
                std::chrono::duration<double>(std::chrono::steady_clock::now() - idleFadeStart).count();
            resolved = blendTowardIdle(lastResolvedOutputs, target, elapsed / kIdleFadeSeconds);
        }

        std::map<int, std::vector<uint8_t>> frames; // universe → 512 bytes
        std::map<int, double> minHzPerUniverse;
        for (const auto& out : resolved) {
            auto lutIt = fixtureLut.find(out.fixtureId);
            if (lutIt == fixtureLut.end())
                continue;
            const auto& [assignIdx, fixture] = lutIt->second;
            const auto& assign = channelMap[static_cast<size_t>(assignIdx)];
            writeDmxChannels(out, assign, *fixture, frames);

            const double hz = fixture->refreshRateHz > 0.0 ? fixture->refreshRateHz : proj->lighting.defaultRefreshRateHz;
            auto mit = minHzPerUniverse.find(assign.universe);
            if (mit == minHzPerUniverse.end() || hz < mit->second)
                minHzPerUniverse[assign.universe] = hz;
        }

        const auto now = std::chrono::steady_clock::now();
        for (auto& [uni, data] : frames) {
            const double hz = minHzPerUniverse.count(uni) ? minHzPerUniverse[uni] : proj->lighting.defaultRefreshRateHz;
            const auto sendInterval = std::chrono::duration<double>(1.0 / std::max(1.0, hz));
            auto lastIt = lastSentPerUniverse.find(uni);
            if (lastIt != lastSentPerUniverse.end() && (now - lastIt->second) < sendInterval)
                continue; // this universe isn't due for a resend yet
            lastSentPerUniverse[uni] = now;

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
