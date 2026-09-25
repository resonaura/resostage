#pragma once

#include "project/ProjectSchema.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace resostage {

/**
 * High-performance, immutable snapshot for musical tempo mapping.
 *
 * Provides O(log N) binary search for multi-point tempo maps with constant
 * O(1) fast paths when tempo is uniform. Supports both instant step tempo
 * changes and smooth linear BPM ramps. Zero allocations during queries.
 */
class TempoMap {
public:
    explicit TempoMap(double fallbackBpm = 120.0, std::vector<TempoPoint> points = {}) {
        setPoints(fallbackBpm, std::move(points));
    }

    void setPoints(double fallbackBpm, std::vector<TempoPoint> points) {
        fallbackBpm_ = (fallbackBpm > 0.0 && std::isfinite(fallbackBpm)) ? std::clamp(fallbackBpm, 1.0, 1000.0) : 120.0;

        std::vector<TempoPoint> validPoints;
        validPoints.reserve(points.size() + 1);
        for (auto& pt : points) {
            if (!std::isfinite(pt.beat) || !std::isfinite(pt.bpm))
                continue;
            pt.bpm = std::clamp(pt.bpm, 1.0, 1000.0);
            if (!std::isfinite(pt.curve))
                pt.curve = 0.0;
            validPoints.push_back(pt);
        }
        points_ = std::move(validPoints);

        if (points_.empty()) {
            TempoPoint root;
            root.beat = 0.0;
            root.bpm = fallbackBpm_;
            root.timeSeconds = 0.0;
            root.curve = 0.0;
            points_.push_back(root);
        } else {
            // Sort by beat position
            std::stable_sort(points_.begin(), points_.end(), [](const TempoPoint& a, const TempoPoint& b) {
                return a.beat < b.beat;
            });

            // Ensure first point starts at beat <= 0.0
            if (points_.front().beat > 0.0) {
                TempoPoint root;
                root.beat = 0.0;
                root.bpm = fallbackBpm_;
                root.timeSeconds = 0.0;
                root.curve = 0.0;
                points_.insert(points_.begin(), root);
            }
        }

        computeTimeSeconds();
    }

    [[nodiscard]] const std::vector<TempoPoint>& points() const noexcept {
        return points_;
    }

    [[nodiscard]] double fallbackBpm() const noexcept {
        return fallbackBpm_;
    }

    [[nodiscard]] double beatsToSeconds(double beat) const noexcept {
        if (!std::isfinite(beat))
            return 0.0;

        if (points_.size() == 1) {
            const double deltaBeats = beat - points_[0].beat;
            return points_[0].timeSeconds + (deltaBeats * 60.0 / points_[0].bpm);
        }

        if (beat <= points_.front().beat) {
            const double deltaBeats = beat - points_.front().beat;
            return points_.front().timeSeconds + (deltaBeats * 60.0 / points_.front().bpm);
        }

        const size_t idx = findPointIndexForBeat(beat);
        const auto& p1 = points_[idx];

        if (idx == points_.size() - 1 || std::abs(p1.curve) < 1e-9) {
            // Step tempo or past end
            const double deltaBeats = beat - p1.beat;
            return p1.timeSeconds + (deltaBeats * 60.0 / p1.bpm);
        }

        // Linear BPM ramp
        const auto& p2 = points_[idx + 1];
        const double deltaBeats = beat - p1.beat;
        const double spanBeats = p2.beat - p1.beat;
        const double deltaBpm = p2.bpm - p1.bpm;

        if (spanBeats <= 1e-9 || std::abs(deltaBpm) < 1e-9) {
            return p1.timeSeconds + (deltaBeats * 60.0 / p1.bpm);
        }

        const double k = deltaBpm / spanBeats;
        const double ratio = 1.0 + (k * deltaBeats / p1.bpm);
        if (ratio <= 1e-9 || !std::isfinite(ratio))
            return p1.timeSeconds;

        const double logVal = std::log(ratio);
        if (!std::isfinite(logVal))
            return p1.timeSeconds + (deltaBeats * 60.0 / p1.bpm);

        return p1.timeSeconds + (60.0 / k) * logVal;
    }

