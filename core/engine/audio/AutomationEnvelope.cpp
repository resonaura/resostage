#include "AutomationEnvelope.h"
#include "automation/AutomationCurve.h"

namespace resostage {

AutomationEnvelope::AutomationEnvelope(std::string idIn,
                                       AutomationTargetType targetTypeIn,
                                       std::string targetIdIn)
    : id(std::move(idIn)),
      targetType(targetTypeIn),
      targetId(std::move(targetIdIn)) {}

void AutomationEnvelope::addPoint(double timeSeconds, double value, double curve) {
    EnvelopePoint pt{timeSeconds, value, std::clamp(curve, -1.0, 1.0)};
    auto it = std::lower_bound(points.begin(), points.end(), pt);
    if (it != points.end() && std::abs(it->timeSeconds - timeSeconds) < 1.0e-9) {
        it->value = value;
        it->curve = pt.curve;
    } else {
        points.insert(it, pt);
    }
}

bool AutomationEnvelope::removePoint(size_t index) noexcept {
    if (index >= points.size())
        return false;
    points.erase(points.begin() + static_cast<std::ptrdiff_t>(index));
    return true;
}

void AutomationEnvelope::setPoints(std::vector<EnvelopePoint> newPoints) {
    points = std::move(newPoints);
    for (auto& pt : points)
        pt.curve = std::clamp(pt.curve, -1.0, 1.0);
    std::sort(points.begin(), points.end());
}

double AutomationEnvelope::interpolate(double t01, double v0, double v1, double curve) noexcept {
    return AutomationCurve::interpolate(t01, v0, v1, curve);
}

double AutomationEnvelope::evaluateAt(double timeSeconds, double defaultValue) const noexcept {
    if (points.empty())
        return defaultValue;
    if (points.size() == 1 || timeSeconds <= points.front().timeSeconds)
        return points.front().value;
    if (timeSeconds >= points.back().timeSeconds)
        return points.back().value;

    EnvelopePoint target{timeSeconds, 0.0, 0.0};
    auto it = std::upper_bound(points.begin(), points.end(), target);
    if (it == points.end())
        return points.back().value;

    const auto prev = it - 1;
    const double span = it->timeSeconds - prev->timeSeconds;
    if (span <= 1.0e-9)
        return it->value;

    const double tau = (timeSeconds - prev->timeSeconds) / span;
    return interpolate(tau, prev->value, it->value, prev->curve);
}

void AutomationEnvelope::evaluateBlock(double startTimeSeconds, double sampleRate,
                                       float* output, int numSamples,
                                       size_t& cursor, double defaultValue) const noexcept {
    if (output == nullptr || numSamples <= 0)
        return;

    if (points.empty()) {
        std::fill_n(output, numSamples, static_cast<float>(defaultValue));
        return;
    }

    if (points.size() == 1) {
        std::fill_n(output, numSamples, static_cast<float>(points.front().value));
        return;
    }

    const double invSampleRate = 1.0 / (sampleRate > 0.0 ? sampleRate : 48000.0);
    const size_t maxIndex = points.size() - 1;

    if (cursor >= maxIndex)
        cursor = 0;

    for (int i = 0; i < numSamples; ++i) {
        const double t = startTimeSeconds + (static_cast<double>(i) * invSampleRate);

        if (t <= points.front().timeSeconds) {
            output[i] = static_cast<float>(points.front().value);
            cursor = 0;
            continue;
        }

        if (t >= points.back().timeSeconds) {
            output[i] = static_cast<float>(points.back().value);
            cursor = maxIndex - 1;
            continue;
        }

        // If time backed up behind cursor, reset search
        if (t < points[cursor].timeSeconds)
            cursor = 0;

        // Advance cursor forward
        while (cursor + 1 < points.size() && t > points[cursor + 1].timeSeconds)
            ++cursor;

        if (cursor >= maxIndex)
            cursor = maxIndex - 1;

        const auto& p0 = points[cursor];
        const auto& p1 = points[cursor + 1];
        const double span = p1.timeSeconds - p0.timeSeconds;

        if (span <= 1.0e-9) {
            output[i] = static_cast<float>(p1.value);
        } else {
            const double tau = (t - p0.timeSeconds) / span;
            output[i] = static_cast<float>(interpolate(tau, p0.value, p1.value, p0.curve));
        }
    }
}

void AutomationEnvelope::applyGainBlock(double startTimeSeconds, double sampleRate,
                                       float* bufferL, float* bufferR, int numSamples,
                                       size_t& cursor, double defaultValue) const noexcept {
    if (numSamples <= 0 || (bufferL == nullptr && bufferR == nullptr))
        return;

    if (points.empty()) {
        const float defaultGain = static_cast<float>(defaultValue);
        if (bufferL != nullptr)
            for (int i = 0; i < numSamples; ++i) bufferL[i] *= defaultGain;
        if (bufferR != nullptr)
            for (int i = 0; i < numSamples; ++i) bufferR[i] *= defaultGain;
        return;
    }

    if (points.size() == 1) {
        const float fixedGain = static_cast<float>(points.front().value);
        if (bufferL != nullptr)
            for (int i = 0; i < numSamples; ++i) bufferL[i] *= fixedGain;
        if (bufferR != nullptr)
            for (int i = 0; i < numSamples; ++i) bufferR[i] *= fixedGain;
        return;
    }

    const double invSampleRate = 1.0 / (sampleRate > 0.0 ? sampleRate : 48000.0);
    const size_t maxIndex = points.size() - 1;

    if (cursor >= maxIndex)
        cursor = 0;

    for (int i = 0; i < numSamples; ++i) {
        const double t = startTimeSeconds + (static_cast<double>(i) * invSampleRate);
        float gain = 0.0f;

        if (t <= points.front().timeSeconds) {
            gain = static_cast<float>(points.front().value);
            cursor = 0;
        } else if (t >= points.back().timeSeconds) {
            gain = static_cast<float>(points.back().value);
            cursor = maxIndex - 1;
        } else {
            if (t < points[cursor].timeSeconds)
                cursor = 0;

            while (cursor + 1 < points.size() && t > points[cursor + 1].timeSeconds)
                ++cursor;

            if (cursor >= maxIndex)
                cursor = maxIndex - 1;

            const auto& p0 = points[cursor];
            const auto& p1 = points[cursor + 1];
            const double span = p1.timeSeconds - p0.timeSeconds;

            if (span <= 1.0e-9) {
                gain = static_cast<float>(p1.value);
            } else {
                const double tau = (t - p0.timeSeconds) / span;
                gain = static_cast<float>(interpolate(tau, p0.value, p1.value, p0.curve));
            }
        }

        if (bufferL != nullptr) bufferL[i] *= gain;
        if (bufferR != nullptr) bufferR[i] *= gain;
    }
}

} // namespace resostage
