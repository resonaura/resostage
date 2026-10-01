/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "AudioEngine.h"

namespace resostage {

const std::string& AudioEngine::busNameAt(size_t index) const {
    static const std::string kMain = "Main";
    static const std::string kEmpty;
    const Project& proj = loader.project();
    if (index == 0)
        return proj.main.name.empty() ? kMain : proj.main.name;
    const size_t si = index - 1;
    if (si >= proj.sends.size())
        return kEmpty;
    return proj.sends[si].name.empty() ? proj.sends[si].id : proj.sends[si].name;
}

const TrackDef* AudioEngine::trackDefAt(size_t index) const {
    if (!projectLoaded)
        return nullptr;
    const auto& trks = loader.project().tracks;
    if (index < trks.size())
        return &trks[index];
    return nullptr;
}

TrackDef* AudioEngine::trackDefAt(size_t index) {
    return const_cast<TrackDef*>(static_cast<const AudioEngine*>(this)->trackDefAt(index));
}

const TrackDef* AudioEngine::trackDefInSong(size_t songIndex, size_t trackIndex) const {
    (void)songIndex;
    return trackDefAt(trackIndex);
}

TrackDef* AudioEngine::trackDefInSong(size_t songIndex, size_t trackIndex) {
    (void)songIndex;
    return trackDefAt(trackIndex);
}

bool AudioEngine::isBusMuted(size_t busIndex) const {
    const Project& proj = loader.project();
    if (busIndex == 0)
        return proj.main.mute;
    const size_t si = busIndex - 1;
    if (si < proj.sends.size())
        return proj.sends[si].mute;
    return busIndex < busMuted.size() && busMuted[busIndex];
}

bool AudioEngine::isBusSoloed(size_t busIndex) const {
    const Project& proj = loader.project();
    if (busIndex == 0)
        return proj.main.solo;
    const size_t si = busIndex - 1;
    return si < proj.sends.size() && proj.sends[si].solo;
}

bool AudioEngine::isBusSoloSafe(size_t busIndex) const {
    const Project& proj = loader.project();
    if (busIndex == 0)
        return proj.main.soloSafe;
    const size_t si = busIndex - 1;
    return si < proj.sends.size() && proj.sends[si].soloSafe;
}

bool AudioEngine::isClickSoloSafe() const {
    return loader.project().click.soloSafe;
}

double AudioEngine::busGainDb(size_t busIndex) const {
    const Project& proj = loader.project();
    if (busIndex == 0)
        return proj.main.gainDb;
    const size_t si = busIndex - 1;
    if (si >= proj.sends.size())
        return 0.0;
    return proj.sends[si].gainDb;
}

} // namespace resostage