    [[nodiscard]] double secondsToBeats(double seconds) const noexcept {
        if (!std::isfinite(seconds))
            return 0.0;

        if (points_.size() == 1) {
            const double deltaSeconds = seconds - points_[0].timeSeconds;
            return points_[0].beat + (deltaSeconds * points_[0].bpm / 60.0);
        }

        if (seconds <= points_.front().timeSeconds) {
            const double deltaSeconds = seconds - points_.front().timeSeconds;
            return points_.front().beat + (deltaSeconds * points_.front().bpm / 60.0);
        }

        const size_t idx = findPointIndexForSeconds(seconds);
        const auto& p1 = points_[idx];

        if (idx == points_.size() - 1 || std::abs(p1.curve) < 1e-9) {
            // Step tempo or past end
            const double deltaSeconds = seconds - p1.timeSeconds;
            return p1.beat + (deltaSeconds * p1.bpm / 60.0);
        }

        // Linear BPM ramp
        const auto& p2 = points_[idx + 1];
        const double deltaSeconds = seconds - p1.timeSeconds;
        const double spanBeats = p2.beat - p1.beat;
        const double deltaBpm = p2.bpm - p1.bpm;

        if (spanBeats <= 1e-9 || std::abs(deltaBpm) < 1e-9) {
            return p1.beat + (deltaSeconds * p1.bpm / 60.0);
        }

        const double k = deltaBpm / spanBeats;
        const double exponent = std::clamp(k * deltaSeconds / 60.0, -80.0, 80.0);
        const double expVal = std::exp(exponent);
        if (!std::isfinite(expVal)) {
            return p1.beat + (deltaSeconds * p1.bpm / 60.0);
        }
        const double deltaBeats = (p1.bpm / k) * (expVal - 1.0);
        if (!std::isfinite(deltaBeats)) {
            return p1.beat + (deltaSeconds * p1.bpm / 60.0);
        }
        return p1.beat + deltaBeats;
    }

    [[nodiscard]] int64_t beatsToSamples(double beat, double sampleRate) const noexcept {
        if (sampleRate <= 0.0)
            return 0;
        const double sec = beatsToSeconds(beat);
        return static_cast<int64_t>(std::llround(sec * sampleRate));
    }

    [[nodiscard]] double samplesToBeats(int64_t samples, double sampleRate) const noexcept {
        if (sampleRate <= 0.0)
            return 0.0;
        const double sec = static_cast<double>(samples) / sampleRate;
        return secondsToBeats(sec);
    }

    [[nodiscard]] double bpmAtBeat(double beat) const noexcept {
        if (!std::isfinite(beat) || points_.empty())
            return fallbackBpm_;

        if (points_.size() == 1 || beat <= points_.front().beat)
            return points_.front().bpm;

        const size_t idx = findPointIndexForBeat(beat);
        const auto& p1 = points_[idx];

        if (idx == points_.size() - 1 || std::abs(p1.curve) < 1e-9)
            return p1.bpm;

        const auto& p2 = points_[idx + 1];
        const double spanBeats = p2.beat - p1.beat;
        if (spanBeats <= 1e-9)
            return p1.bpm;

        const double frac = std::clamp((beat - p1.beat) / spanBeats, 0.0, 1.0);
        return p1.bpm + frac * (p2.bpm - p1.bpm);
    }

    [[nodiscard]] double bpmAtSeconds(double seconds) const noexcept {
        const double beat = secondsToBeats(seconds);
        return bpmAtBeat(beat);
    }

private:
    void computeTimeSeconds() {
        if (points_.empty())
            return;

        points_[0].timeSeconds = 0.0;
        for (size_t i = 0; i + 1 < points_.size(); ++i) {
            const auto& p1 = points_[i];
            auto& p2 = points_[i + 1];

            const double spanBeats = std::max(0.0, p2.beat - p1.beat);
            if (spanBeats <= 1e-9) {
                p2.timeSeconds = p1.timeSeconds;
                continue;
            }

            if (std::abs(p1.curve) < 1e-9) {
                // Step
                p2.timeSeconds = p1.timeSeconds + (spanBeats * 60.0 / p1.bpm);
            } else {
                // Ramp
                const double deltaBpm = p2.bpm - p1.bpm;
                if (std::abs(deltaBpm) < 1e-9) {
                    p2.timeSeconds = p1.timeSeconds + (spanBeats * 60.0 / p1.bpm);
                } else {
                    const double k = deltaBpm / spanBeats;
                    const double ratio = p2.bpm / p1.bpm;
                    if (ratio > 1e-9) {
                        p2.timeSeconds = p1.timeSeconds + (60.0 / k) * std::log(ratio);
                    } else {
                        p2.timeSeconds = p1.timeSeconds + (spanBeats * 60.0 / p1.bpm);
                    }
                }
            }
        }
    }

    [[nodiscard]] size_t findPointIndexForBeat(double beat) const noexcept {
        // Find first element whose beat is strictly greater than `beat`
        auto it = std::upper_bound(points_.begin(), points_.end(), beat,
                                   [](double b, const TempoPoint& pt) {
                                       return b < pt.beat;
                                   });
        if (it == points_.begin())
            return 0;
        return static_cast<size_t>(std::distance(points_.begin(), it) - 1);
    }

    [[nodiscard]] size_t findPointIndexForSeconds(double seconds) const noexcept {
        auto it = std::upper_bound(points_.begin(), points_.end(), seconds,
                                   [](double s, const TempoPoint& pt) {
                                       return s < pt.timeSeconds;
                                   });
        if (it == points_.begin())
            return 0;
        return static_cast<size_t>(std::distance(points_.begin(), it) - 1);
    }

    double fallbackBpm_ = 120.0;
    std::vector<TempoPoint> points_;
};

