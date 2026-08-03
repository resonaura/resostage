#pragma once

#include <juce_graphics/juce_graphics.h>

#include <array>

namespace resostage {
namespace ui {

// ---------------------------------------------------------------------------
// Theme switching. One process-wide flag (not per-window) -- this app has a
// single top-level window, so a global is simpler than threading a Theme
// value through every panel constructor. Settings panel flips it and asks
// for a repaint; everything else just calls the colour functions below,
// which read the flag internally, so no call site needs to change.
// ---------------------------------------------------------------------------
enum class Theme { Dark, Light };

inline Theme& currentThemeRef() {
    static Theme theme = Theme::Dark; // matches the app's original fixed dark look
    return theme;
}
inline Theme currentTheme() { return currentThemeRef(); }
inline void setTheme(Theme t) { currentThemeRef() = t; }
inline bool isDark() { return currentTheme() == Theme::Dark; }

// ---------------------------------------------------------------------------
// Apple HIG semantic system-color palette (standard contrast, Light/Dark).
// Values as published in Apple's Human Interface Guidelines colour tables.
// ---------------------------------------------------------------------------
enum class Accent { Red, Orange, Yellow, Green, Mint, Teal, Cyan, Blue, Indigo, Purple, Pink, Brown, Count };

inline juce::Colour accentColor(Accent a, Theme t = currentTheme()) {
    struct Pair {
        juce::uint32 light;
        juce::uint32 dark;
    };
    // Indexed by Accent; RGB packed as 0xRRGGBB.
    static constexpr Pair kTable[static_cast<size_t>(Accent::Count)] = {
        {0xFF383C, 0xFF4245}, // Red
        {0xFF8D28, 0xFF9230}, // Orange
        {0xFFCC00, 0xFFD600}, // Yellow
        {0x34C759, 0x30D158}, // Green
        {0x00C8B3, 0x00DAC3}, // Mint
        {0x00C3D0, 0x00D2E0}, // Teal
        {0x00C0E8, 0x3CD3FE}, // Cyan
        {0x0088FF, 0x0091FF}, // Blue
        {0x6155F5, 0x6D7CFF}, // Indigo
        {0xCB30E0, 0xDB34F2}, // Purple
        {0xFF2D55, 0xFF375F}, // Pink
        {0xAC7F5E, 0xB78A66}, // Brown
    };
    const auto& p = kTable[static_cast<size_t>(a)];
    return juce::Colour(t == Theme::Light ? p.light : p.dark);
}

// SystemGray1 (most opaque/darkest-on-light) .. SystemGray6 (lightest-on-light).
inline juce::Colour systemGray(int level /* 1..6 */, Theme t = currentTheme()) {
    struct Pair {
        juce::uint32 light;
        juce::uint32 dark;
    };
    static constexpr Pair kTable[6] = {
        {0x8E8E93, 0x8E8E93}, // Gray
        {0xAEAEB2, 0x636366}, // Gray2
        {0xC7C7CC, 0x48484A}, // Gray3
        {0xD1D1D6, 0x3A3A3C}, // Gray4
        {0xE5E5EA, 0x2C2C2E}, // Gray5
        {0xF2F2F7, 0x1C1C1E}, // Gray6
    };
    level = juce::jlimit(1, 6, level);
    const auto& p = kTable[level - 1];
    return juce::Colour(t == Theme::Light ? p.light : p.dark);
}

// Deterministic per-index track/bus colour, cycling through the accent set
// (skips Yellow/Brown as first picks -- poor contrast/legibility as small
// track-header swatches -- by starting the cycle at Blue and wrapping).
inline juce::Colour trackColorForIndex(int index) {
    static constexpr Accent kCycle[] = {
        Accent::Blue,  Accent::Green,  Accent::Orange, Accent::Purple, Accent::Pink,
        Accent::Teal,  Accent::Red,    Accent::Indigo, Accent::Mint,   Accent::Cyan,
        Accent::Yellow, Accent::Brown,
    };
    const size_t n = sizeof(kCycle) / sizeof(kCycle[0]);
    return accentColor(kCycle[static_cast<size_t>(index < 0 ? 0 : index) % n]);
}

// ---------------------------------------------------------------------------
// Structural colours -- theme-aware. Existing call sites (ui::text(),
// ui::panel(), etc.) are unchanged; they now just read currentTheme()
// internally instead of returning a single fixed dark value.
// ---------------------------------------------------------------------------
inline juce::Colour bg()       { return isDark() ? juce::Colour(0xff0b0d10) : juce::Colour(0xfff2f2f7); }
inline juce::Colour panel()    { return isDark() ? juce::Colour(0xff141820) : juce::Colour(0xffffffff); }
inline juce::Colour panelAlt() { return isDark() ? juce::Colour(0xff1a2230) : juce::Colour(0xffe5e5ea); }
inline juce::Colour border()   { return isDark() ? juce::Colour(0xff243041) : juce::Colour(0xffd1d1d6); }
inline juce::Colour text()     { return isDark() ? juce::Colour(0xffe8eef7) : juce::Colour(0xff1c1c1e); }
inline juce::Colour muted()    { return isDark() ? juce::Colour(0xff8b9bb0) : juce::Colour(0xff6c6c70); }
inline juce::Colour accent()   { return accentColor(Accent::Blue); }
inline juce::Colour play()     { return accentColor(Accent::Green); }
inline juce::Colour stop()     { return accentColor(Accent::Pink); }
inline juce::Colour meter()    { return accentColor(Accent::Green); }
inline juce::Colour meterBg()  { return isDark() ? juce::Colour(0xff1c2430) : juce::Colour(0xffe5e5ea); }
inline juce::Colour alarm()    { return accentColor(Accent::Red); }
inline juce::Colour warn()     { return accentColor(Accent::Orange); }

// ---------------------------------------------------------------------------
// Continuous meter colour gradient (see LevelMeter). Dark green -> bright
// green across -60..-12dBFS, yellow -> orange across -12..0dBFS, solid vivid
// red above 0dBFS (clip). Independent of theme -- meter colouring is a
// signal-level indicator, not a structural surface, so it stays consistent
// across Light/Dark the way it would on real hardware metering.
inline juce::Colour meterGradientColor(float db) {
    static const juce::Colour kDarkGreen(0xff0f5a26);
    static const juce::Colour kBrightGreen = accentColor(Accent::Green, Theme::Dark);
    static const juce::Colour kYellow = accentColor(Accent::Yellow, Theme::Dark);
    static const juce::Colour kOrange = accentColor(Accent::Orange, Theme::Dark);
    static const juce::Colour kRed(0xffff383c); // spec: solid vivid RGB(255,56,60), not interpolated

    if (db > 0.0f)
        return kRed;
    if (db >= -12.0f)
        return kYellow.interpolatedWith(kOrange, juce::jlimit(0.0f, 1.0f, (db + 12.0f) / 12.0f));
    if (db >= -60.0f)
        return kDarkGreen.interpolatedWith(kBrightGreen, juce::jlimit(0.0f, 1.0f, (db + 60.0f) / 48.0f));
    return kDarkGreen;
}

} // namespace ui
} // namespace resostage
