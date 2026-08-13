#include "LightEngine.h"

#include "ResoLightProtocol.h"

#include <algorithm>
#include <chrono>
#include <map>
#include <set>
#include <thread>

#if !defined(_WIN32)
#include <pthread.h>
#else
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

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
void writeWireColorsToDmx(const std::vector<LedWireColor>& wireColors,
                          const ResoLightChannelAssignment& assign,
                          const LightFixture& fixture,
                          std::map<int, std::vector<uint8_t>>& frames) {
    auto& universe = frames[assign.universe];
    if (universe.empty())
        universe.assign(512, 0);

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
        : std::clamp(fixture.dmx.channelCount, 1, 3);

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
    writeWireColorsToDmx(resolveLedWireColors(out, fixture), assign, fixture, frames);
}

// Idle-transition variant: crossfades each LED between the frozen "from"
// snapshot and the live "to" target (see resolveLedWireColorsBlended's doc
// comment) instead of writing the pre-blended aggregate `out` -- this is
// what makes an addressable effect's per-LED shape actually dissolve into
// the target pattern instead of snapping the instant a fade begins.
void writeDmxChannelsBlended(const ResolvedFixtureOutput& from,
                             const ResolvedFixtureOutput& to,
                             double t,
                             const ResoLightChannelAssignment& assign,
                             const LightFixture& fixture,
                             std::map<int, std::vector<uint8_t>>& frames) {
    writeWireColorsToDmx(resolveLedWireColorsBlended(from, to, fixture, t), assign, fixture, frames);
}

inline std::vector<ResoLightChannelAssignment>
buildChannelMap(const std::vector<LightFixture>& fixtures) {
    return assignResoLightChannels(fixtures);
}

} // namespace

// ─── LightEngine ─────────────────────────────────────────────────────────────