/**
 * High-performance, immutable snapshot for musical time signature mapping.
 *
 * Translates between continuous musical beats and human-readable Bar/Beat
 * coordinates (e.g. Bar 5, Beat 3.25) across time signature changes.
 */
class SignatureMap {
public:
    explicit SignatureMap(int defaultNumerator = 4, int defaultDenominator = 4,
                          std::vector<SignaturePoint> points = {}) {
        setPoints(defaultNumerator, defaultDenominator, std::move(points));
    }

    void setPoints(int defaultNumerator, int defaultDenominator, std::vector<SignaturePoint> points) {
        defaultNumerator_ = defaultNumerator > 0 ? defaultNumerator : 4;
        defaultDenominator_ = defaultDenominator > 0 ? defaultDenominator : 4;
        points_ = std::move(points);

        if (points_.empty()) {
            SignaturePoint root;
            root.beat = 0.0;
            root.numerator = defaultNumerator_;
            root.denominator = defaultDenominator_;
            root.bar = 1;
            points_.push_back(root);
        } else {
            std::sort(points_.begin(), points_.end(), [](const SignaturePoint& a, const SignaturePoint& b) {
                return a.beat < b.beat;
            });

            if (points_.front().beat > 0.0) {
                SignaturePoint root;
                root.beat = 0.0;
                root.numerator = defaultNumerator_;
                root.denominator = defaultDenominator_;
                root.bar = 1;
                points_.insert(points_.begin(), root);
            }
        }

        computeBars();
    }

    [[nodiscard]] const std::vector<SignaturePoint>& points() const noexcept {
        return points_;
    }

    [[nodiscard]] TimeSignature signatureAtBeat(double beat) const noexcept {
        if (points_.empty())
            return {defaultNumerator_, defaultDenominator_};

        const size_t idx = findPointIndexForBeat(beat);
        return {points_[idx].numerator, points_[idx].denominator};
    }

    [[nodiscard]] TimeSignature signatureAtBar(int bar) const noexcept {
        if (points_.empty())
            return {defaultNumerator_, defaultDenominator_};

        const size_t idx = findPointIndexForBar(bar);
        return {points_[idx].numerator, points_[idx].denominator};
    }

    void beatToBarBeat(double beat, int& outBar, double& outBeatInBar) const noexcept {
        if (!std::isfinite(beat)) {
            outBar = 1;
            outBeatInBar = 1.0;
            return;
        }

        const size_t idx = findPointIndexForBeat(beat);
        const auto& pt = points_[idx];

        const double beatsPerBar = pt.numerator * (4.0 / pt.denominator);
        const double deltaBeats = beat - pt.beat;

        if (beatsPerBar <= 1e-9) {
            outBar = pt.bar;
            outBeatInBar = 1.0;
            return;
        }

        const double barsElapsed = std::floor(deltaBeats / beatsPerBar);
        outBar = pt.bar + static_cast<int>(barsElapsed);
        outBeatInBar = 1.0 + (deltaBeats - barsElapsed * beatsPerBar);
    }

    [[nodiscard]] double barBeatToBeats(int bar, double beatInBar) const noexcept {
        if (points_.empty())
            return 0.0;

        const size_t idx = findPointIndexForBar(bar);
        const auto& pt = points_[idx];

        const double beatsPerBar = pt.numerator * (4.0 / pt.denominator);
        const int deltaBars = bar - pt.bar;

        return pt.beat + deltaBars * beatsPerBar + (beatInBar - 1.0);
    }

private:
    void computeBars() {
        if (points_.empty())
            return;

        points_[0].bar = 1;
        for (size_t i = 0; i + 1 < points_.size(); ++i) {
            const auto& p1 = points_[i];
            auto& p2 = points_[i + 1];

            const double beatsPerBar = p1.numerator * (4.0 / p1.denominator);
            const double deltaBeats = std::max(0.0, p2.beat - p1.beat);
            const int deltaBars = static_cast<int>(std::round(deltaBeats / beatsPerBar));
            p2.bar = p1.bar + deltaBars;
        }
    }

    [[nodiscard]] size_t findPointIndexForBeat(double beat) const noexcept {
        auto it = std::upper_bound(points_.begin(), points_.end(), beat,
                                   [](double b, const SignaturePoint& pt) {
                                       return b < pt.beat;
                                   });
        if (it == points_.begin())
            return 0;
        return static_cast<size_t>(std::distance(points_.begin(), it) - 1);
    }

    [[nodiscard]] size_t findPointIndexForBar(int bar) const noexcept {
        auto it = std::upper_bound(points_.begin(), points_.end(), bar,
                                   [](int b, const SignaturePoint& pt) {
                                       return b < pt.bar;
                                   });
        if (it == points_.begin())
            return 0;
        return static_cast<size_t>(std::distance(points_.begin(), it) - 1);
    }

    int defaultNumerator_ = 4;
    int defaultDenominator_ = 4;
    std::vector<SignaturePoint> points_;
};

} // namespace resostage
