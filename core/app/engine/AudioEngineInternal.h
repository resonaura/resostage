#pragma once

// Shared implementation helpers for AudioEngine*.cpp translation units.
// Not part of the public API -- only included by AudioEngine member TUs so
// free functions / constants can live once while AudioEngine.cpp is split
// for readability (same pattern as MainComponent*.cpp).

#include "platform/AudioWorkgroup.h"
#include "platform/ProcessPriority.h"

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <string>
#include <unordered_map>
#include <vector>

namespace resostage {
namespace audio_engine_detail {

inline float dbToGain(double db) {
    if (db <= -144.0)
        return 0.0f;
    return static_cast<float>(std::pow(10.0, db / 20.0));
}

// Fade shape: curve in [-1, +1], 0 = linear.
// Positive → ease-out (fast start, slow end); negative → ease-in (slow start).
// Exponent is 2^(-curve*2) so +1 → exp 0.25 (concave-up / ease-out feel)
// and -1 → exp 4 (ease-in). Matches typical DAW fade-curve drag direction.
inline float shapedFadeGain(float t01, double curve) {
    const float t = std::clamp(t01, 0.0f, 1.0f);
    if (std::abs(curve) < 1.0e-6)
        return t;
    const float exp = std::pow(2.0f, static_cast<float>(-curve) * 2.0f); // 4..0.25
    return std::pow(t, exp);
}

// Lookahead ring per stem. Larger = more resilience to SSD thrashing
// (Spotlight, backups, Xcode) before an underrun; memory cost is
// tracks * ch * rate * seconds * 4B — e.g. 16 stereo 48 kHz × 8 s ≈ 50 MB.
// Metronome does not use this path (pure synth). Beyond this window,
// StreamingTrackBuffer catch-up skip still resyncs after silence holes.
// 5s headroom is enough for dual IO feeders; was 8s and made every ring
// alloc on first refill (or first keep-playing prime) multi-100ms with many stems.
inline constexpr double kRingBufferSeconds = 5.0;

// Play prime is intentionally short (see play()) — long waits freezes UI on
// song switch. Rings + async RAM residency fill in the background.

// Shared I/O-thread hooks: elevate disk/CPU priority, then join CoreAudio
// workgroup; leave workgroup on exit (required — see AudioWorkgroup.h).
inline void streamingIoThreadStart() {
    boostStreamingIoThreadPriority();
    joinCurrentThreadToDefaultOutputWorkgroup();
}
inline void streamingIoThreadStop() {
    leaveCurrentThreadWorkgroupIfJoined();
}

// The resident promoter getting off the disk, and back on it. See
// engine/audio/IoPressurePolicy.h.
inline void residentIoYield(bool yielding) {
    setBackgroundWorkerIoYielding(yielding);
}

// ~/Library/Application Support/ResoStage/Drafts/draft_<timestamp>.rsnraset
// (platform-appropriate equivalent elsewhere). Auto-created for every
// newProject() so imports have somewhere real to write to immediately,
// without forcing a manual Save As first. Rotated on every launch / new
// draft (keep the most recent kMaxRetainedDrafts; drop *.new / tmp leftovers).
// Successful Save As still promotes the active draft out of this folder.
inline constexpr int kMaxRetainedDrafts = 3;

inline void purgeStaleDrafts(const juce::File& draftsDir, const juce::String& keepPath = {}) {
    if (!draftsDir.isDirectory())
        return;

    struct Entry {
        juce::File file;
        juce::int64 modTime = 0;
        bool isCompleteDraft = false;
    };
    std::vector<Entry> complete;
    const juce::String keepFull = keepPath.isNotEmpty()
                                      ? juce::File(keepPath).getFullPathName()
                                      : juce::String();

    for (const auto& f : draftsDir.findChildFiles(
             juce::File::findFilesAndDirectories, false)) {
        const juce::String name = f.getFileName();
        const juce::String full = f.getFullPathName();
        // Crash/write leftovers from the old archivePath+".new" path and
        // partial renames -- never useful, always reclaim.
        if (name.contains(".new") || name.contains("tmp-writing") || name.endsWithIgnoreCase(".tmp")) {
            f.deleteRecursively();
            continue;
        }
        if (!name.startsWith("draft_") || !name.endsWithIgnoreCase(".rsnraset")) {
            // Unknown junk under Drafts/ -- leave alone (user may have put something here).
            continue;
        }
        if (keepFull.isNotEmpty() && full == keepFull)
            continue;
        Entry e;
        e.file = f;
        e.modTime = f.getLastModificationTime().toMilliseconds();
        e.isCompleteDraft = true;
        complete.push_back(std::move(e));
    }

    std::sort(complete.begin(), complete.end(),
              [](const Entry& a, const Entry& b) { return a.modTime > b.modTime; });
    for (size_t i = static_cast<size_t>(kMaxRetainedDrafts); i < complete.size(); ++i)
        complete[i].file.deleteRecursively();
}

inline bool makeDraftArchivePath(std::string& outPath, std::string& error) {
    // JUCE's userApplicationDataDirectory maps to ~/Library on macOS, not
    // ~/Library/Application Support -- append that segment explicitly to
    // land in the conventional location instead of directly under ~/Library.
    const juce::File userData = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
#if JUCE_MAC
    const juce::File appSupport = userData.getChildFile("Application Support");
#else
    const juce::File appSupport = userData;
#endif
    const juce::File draftsDir = appSupport.getChildFile("ResoStage").getChildFile("Drafts");
    const auto result = draftsDir.createDirectory();
    if (result.failed()) {
        error = result.getErrorMessage().toStdString();
        return false;
    }
    // Rotate before allocating a new timestamped draft so a crashy session
    // of "New Project" clicks can't fill the disk again.
    purgeStaleDrafts(draftsDir);
    const juce::String filename = "draft_" + juce::String(juce::Time::getCurrentTime().toMilliseconds()) + ".rsnraset";
    outPath = draftsDir.getChildFile(filename).getFullPathName().toStdString();
    return true;
}

} // namespace audio_engine_detail
} // namespace resostage
