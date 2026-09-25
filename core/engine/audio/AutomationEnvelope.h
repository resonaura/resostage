#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <string>
#include <vector>

namespace resostage {

struct EnvelopePoint {
    double timeSeconds = 0.0;
    double value = 0.0;
    // Curvature in [-1.0, +1.0]: 0 = linear.
    // Positive = ease-out, negative = ease-in.
    // Formula matches RegionFade: pow(t, 2^(-curve * 2))
    double curve = 0.0;

    bool operator<(const EnvelopePoint& other) const noexcept {
        return timeSeconds < other.timeSeconds;
    }
};

enum class AutomationTargetType {
    Volume,
    Pan,
    SendGain,
    PluginParameter,
};

class AutomationEnvelope {
public:
    AutomationEnvelope() = default;
    explicit AutomationEnvelope(std::string idIn,
                                AutomationTargetType targetTypeIn = AutomationTargetType::Volume,
                                std::string targetIdIn = "");

    const std::string& getId() const noexcept { return id; }
    AutomationTargetType getTargetType() const noexcept { return targetType; }
    const std::string& getTargetId() const noexcept { return targetId; }

    bool isEnabled() const noexcept { return enabled; }
    void setEnabled(bool e) noexcept { enabled = e; }

    const std::vector<EnvelopePoint>& getPoints() const noexcept { return points; }
    bool empty() const noexcept { return points.empty(); }
    size_t size() const noexcept { return points.size(); }

    void clear() noexcept { points.clear(); }
    void addPoint(double timeSeconds, double value, double curve = 0.0);
    bool removePoint(size_t index) noexcept;
    void setPoints(std::vector<EnvelopePoint> newPoints);

    // Single-point evaluation at an arbitrary time position.
    // defaultValue is returned if the envelope has no points.
    double evaluateAt(double timeSeconds, double defaultValue = 0.0) const noexcept;

    // Real-time audio block evaluation without allocations.
    // startTimeSeconds is the time at sample index 0 of the block.
    // output receives the evaluated values for numSamples.
    // cursor is maintained across consecutive blocks to achieve O(1) amortized cost per sample.
    void evaluateBlock(double startTimeSeconds, double sampleRate,
                       float* output, int numSamples,
                       size_t& cursor, double defaultValue = 0.0) const noexcept;

    // In-place multiply audio buffer by envelope gain (common for volume automation).
    void applyGainBlock(double startTimeSeconds, double sampleRate,
                        float* bufferL, float* bufferR, int numSamples,
                        size_t& cursor, double defaultValue = 1.0) const noexcept;

    // Mathematical curve calculation helper.
    static double interpolate(double t01, double v0, double v1, double curve) noexcept;

private:
    std::string id;
    AutomationTargetType targetType = AutomationTargetType::Volume;
    std::string targetId;
    bool enabled = true;
    std::vector<EnvelopePoint> points;
};

} // namespace resostage