void LightEngine::start(MasterClock& clock,
                        EventDispatcher& dispatcher,
                        LightHardwareServer* hardwareServer,
                        BusMeterFn busPeakDb,
                        TrackMeterFn trackPeakDb,
                        double initialBpm) {
    if (running_.exchange(true, std::memory_order_acq_rel))
        return; // already running

    clock_       = &clock;
    dispatch_    = &dispatcher;
    hardwareServer_ = hardwareServer;
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
#if defined(_WIN32)
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
#else
    {
        sched_param sp{};
        sp.sched_priority = 45;
        pthread_setschedparam(pthread_self(), SCHED_RR, &sp);
    }
#endif

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
    // showing the instant before an idle override (blackout/staticColor/
    // effect) kicked in -- captured continuously whenever we're NOT
    // idle-fading (so it's current, whether that "before" state was live
    // playback or a frozen holdLast resolve), so a fade always starts from
    // the truth instead of snapping. `resumeFrom` is the mirror image: the
    // idle output captured the instant the override turned OFF, so coming
    // back to normal lighting fades smoothly out of it too. `lastFrame` is
    // the previous frame's output, used to snapshot the current position on
    // either transition. kIdleFadeSeconds lives in LightOutputResolver.h so
    // MainComponent's preview push fades at the identical rate.
    std::vector<ResolvedFixtureOutput> lastResolvedOutputs;
    std::vector<ResolvedFixtureOutput> resumeFrom;
    std::vector<ResolvedFixtureOutput> lastFrame;
    bool wasIdleFading = false;
    bool wasResumeFading = false;
    auto idleFadeStart = std::chrono::steady_clock::now();
    auto resumeFadeStart = std::chrono::steady_clock::now();

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

        // Keep hardware connections warm for every fixture with a
        // configured host, independent of whether it has an active cue
        // this tick -- see LightHardwareServer.h's threading-contract doc
        // comment on why connection lifecycle is decoupled from frame
        // delivery below.
        if (hardwareServer_ != nullptr) {
            std::vector<LightHardwareServer::ActiveFixtureTarget> active;
            for (const auto& f : proj->lighting.fixtures) {
                if (f.kind != LightFixture::Kind::ResoLightBar
                    || !f.networkHost.has_value() || f.networkHost->empty())
                    continue;
                LightHardwareServer::ActiveFixtureTarget t;
                t.fixtureId = f.id;
                t.host = *f.networkHost;
                // Port is a protocol constant (ResoLightProtocol.h), never
                // per-fixture user config -- both ends hardcode the same value.
                t.port = resolight::kDefaultBoardPort;
                active.push_back(std::move(t));
            }
            hardwareServer_->syncActiveFixtures(active);
        }

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
        // color/effect) overrides the normal cue-driven resolve entirely --
        // see buildIdleTarget's doc comment. "hold" (the default) keeps
        // calling resolveLightOutputs() exactly as before this setting
        // existed, i.e. whatever the frozen playhead resolves to.
        const bool useIdleOverride = !clock_->isRunning() && proj->lighting.idle.behavior != "hold";

        // Idle-behavior transition bookkeeping. Leaving idle (resume or a
        // switch back to holdLast) starts a symmetric fade back out of the
        // idle state; stopping again mid-resume folds the current position
        // back into an idle fade. `lastFrame` is the previous frame's
        // output, the honest "what are we showing right now" both snapshot
        // their "from" state from. Each transition fires once (edge-triggered):
        // leaving idle keys on `wasIdleFading` only, never on an already-
        // active resume fade -- otherwise resumeFadeStart would reset every
        // frame while playing and the fade-out would never progress.
        if (useIdleOverride && !wasIdleFading && !wasResumeFading) {
            // Fresh entry into idle -- the transport just stopped (or an
            // idle behavior was just configured while stopped). Start the
            // fade from the last pre-idle resolve, which `lastResolvedOutputs`
            // still holds. The first frame comes out fully at `from`, so
            // there's no snap, just the start of the kIdleFadeSeconds fade.
            idleFadeStart = std::chrono::steady_clock::now();
            wasIdleFading = true;
        } else if (wasResumeFading && useIdleOverride) {
            lastResolvedOutputs = lastFrame;
            idleFadeStart = std::chrono::steady_clock::now();
            wasResumeFading = false;
            wasIdleFading = true;
        } else if (!useIdleOverride && wasIdleFading) {
            resumeFrom = lastFrame;
            resumeFadeStart = std::chrono::steady_clock::now();
            wasResumeFading = true;
            wasIdleFading = false;
        }

        // When a fade is genuinely in progress (0 < blendT < 1), these hold
        // the "from"/"to" sides so the DMX write loop below can crossfade
        // each LED individually via resolveLedWireColorsBlended instead of
        // writing the pre-blended aggregate `resolved` (see
        // writeDmxChannelsBlended's doc comment). Left empty and blendT left
        // at 1.0 outside a fade, which makes the write loop fall back to the
        // ordinary per-fixture writeDmxChannels path.
        std::vector<ResolvedFixtureOutput> resolved;
        std::vector<ResolvedFixtureOutput> blendFrom;
        std::vector<ResolvedFixtureOutput> blendTo;
        double blendT = 1.0;
        if (wasResumeFading) {
            // Fading back from idle to the normal cue resolve. Fixtures the
            // idle state turned on but that no cue drives anymore get an
            // explicit off-row so they fade to black instead of snapping.
            auto normal = resolveLightOutputs(
                proj->lighting.tracks, song.lightCues, tSec, bpm_.load(std::memory_order_relaxed), sourceLevelDb);
            const double t = std::chrono::duration<double>(std::chrono::steady_clock::now() - resumeFadeStart)
                                 .count() /
                             kResumeFadeSeconds;
            if (t >= 1.0) {
                resolved = std::move(normal);
                wasResumeFading = false;
            } else {
                for (const auto& rf : resumeFrom) {
                    bool found = false;
                    for (const auto& n : normal)
                        if (n.fixtureId == rf.fixtureId) { found = true; break; }
                    if (!found) {
                        ResolvedFixtureOutput r;
                        r.fixtureId = rf.fixtureId;
                        normal.push_back(std::move(r));
                    }
                }
                resolved = blendTowardIdle(resumeFrom, normal, t);
                blendFrom = resumeFrom;
                blendTo = normal;
                blendT = t;
            }
            lastResolvedOutputs = resolved;
        } else if (wasIdleFading) {
            // Fading into (and then sustaining) the idle target. effectPhase
            // is wall-clock seconds since the fade began -- consumed by the
            // "effect" idle mode so the effect animates while stopped.
            const double effectPhase =
                std::chrono::duration<double>(std::chrono::steady_clock::now() - idleFadeStart).count();
            const auto target = buildIdleTarget(proj->lighting.fixtures, proj->lighting.idle.behavior,
                                                proj->lighting.idle.color.r, proj->lighting.idle.color.g,
                                                proj->lighting.idle.color.b, proj->lighting.idle.intensity,
                                                proj->lighting.idle.effect.type, proj->lighting.idle.effect.rateHz,
                                                proj->lighting.idle.gradient.preset, proj->lighting.idle.gradient.colors.value_or(""),
                                                effectPhase);
            const double t = effectPhase / kIdleFadeSeconds;
            resolved = blendTowardIdle(lastResolvedOutputs, target, t);
            if (t < 1.0) {
                blendFrom = lastResolvedOutputs;
                blendTo = target;
                blendT = t;
            }
        } else {
            resolved = resolveLightOutputs(
                proj->lighting.tracks, song.lightCues, tSec, bpm_.load(std::memory_order_relaxed), sourceLevelDb);
            lastResolvedOutputs = resolved;
        }
        lastFrame = resolved;

        // Only built when a fade is actually in progress -- see blendFrom's
        // doc comment above. `blendTo`/`resolved` share the same fixture
        // order (both derived by iterating the same "to" vector inside
        // blendTowardIdle), so `blendTo[i]` always matches `resolved[i]`;
        // only the "from" side needs a lookup by id since a fixture can be
        // absent from it (never had an active cue when the fade started).
        std::map<std::string, const ResolvedFixtureOutput*> blendFromById;
        const bool blendActive = !blendFrom.empty() || !blendTo.empty();
        if (blendActive)
            for (const auto& f : blendFrom)
                blendFromById[f.fixtureId] = &f;

        std::map<int, std::vector<uint8_t>> frames; // universe → 512 bytes
        std::map<int, double> minHzPerUniverse;
        for (size_t i = 0; i < resolved.size(); ++i) {
            const auto& out = resolved[i];
            auto lutIt = fixtureLut.find(out.fixtureId);
            if (lutIt == fixtureLut.end())
                continue;
            const auto& [assignIdx, fixture] = lutIt->second;
            const auto& assign = channelMap[static_cast<size_t>(assignIdx)];

            static const ResolvedFixtureOutput kBlackFallback{};
            const ResolvedFixtureOutput* fromEntry = &kBlackFallback;
            if (blendActive) {
                if (auto it = blendFromById.find(out.fixtureId); it != blendFromById.end())
                    fromEntry = it->second;
                writeDmxChannelsBlended(*fromEntry, blendTo[i], blendT, assign, *fixture, frames);
            } else {
                writeDmxChannels(out, assign, *fixture, frames);
            }

            const double hz = fixture->refreshRateHz > 0.0 ? fixture->refreshRateHz : proj->lighting.defaultRefreshRateHz;
            auto mit = minHzPerUniverse.find(assign.universe);
            if (mit == minHzPerUniverse.end() || hz < mit->second)
                minHzPerUniverse[assign.universe] = hz;

            // Real-hardware push (ResoLightBar with an attached ESP32/
            // ESP8266 board only -- see LightHardwareServer.h). Computed
            // separately from the DMX write above (a second, cheap
            // resolveLedWireColors call) rather than threading a byte
            // buffer out of writeWireColorsToDmx, so this can never risk
            // the proven DMX output path -- the cost only exists for
            // fixtures that actually have a host configured, which is zero
            // for the common preview-only rig.
            // A ResoLight board is not an Art-Net universe: the 44 Hz default
            // above exists because Art-Net's spec floor is 40 Hz and older DMX
            // gear dislikes being pushed faster, neither of which applies to a
            // board we wrote the firmware for. Give it the engine's full tick
            // rate unless the operator pinned a rate on the fixture.
            const double boardHz = fixture->refreshRateHz > 0.0
                                       ? fixture->refreshRateHz
                                       : static_cast<double>(kFrameRateHz);

            if (hardwareServer_ != nullptr && fixture->kind == LightFixture::Kind::ResoLightBar &&
                fixture->networkHost.has_value() && !fixture->networkHost->empty()) {
                const std::vector<LedWireColor> wireColors = blendActive
                    ? resolveLedWireColorsBlended(*fromEntry, blendTo[i], *fixture, blendT)
                    : resolveLedWireColors(out, *fixture);
                const int perPixelBytes = colorProfileByteCount(fixture->channelProfile);
                std::vector<uint8_t> flat;
                flat.reserve(wireColors.size() * static_cast<size_t>(perPixelBytes));
                for (const auto& c : wireColors) {
                    if (perPixelBytes >= 1) flat.push_back(c.r);
                    if (perPixelBytes >= 2) flat.push_back(c.g);
                    if (perPixelBytes >= 3) flat.push_back(c.b);
                    if (perPixelBytes >= 4) flat.push_back(c.w);
                }
                hardwareServer_->updateFixtureFrame(fixture->id, *fixture->networkHost,
                                                    resolight::kDefaultBoardPort,
                                                    static_cast<uint8_t>(perPixelBytes), flat.data(),
                                                    flat.size(), boardHz);
            }
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
