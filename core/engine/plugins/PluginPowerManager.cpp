#include "PluginPowerManager.h"

#include <unordered_set>

namespace resostage {

void PluginPowerManager::lookaheadScan(const Project& project, size_t activeSongIndex,
                                      double currentBeat, double beatsPerBar) noexcept {
    if (activeSongIndex >= project.songs.size()) {
        return;
    }

    const auto& song = project.songs[activeSongIndex];
    const double bpm = std::max(1.0, song.bpm);
    const double lookaheadBars = std::max(0.5, config.lookaheadBars);
    const double lookaheadBeats = lookaheadBars * std::max(1.0, beatsPerBar);
    const double lookaheadEndBeat = currentBeat + lookaheadBeats;

    const double secondsPerBeat = 60.0 / bpm;
    const double currentSeconds = currentBeat * secondsPerBeat;
    const double lookaheadEndSeconds = lookaheadEndBeat * secondsPerBeat;

    std::unordered_set<std::string> upcomingActiveTracks;

    // 1. Audio regions check
    for (const auto& reg : song.regions) {
        const double regStart = reg.startSeconds;
        const double regEnd = (reg.durationSeconds > 0.0)
                                  ? (reg.startSeconds + reg.durationSeconds)
                                  : std::numeric_limits<double>::infinity();
        if (regEnd > currentSeconds && regStart < lookaheadEndSeconds) {
            upcomingActiveTracks.insert(reg.trackId);
        }
    }

    // 2. MIDI regions check
    for (const auto& mreg : song.midiRegions) {
        if (mreg.muted) continue;
        const double mregStart = mreg.startBeats;
        const double mregEnd = (mreg.durationBeats > 0.0)
                                   ? (mreg.startBeats + mreg.durationBeats)
                                   : std::numeric_limits<double>::infinity();
        if (mregEnd > currentBeat && mregStart < lookaheadEndBeat) {
            upcomingActiveTracks.insert(mreg.trackId);
        }
    }

    // 3. Automation lanes check (song-level automation)
    for (const auto& lane : song.automationLanes) {
        if (lane.muted || !lane.enabled) continue;
        for (const auto& pt : lane.points) {
            if (pt.timeBeats >= currentBeat && pt.timeBeats < lookaheadEndBeat) {
                // If targeting a track/plugin
                if (lane.target.domain == AutomationDomain::Plugin) {
                    auto tracker = findTracker(lane.target.entityId);
                    if (tracker != nullptr && (tracker->state() == PluginPowerState::Suspended
                                               || tracker->state() == PluginPowerState::Quiescent)) {
                        tracker->forceAwake();
                    }
                } else if (lane.target.domain == AutomationDomain::Strip) {
                    upcomingActiveTracks.insert(lane.target.entityId);
                }
            }
        }
    }

    // Pre-warm plugins on upcoming active tracks
    for (const auto& track : project.tracks) {
        if (upcomingActiveTracks.contains(track.id)) {
            for (const auto& slot : track.plugins) {
                auto tracker = findTracker(slot.id);
                if (tracker != nullptr) {
                    if (tracker->state() == PluginPowerState::Suspended
                        || tracker->state() == PluginPowerState::Quiescent) {
                        tracker->forceAwake();
                    }
                }
            }
        }
    }
}

} // namespace resostage
