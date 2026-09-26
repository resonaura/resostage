#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace resostage {

enum class TakeoverMode : uint8_t {
    Jump = 0,
    Pickup = 1,
    ValueScaling = 2
};

enum class RelativeEncoding : uint8_t {
    TwosComplement7 = 0,
    BinaryOffset = 1,
    SignedBit = 2
};

/**
 * Audio console fader law mapping normalized [0.0, 1.0] controller positions
 * to decibels and linear gain with standard DAW unity positioning (0 dB at 0.80).
 */
struct FaderLaw {
    static constexpr float kUnityPosition = 0.80f;
    static constexpr float kMinDb = -80.0f;
    static constexpr float kMaxDb = 12.0f;

    // Normalized controller position [0.0, 1.0] -> Decibels [-inf, +12dB]
    [[nodiscard]] static float positionToDb(float x) noexcept {
        if (x <= 0.0001f)
            return -1000.0f; // -inf
        if (x <= kUnityPosition) {
            const float norm = x / kUnityPosition;
            // cubic taper: (x/xu)^3
            const float amp = norm * norm * norm;
            if (amp <= 0.0001f)
                return kMinDb;
            const float db = 20.0f * std::log10(amp);
            return std::max(kMinDb, db);
        }
        // x in (0.8, 1.0] -> 0 to +12 dB
        const float t = (x - kUnityPosition) / (1.0f - kUnityPosition);
        return t * kMaxDb;
    }

    // Normalized controller position [0.0, 1.0] -> Linear Gain [0.0, ~3.98]
    [[nodiscard]] static float positionToGain(float x) noexcept {
        if (x <= 0.0001f)
            return 0.0f;
        const float db = positionToDb(x);
        if (db <= -79.9f)
            return 0.0f;
        return std::pow(10.0f, db / 20.0f);
    }

    // Decibels [-inf, +12dB] -> Normalized controller position [0.0, 1.0]
    [[nodiscard]] static float dbToPosition(float db) noexcept {
        if (db <= kMinDb)
            return 0.0f;
        if (db <= 0.0f) {
            // db = 20 * log10((x / 0.8)^3) = 60 * log10(x / 0.8)
            // x / 0.8 = 10^(db / 60)
            const float norm = std::pow(10.0f, db / 60.0f);
            return std::clamp(norm * kUnityPosition, 0.0f, kUnityPosition);
        }
        // db in (0, 12]
        const float t = std::clamp(db / kMaxDb, 0.0f, 1.0f);
        return kUnityPosition + t * (1.0f - kUnityPosition);
    }
};

/**
 * Logarithmic frequency mapping for musical filter and synthesizer parameters.
 */
struct FrequencyScale {
    static constexpr float kMinFreq = 20.0f;
    static constexpr float kMaxFreq = 20000.0f;

    // Normalized [0.0, 1.0] -> Frequency in Hz (20Hz to 20kHz logarithmic)
    [[nodiscard]] static float positionToHz(float x) noexcept {
        const float clamped = std::clamp(x, 0.0f, 1.0f);
        return kMinFreq * std::pow(kMaxFreq / kMinFreq, clamped);
    }

    // Frequency in Hz -> Normalized [0.0, 1.0]
    [[nodiscard]] static float hzToPosition(float hz) noexcept {
        if (hz <= kMinFreq) return 0.0f;
        if (hz >= kMaxFreq) return 1.0f;
        return std::log(hz / kMinFreq) / std::log(kMaxFreq / kMinFreq);
    }
};

/**
 * Controller takeover state machine supporting Jump, Soft Takeover (Pickup), and Value Scaling.
 */
struct ControllerTakeoverState {
    TakeoverMode mode = TakeoverMode::Jump;
    bool latched = false;
    float previousHardware = 0.0f;
    bool hasPrevious = false;

    // Processes incoming hardware position and returns the new parameter value.
    float process(float incomingHardware, float currentTarget, float tolerance = 0.03f) noexcept {
        incomingHardware = std::clamp(incomingHardware, 0.0f, 1.0f);
        currentTarget = std::clamp(currentTarget, 0.0f, 1.0f);

        if (mode == TakeoverMode::Jump) {
            latched = true;
            previousHardware = incomingHardware;
            hasPrevious = true;
            return incomingHardware;
        }

        if (mode == TakeoverMode::Pickup) {
            if (!latched) {
                if (!hasPrevious) {
                    previousHardware = incomingHardware;
                    hasPrevious = true;
                    if (std::abs(incomingHardware - currentTarget) <= tolerance) {
                        latched = true;
                        return incomingHardware;
                    }
                    return currentTarget;
                }
                // Crossing test: target is between previous and current
                const float lo = std::min(previousHardware, incomingHardware) - tolerance;
                const float hi = std::max(previousHardware, incomingHardware) + tolerance;
                if (currentTarget >= lo && currentTarget <= hi) {
                    latched = true;
                }
            }
            previousHardware = incomingHardware;
            if (latched) {
                return incomingHardware;
            }
            return currentTarget;
        }

        // ValueScaling: smoothly converge towards hardware value
        if (mode == TakeoverMode::ValueScaling) {
            if (!latched) {
                if (std::abs(incomingHardware - currentTarget) <= tolerance) {
                    latched = true;
                    previousHardware = incomingHardware;
                    hasPrevious = true;
                    return incomingHardware;
                }
                if (!hasPrevious) {
                    previousHardware = incomingHardware;
                    hasPrevious = true;
                    return currentTarget;
                }
                const float hwDelta = incomingHardware - previousHardware;
                previousHardware = incomingHardware;
                float distance = incomingHardware - currentTarget;
                float step = hwDelta * (1.0f + std::abs(distance) * 0.5f);
                float newTarget = std::clamp(currentTarget + step, 0.0f, 1.0f);
                if (std::abs(newTarget - incomingHardware) <= tolerance ||
                    (hwDelta > 0 && newTarget >= incomingHardware) ||
                    (hwDelta < 0 && newTarget <= incomingHardware)) {
                    latched = true;
                    return incomingHardware;
                }
                return newTarget;
            }
            previousHardware = incomingHardware;
            return incomingHardware;
        }

        return incomingHardware;
    }

    void reset() noexcept {
        latched = false;
        hasPrevious = false;
    }
};

/**
 * Decoders for rotary endless encoders.
 */
struct RelativeEncoder {
    [[nodiscard]] static int decodeTwosComplement7(uint8_t value) noexcept {
        if (value == 0 || value == 64)
            return 0;
        if (value < 64)
            return static_cast<int>(value);
        return static_cast<int>(value) - 128; // 127 -> -1, 126 -> -2, etc.
    }

    [[nodiscard]] static int decodeBinaryOffset(uint8_t value) noexcept {
        return static_cast<int>(value) - 64;
    }

    [[nodiscard]] static int decodeSignedBit(uint8_t value) noexcept {
        const int magnitude = static_cast<int>(value & 0x3F);
        const bool negative = (value & 0x40) != 0;
        return negative ? -magnitude : magnitude;
    }

    [[nodiscard]] static int decode(RelativeEncoding encoding, uint8_t value) noexcept {
        switch (encoding) {
            case RelativeEncoding::TwosComplement7: return decodeTwosComplement7(value);
            case RelativeEncoding::BinaryOffset:   return decodeBinaryOffset(value);
            case RelativeEncoding::SignedBit:      return decodeSignedBit(value);
        }
        return 0;
    }
};

} // namespace resostage
