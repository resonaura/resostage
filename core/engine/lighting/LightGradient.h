#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace resostage {

struct GradientStop {
    uint8_t r = 0, g = 0, b = 0;
};

// Parses "#RRGGBB,#RRGGBB,..." (any number of stops, whitespace around each
// token trimmed). A malformed individual token is skipped rather than
// aborting the whole parse -- one typo shouldn't blank the entire palette.
// Fewer than two valid stops (empty string, one stop, all-malformed) falls
// back to `fallback` -- a single-color "palette" isn't a gradient.
inline std::vector<GradientStop> parseGradientStops(const std::string& csv,
                                                      const std::vector<GradientStop>& fallback) {
    std::vector<GradientStop> stops;
    size_t pos = 0;
    while (pos <= csv.size()) {
        const size_t comma = csv.find(',', pos);
        std::string token = csv.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
        const size_t a = token.find_first_not_of(" \t");
        if (a != std::string::npos) {
            const size_t b = token.find_last_not_of(" \t");
            token = token.substr(a, b - a + 1);
            if (token.size() == 7 && token[0] == '#') {
                const auto hexDigit = [&](size_t i) -> int {
                    const char c = token[i];
                    if (c >= '0' && c <= '9') return c - '0';
                    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                    return -1;
                };
                int vals[6];
                bool ok = true;
                for (int i = 0; i < 6 && ok; ++i) {
                    vals[i] = hexDigit(static_cast<size_t>(1 + i));
                    ok = vals[i] >= 0;
                }
                if (ok) {
                    GradientStop s;
                    s.r = static_cast<uint8_t>(vals[0] * 16 + vals[1]);
                    s.g = static_cast<uint8_t>(vals[2] * 16 + vals[3]);
                    s.b = static_cast<uint8_t>(vals[4] * 16 + vals[5]);
                    stops.push_back(s);
                }
            }
        }
        if (comma == std::string::npos) break;
        pos = comma + 1;
    }
    if (stops.size() < 2) return fallback;
    return stops;
}

// Linearly-interpolated color at position `t` (0..1, clamped) across
// `stops`. A one-stop palette samples as a solid fill; an empty one is
// black -- callers that need a defensive fallback should check for that
// before calling, same as everywhere else in this codebase that treats "no
// data" as silence/off rather than inventing a default color.
inline void sampleGradient(const std::vector<GradientStop>& stops, double t,
                            uint8_t& r, uint8_t& g, uint8_t& b) {
    if (stops.empty()) { r = g = b = 0; return; }
    if (stops.size() == 1) { r = stops[0].r; g = stops[0].g; b = stops[0].b; return; }
    t = std::clamp(t, 0.0, 1.0);
    const double scaled = t * static_cast<double>(stops.size() - 1);
    const size_t i0 = static_cast<size_t>(std::floor(scaled));
    const size_t i1 = std::min(stops.size() - 1, i0 + 1);
    const double f = scaled - static_cast<double>(i0);
    r = static_cast<uint8_t>(std::lround(stops[i0].r + (static_cast<double>(stops[i1].r) - stops[i0].r) * f));
    g = static_cast<uint8_t>(std::lround(stops[i0].g + (static_cast<double>(stops[i1].g) - stops[i0].g) * f));
    b = static_cast<uint8_t>(std::lround(stops[i0].b + (static_cast<double>(stops[i1].b) - stops[i0].b) * f));
}

// Built-in named fire/plasma palettes (concert-lighting research doc's
// palette catalogue) -- selectable without authoring custom stops, and the
// fallback a "custom" preset uses if its typed stops don't parse.
inline const std::vector<GradientStop>& builtinPalette(const std::string& name) {
    // Classic Vulcan Flame: black -> deep red -> orange -> yellow -> white.
    static const std::vector<GradientStop> kVulcan = {
        {0, 0, 0}, {120, 0, 0}, {255, 90, 0}, {255, 200, 40}, {255, 255, 220},
    };
    // Toxic Alien Fire: black -> dark green -> electric neon green -> white.
    static const std::vector<GradientStop> kToxic = {
        {0, 0, 0}, {10, 60, 10}, {40, 220, 60}, {190, 255, 120}, {255, 255, 255},
    };
    // Cryo Ice Fire: black -> navy -> cyan -> white.
    static const std::vector<GradientStop> kCryo = {
        {0, 0, 0}, {10, 20, 60}, {20, 110, 200}, {100, 220, 255}, {255, 255, 255},
    };
    // Cyberpunk Synthwave Fire: deep purple -> neon magenta -> bright cyan.
    static const std::vector<GradientStop> kCyberpunk = {
        {10, 0, 20}, {80, 0, 120}, {220, 0, 200}, {0, 220, 255}, {255, 255, 255},
    };
    if (name == "toxicFire") return kToxic;
    if (name == "cryoFire") return kCryo;
    if (name == "cyberpunkFire") return kCyberpunk;
    return kVulcan;
}

} // namespace resostage
