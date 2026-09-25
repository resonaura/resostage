#pragma once

#include <algorithm>
#include <cmath>

namespace resostage {

/**
 * Standard curvature interpolation for ResoStage automation envelopes and fades.
 *
 * Curvature parameter in [-1.0, +1.0]:
 *   -1.0 = highly concave (exponential ease-in)
 *    0.0 = linear
 *   +1.0 = highly convex (logarithmic ease-out)
 *
 * Formula: w = t^(2^(-curve * 2))
 */
class AutomationCurve {
public:
    [[nodiscard]] static double interpolate(double t01, double v0, double v1, double curve) noexcept {
        if (!std::isfinite(t01) || t01 <= 0.0)
            return std::isfinite(v0) ? v0 : 0.0;
        if (t01 >= 1.0)
            return std::isfinite(v1) ? v1 : 0.0;
        if (!std::isfinite(v0) || !std::isfinite(v1))
            return std::isfinite(v0) ? v0 : (std::isfinite(v1) ? v1 : 0.0);

        const double c = std::clamp(std::isfinite(curve) ? curve : 0.0, -1.0, 1.0);
        if (std::abs(c) < 1.0e-6)
            return v0 + t01 * (v1 - v0);
        const double exp = std::pow(2.0, -c * 2.0);
        const double w = std::pow(t01, exp);
        return v0 + w * (v1 - v0);
    }

    [[nodiscard]] static float interpolateFloat(float t01, float v0, float v1, float curve) noexcept {
        return static_cast<float>(interpolate(static_cast<double>(t01),
                                              static_cast<double>(v0),
                                              static_cast<double>(v1),
                                              static_cast<double>(curve)));
    }
};

} // namespace resostage
