#include "AutomationEvaluator.h"

namespace resostage {

float AutomationEvaluator::evaluatePoints(
    const std::vector<AutomationPoint>& points,
    double timeBeats,
    float defaultValue) noexcept {
    if (points.empty())
        return defaultValue;

    if (points.size() == 1 || timeBeats <= points.front().timeBeats)
        return points.front().value;

    if (timeBeats >= points.back().timeBeats)
        return points.back().value;

    auto it = std::upper_bound(
        points.begin(), points.end(), timeBeats,
        [](double t, const AutomationPoint& pt) {
            return t < pt.timeBeats;
        });

    if (it == points.end())
        return points.back().value;

    const auto prev = it - 1;
    const double span = it->timeBeats - prev->timeBeats;
    if (span <= 1.0e-9)
        return it->value;

    const double tau = (timeBeats - prev->timeBeats) / span;
    return AutomationCurve::interpolateFloat(
        static_cast<float>(tau), prev->value, it->value, prev->curve);
}

float AutomationEvaluator::evaluatePointsWithCursor(
    const std::vector<AutomationPoint>& points,
    double timeBeats,
    size_t& cursor,
    float defaultValue) noexcept {
    if (points.empty())
        return defaultValue;

    if (points.size() == 1 || timeBeats <= points.front().timeBeats) {
        cursor = 0;
        return points.front().value;
    }

    const size_t maxIndex = points.size() - 1;
    if (timeBeats >= points.back().timeBeats) {
        cursor = maxIndex > 0 ? maxIndex - 1 : 0;
        return points.back().value;
    }

    if (cursor >= maxIndex)
        cursor = 0;

    if (timeBeats < points[cursor].timeBeats)
        cursor = 0;

    while (cursor + 1 < points.size() && timeBeats > points[cursor + 1].timeBeats)
        ++cursor;

    if (cursor >= maxIndex)
        cursor = maxIndex - 1;

    const auto& p0 = points[cursor];
    const auto& p1 = points[cursor + 1];
    const double span = p1.timeBeats - p0.timeBeats;

    if (span <= 1.0e-9)
        return p1.value;

    const double tau = (timeBeats - p0.timeBeats) / span;
    return AutomationCurve::interpolateFloat(
        static_cast<float>(tau), p0.value, p1.value, p0.curve);
}

float AutomationEvaluator::evaluateLane(
    const AutomationLane& lane,
    double timeBeats,
    float defaultValue) noexcept {
    if (!lane.enabled || lane.muted)
        return defaultValue;
    return evaluatePoints(lane.points, timeBeats, defaultValue);
}

void AutomationEvaluator::evaluateLaneBlock(
    const AutomationLane& lane,
    const TempoMap* tempoMap,
    int64_t blockStartSample,
    int numSamples,
    double sampleRate,
    float* outputBuffer,
    size_t& cursor,
    float defaultValue) noexcept {
    if (outputBuffer == nullptr || numSamples <= 0)
        return;

    if (!lane.enabled || lane.muted || lane.points.empty()) {
        std::fill_n(outputBuffer, numSamples, defaultValue);
        return;
    }

    if (lane.points.size() == 1) {
        std::fill_n(outputBuffer, numSamples, lane.points.front().value);
        return;
    }

    const double safeRate = sampleRate > 0.0 ? sampleRate : 48000.0;
    const double invSampleRate = 1.0 / safeRate;

    for (int i = 0; i < numSamples; ++i) {
        const int64_t sampleIdx = blockStartSample + i;
        double beat = 0.0;
        if (tempoMap != nullptr) {
            beat = tempoMap->samplesToBeats(sampleIdx, safeRate);
        } else {
            const double sec = static_cast<double>(sampleIdx) * invSampleRate;
            beat = sec * 2.0; // fallback 120 bpm = 2 beats/sec
        }
        outputBuffer[i] = evaluatePointsWithCursor(lane.points, beat, cursor, defaultValue);
    }
}

float AutomationEvaluator::resolveMultiScopeValue(
    const SongDef& song,
    const AutomationTarget& target,
    double songPlayheadBeats,
    double songPlayheadSeconds,
    std::optional<std::string_view> trackId,
    const TempoMap* tempoMap) noexcept {
    float effectiveValue = target.defaultValue;

    // 1. Base TrackAutomation on song timeline
    for (const auto& lane : song.automationLanes) {
        if (!lane.enabled || lane.muted || lane.scope != AutomationScope::Track)
            continue;
        if (lane.target.domain == target.domain &&
            lane.target.entityId == target.entityId &&
            lane.target.parameterId == target.parameterId) {
            effectiveValue = evaluatePoints(lane.points, songPlayheadBeats, target.defaultValue);
            break;
        }
    }

    // 2. RegionAutomation & RegionModulation on active regions
    if (trackId.has_value()) {
        // Check active MIDI regions
        for (const auto& mr : song.midiRegions) {
            if (mr.trackId != *trackId || mr.muted)
                continue;
            const double regionStart = mr.startBeats;
            const double regionEnd = mr.startBeats + mr.durationBeats;
            if (songPlayheadBeats >= regionStart && songPlayheadBeats < regionEnd) {
                double relBeats = songPlayheadBeats - regionStart + mr.clipOffsetBeats;
                if (mr.loop && mr.loopLengthBeats > 0.0) {
                    relBeats = std::fmod(relBeats, mr.loopLengthBeats);
                }

                // Check for region-level override
                for (const auto& rLane : mr.automationLanes) {
                    if (!rLane.enabled || rLane.muted)
                        continue;
                    if (rLane.target.domain == target.domain &&
                        rLane.target.entityId == target.entityId &&
                        rLane.target.parameterId == target.parameterId) {
                        if (rLane.scope == AutomationScope::Region) {
                            effectiveValue = evaluatePoints(rLane.points, relBeats, effectiveValue);
                        } else if (rLane.scope == AutomationScope::Modulation) {
                            const float delta = evaluatePoints(rLane.points, relBeats, 0.0f);
                            effectiveValue += delta;
                        }
                    }
                }
            }
        }

        // Check active audio regions
        for (const auto& r : song.regions) {
            if (r.trackId != *trackId)
                continue;
            const double rStartSec = r.startSeconds;
            const double rEndSec = r.startSeconds + r.durationSeconds;
            if (songPlayheadSeconds >= rStartSec && songPlayheadSeconds < rEndSec) {
                double relSec = songPlayheadSeconds - rStartSec + r.source.offsetSeconds;
                if (r.loop.enabled && r.loop.lengthSeconds > 0.0) {
                    relSec = std::fmod(relSec, r.loop.lengthSeconds);
                }

                double relBeats = relSec * 2.0; // fallback 120 bpm
                if (tempoMap != nullptr) {
                    const double rStartBeats = tempoMap->secondsToBeats(rStartSec);
                    const double playheadBeatsFromSec = tempoMap->secondsToBeats(songPlayheadSeconds);
                    relBeats = playheadBeatsFromSec - rStartBeats;
                }

                for (const auto& rLane : r.automationLanes) {
                    if (!rLane.enabled || rLane.muted)
                        continue;
                    if (rLane.target.domain == target.domain &&
                        rLane.target.entityId == target.entityId &&
                        rLane.target.parameterId == target.parameterId) {
                        if (rLane.scope == AutomationScope::Region) {
                            effectiveValue = evaluatePoints(rLane.points, relBeats, effectiveValue);
                        } else if (rLane.scope == AutomationScope::Modulation) {
                            const float delta = evaluatePoints(rLane.points, relBeats, 0.0f);
                            effectiveValue += delta;
                        }
                    }
                }
            }
        }
    }

    const float minV = std::min(target.minValue, target.maxValue);
    const float maxV = std::max(target.minValue, target.maxValue);
    if (std::isfinite(effectiveValue)) {
        return std::clamp(effectiveValue, minV, maxV);
    }
    return target.defaultValue;
}

} // namespace resostage
