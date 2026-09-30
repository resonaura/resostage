// Builder structural-edit parity for the web UI. Each method here mirrors
// the matching BuilderPanel.cpp method (addItem/removeItem/moveItem/
// apply*Settings) as closely as possible -- same Project mutations, same
// engine setter calls, same post-edit refresh hooks -- just driven by a JSON
// payload (see WebCommand::json, parsed with glz::generic via BuilderJson.h)
// instead of native widget state. Kept in its own translation unit so
// MainComponent.cpp doesn't balloon; these are still MainComponent member
// functions with full access to engine / web-command handlers.

#include "MainComponent.h"
#include "engine/AudioEngineInternal.h"
#include "project/ProjectJson.h"
#include "project/RouteId.h"
#include "server/BuilderJson.h"

#if JUCE_WINDOWS
#include <windows.h>
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace resostage {

using namespace builder_json;


void MainComponent::setTrackSendFromJson(const std::string& json) {
    glz::generic doc;
    int trackIndex = -1;
    std::string busId;
    double level = 0.0;
    if (!parseJson(json, doc) || !getInt(doc, "trackIndex", trackIndex)
        || !getString(doc, "busId", busId) || !getDouble(doc, "level", level)
        || !engine.isProjectLoaded())
        return;
    // `level` is the schema's own unit: 0-100 LINEAR percent, 100 = unity.
    // The wire used to carry dB and convert here, which is why a send saved
    // at "100%" could never be set to exactly 0 or exactly 100 from the UI --
    // the round trip through dB and back always landed just off.
    level = std::clamp(level, 0.0, 100.0);

    // Absent `enabled` means "just move the level" -- an enabled send stays
    // enabled, and turning a knob up from the floor implicitly creates one.
    bool enabled = true;
    const bool enabledGiven = getBool(doc, "enabled", enabled);
    std::string tapStr;
    bool preFader = false;
    const bool tapGiven = getString(doc, "tap", tapStr);
    const bool preFaderGiven = getBool(doc, "preFader", preFader);

    const size_t idx = static_cast<size_t>(trackIndex);
    const size_t songIdx = engine.currentSongIndex();
    const TrackDef* t = engine.trackDefAt(idx);
    if (t == nullptr)
        return;

    // A send knob is dragged, so its stream of writes carries a gestureId and
    // collapses into one undo entry -- without it, turning one knob buried
    // every earlier edit under a hundred entries, which is the same as having
    // no history at all.
    std::string gestureId;
    getString(doc, "gestureId", gestureId);

    for (size_t si = 0; si < t->output.sends.size(); ++si) {
        if (t->output.sends[si].bus == busId) {
            SendConfig updated = t->output.sends[si];
            updated.level = level;
            updated.enabled = enabledGiven ? enabled : updated.enabled;
            if (tapGiven) {
                updated.tap = sendTapFromString(tapStr, preFader);
                updated.preFader = (updated.tap == SendTap::PreFader);
            } else if (preFaderGiven) {
                updated.preFader = preFader;
                updated.tap = preFader ? SendTap::PreFader : SendTap::PostPan;
            }
            engine.projectHistoryBeginEdit(gestureId, "Edit send");
            engine.setTrackSend(songIdx, idx, si, updated);
            engine.projectHistoryCommitEdit();
            notifyRoutingChanged();
            return;
        }
    }
    SendConfig newSend;
    newSend.bus = busId;
    newSend.level = level;
    newSend.enabled = enabledGiven ? enabled : true;
    if (tapGiven) {
        newSend.tap = sendTapFromString(tapStr, preFader);
        newSend.preFader = (newSend.tap == SendTap::PreFader);
    } else if (preFaderGiven) {
        newSend.preFader = preFader;
        newSend.tap = preFader ? SendTap::PreFader : SendTap::PostPan;
    }
    engine.projectHistoryBeginEdit(gestureId, "Add send");
    engine.addTrackSend(songIdx, idx, newSend);
    engine.projectHistoryCommitEdit();
    notifyRoutingChanged();
}

void MainComponent::setProjectNameFromJson(const std::string& json) {
    glz::generic doc;
    std::string name;
    if (!parseJson(json, doc) || !getString(doc, "name", name) || !engine.isProjectLoaded())
        return;
    name.erase(0, name.find_first_not_of(" \t"));
    name.erase(name.find_last_not_of(" \t") + 1);
    if (name.empty())
        return;

    engine.projectHistoryBeginEdit("", "Rename project");
    engine.project().name = name;
    engine.projectHistoryCommitEdit();
    engine.markDirty();
    setStatus("Project renamed to '" + juce::String(name) + "'");
}

void MainComponent::removeTrackSendFromJson(const std::string& json) {
    glz::generic doc;
    int trackIndex = -1;
    std::string busId;
    if (!parseJson(json, doc) || !getInt(doc, "trackIndex", trackIndex) || !getString(doc, "busId", busId)
        || !engine.isProjectLoaded())
        return;
    const size_t idx = static_cast<size_t>(trackIndex);
    const size_t songIdx = engine.currentSongIndex();
    const TrackDef* t = engine.trackDefAt(idx);
    if (t == nullptr)
        return;

    for (size_t si = 0; si < t->output.sends.size(); ++si) {
        if (t->output.sends[si].bus == busId) {
            engine.projectHistoryBeginEdit("", "Remove send");
            engine.removeTrackSend(songIdx, idx, si);
            engine.projectHistoryCommitEdit();
            notifyRoutingChanged();
            return;
        }
    }
}


void MainComponent::builderBusAdd() {
    if (!engine.isProjectLoaded())
        return;
    Project& proj = engine.project();

    // Sends own a sequential "audio::send:N" id -- reuse any gaps left by
    // earlier removals by continuing past the highest existing suffix.
    int maxSend = 0;
    constexpr const char* kSendPrefix = "audio::send:";
    for (const auto& s : proj.sends) {
        if (s.id.rfind(kSendPrefix, 0) != 0)
            continue;
        try {
            maxSend = std::max(maxSend, std::stoi(s.id.substr(std::string(kSendPrefix).size())));
        } catch (...) {
            continue;
        }
    }
    SendBus bus;
    bus.id = kSendPrefix + std::to_string(maxSend + 1);
    bus.name = "New Bus";
    bus.channels = 2;
    bus.output.type = OutputType::ExtOut;

    // Place the new send on the first physical channel past every bus that
    // already owns direct channels (master included).
    int nextCh = 0;
    const auto extendFrom = [&nextCh](const std::optional<std::string>& target) {
        if (!target.has_value())
            return;
        int start = 0, count = 0;
        parseExtOutTarget(*target, start, count);
        nextCh = std::max(nextCh, start + count);
    };
    extendFrom(proj.main.output.target);
    for (const auto& s : proj.sends)
        extendFrom(s.output.target);
    bus.output.target = extOutTarget(nextCh, bus.channels);

    engine.projectHistoryBeginEdit("", "Add Send");
    proj.sends.push_back(std::move(bus));
    engine.projectHistoryCommitEdit();
    engine.rebuildBussesFromProject();
    notifyProjectStructureChanged();
    setStatus("Send added");
}

void MainComponent::builderBusRemove(const std::string& json) {
    glz::generic doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    // Bus rail indexes: 0 = Master (never removable), 1..N = Sends.
    if (index <= 0 || index > static_cast<int>(proj.sends.size()))
        return;

    engine.projectHistoryBeginEdit("", "Remove send");
    const size_t sIdx = static_cast<size_t>(index - 1);
    const std::string removedId = proj.sends[sIdx].id;
    proj.sends.erase(proj.sends.begin() + static_cast<ptrdiff_t>(sIdx));

    // Anything that depends on the removed send needs to be untangled: a
    // dangling send row referencing a bus id that no longer exists is
    // silently skipped by AudioEngine's routing build (see busIndexById
    // lookups there), so it wouldn't crash or misroute audio -- but it'd sit
    // in the project forever as dead weight, and sendsCount/UI would keep
    // showing a send that can never do anything. Drop those send rows
    // outright instead of leaving them dangling or silently re-pointing them
    // at some other bus (which would be a surprising routing change).
    auto dropsRemovedSend = [&removedId](const SendConfig& s) { return s.bus == removedId; };
    for (auto& tr : proj.tracks)
        tr.output.sends.erase(std::remove_if(tr.output.sends.begin(), tr.output.sends.end(), dropsRemovedSend),
                              tr.output.sends.end());
    // Project-global metronome routing.
    proj.click.output.sends.erase(
        std::remove_if(proj.click.output.sends.begin(), proj.click.output.sends.end(), dropsRemovedSend),
        proj.click.output.sends.end());
    engine.projectHistoryCommitEdit();
    engine.rebuildBussesFromProject();
    notifyProjectStructureChanged();
    setStatus("Send removed");
}

void MainComponent::builderBusMove(const std::string& json) {
    glz::generic doc;
    int index = -1, delta = 0;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !getInt(doc, "delta", delta)
        || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    const int to = index + delta;
    // Bus rail indexes: 0 = Master (fixed), 1..N = Sends.
    if (index <= 0 || index > static_cast<int>(proj.sends.size()) || to <= 0
        || to > static_cast<int>(proj.sends.size()))
        return;

    engine.projectHistoryBeginEdit("", "Move send");
    std::swap(proj.sends[static_cast<size_t>(index - 1)], proj.sends[static_cast<size_t>(to - 1)]);
    engine.projectHistoryCommitEdit();
    engine.rebuildBussesFromProject();
    notifyProjectStructureChanged();
}

void MainComponent::builderBusUpdate(const std::string& json) {
    glz::generic doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index > static_cast<int>(proj.sends.size()))
        return;

    // Covers every field this endpoint can touch, including bus creation's
    // follow-up configure step (queueBusJob in MixerScreen.tsx -- "Add Send"
    // / "Direct Output" both create-then-immediately-busUpdate) and channel
    // width / routing changes. The fast dedicated endpoints for gain/mute/
    // solo already wrap their own history in dispatchOne; this covers the
    // rest of what "any mixer action" needs.
    engine.projectHistoryBeginEdit("", "Edit bus");

    std::string strVal;
    double numVal;
    int intVal;
    bool boolVal;
    if (index == 0) {
        // Master strip -- lives in proj.main (never a send).
        if (getString(doc, "name", strVal)) proj.main.name = strVal;
        if (getInt(doc, "channels", intVal)) proj.main.channels = (intVal >= 2) ? 2 : 1;
        int startChannel = -1;
        if (getInt(doc, "startChannel", intVal)) startChannel = intVal;
        if (getDouble(doc, "gainDb", numVal)) proj.main.gainDb = numVal;
        if (getDouble(doc, "pan", numVal)) proj.main.pan = std::clamp(numVal, -1.0, 1.0);
        if (getBool(doc, "mute", boolVal)) proj.main.mute = boolVal;
        if (getBool(doc, "solo", boolVal)) proj.main.solo = boolVal;
        if (startChannel >= 0) {
            proj.main.output.type = OutputType::ExtOut;
            proj.main.output.target = extOutTarget(startChannel, proj.main.channels);
        }
    } else {
        SendBus& b = proj.sends[static_cast<size_t>(index - 1)];
        if (getString(doc, "name", strVal)) b.name = strVal;
        if (getInt(doc, "channels", intVal)) b.channels = (intVal >= 2) ? 2 : 1;
        int startChannel = -1;
        if (getInt(doc, "startChannel", intVal)) startChannel = intVal;
        if (getDouble(doc, "gainDb", numVal)) b.gainDb = numVal;
        if (getDouble(doc, "pan", numVal)) b.pan = std::clamp(numVal, -1.0, 1.0);
        if (getBool(doc, "mute", boolVal)) b.mute = boolVal;
        if (getBool(doc, "solo", boolVal)) b.solo = boolVal;
        if (startChannel >= 0) {
            b.output.type = OutputType::ExtOut;
            b.output.target = extOutTarget(startChannel, b.channels);
        }
    }

    engine.projectHistoryCommitEdit();

    // Always rebuild the live bus list from project so LoadedBus.channelCount
    // stays in lockstep with SendBus.channels and the ext-out targets.
    // rebuildBussesFromProject also republishes the routing snapshot (gain/
    // mute/solo/startChannel all read from project).
    engine.rebuildBussesFromProject();
    notifyRoutingChanged();
    setStatus("Bus updated");
}


} // namespace resostage
