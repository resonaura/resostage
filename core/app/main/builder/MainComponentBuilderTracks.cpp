/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// Track and region handlers for Builder web commands. This is a mechanical
// translation-unit split: mutations remain on the JUCE message thread and
// behavior is intentionally unchanged.

#include "MainComponent.h"
#include "engine/AudioEngineInternal.h"
#include "project/ProjectJson.h"
#include "project/RouteId.h"
#include "server/AutomationJson.h"
#include "server/BuilderJson.h"

#if JUCE_WINDOWS
#include <windows.h>
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace resostage {

using namespace builder_json;

namespace {
std::vector<MidiNote> parseMidiNotes(const glz::generic& doc) {
    std::vector<MidiNote> notes;
    if (!doc.contains("notes") || !doc["notes"].is_array())
        return notes;

    const auto& arr = doc["notes"].get_array();
    notes.reserve(arr.size());
    for (const auto& noteVal : arr) {
        if (!noteVal.is_object()) continue;
        MidiNote n;
        uint64_t idVal = 0;
        if (getUint64(noteVal, "id", idVal)) n.id = idVal;
        int pitchInt = 60;
        if (getInt(noteVal, "pitch", pitchInt))
            n.pitch = static_cast<uint8_t>(std::clamp(pitchInt, 0, 127));
        getDouble(noteVal, "startBeats", n.startBeats);
        getDouble(noteVal, "durationBeats", n.durationBeats);
        n.startBeats = std::max(0.0, n.startBeats);
        n.durationBeats = std::max(0.03125, n.durationBeats);
        double v = 0.8;
        if (getDouble(noteVal, "velocity", v))
            n.velocity = static_cast<float>(std::clamp(v, 0.0, 1.0));
        double relV = 0.5;
        if (getDouble(noteVal, "releaseVelocity", relV))
            n.releaseVelocity = static_cast<float>(std::clamp(relV, 0.0, 1.0));
        double prob = 1.0;
        if (getDouble(noteVal, "probability", prob))
            n.probability = static_cast<float>(std::clamp(prob, 0.0, 1.0));
        int pan = -1;
        if (getInt(noteVal, "pan", pan))
            n.pan = static_cast<int8_t>(std::clamp(pan, -1, 127));
        int tuning = 0;
        if (getInt(noteVal, "tuningOffsetCents", tuning))
            n.tuningOffsetCents = static_cast<int8_t>(std::clamp(tuning, -100, 100));
        getBool(noteVal, "muted", n.muted);
        int channel = 0;
        if (getInt(noteVal, "channel", channel)) n.channel = static_cast<uint8_t>(std::clamp(channel, 0, 15));
        if (noteVal.contains("midi2") && noteVal["midi2"].is_object()) {
            MidiNote::Midi2Data midi2;
            int value = 0;
            if (getInt(noteVal["midi2"], "group", value)) midi2.group = static_cast<uint8_t>(std::clamp(value, 0, 15));
            if (getInt(noteVal["midi2"], "velocity", value)) midi2.velocity = static_cast<uint16_t>(std::clamp(value, 0, 65535));
            if (getInt(noteVal["midi2"], "releaseVelocity", value)) midi2.releaseVelocity = static_cast<uint16_t>(std::clamp(value, 0, 65535));
            if (getInt(noteVal["midi2"], "attributeType", value)) midi2.attributeType = static_cast<uint8_t>(std::clamp(value, 0, 255));
            if (getInt(noteVal["midi2"], "attributeData", value)) midi2.attributeData = static_cast<uint16_t>(std::clamp(value, 0, 65535));
            n.midi2 = midi2;
        }
        notes.push_back(n);
    }
    std::stable_sort(notes.begin(), notes.end(), [](const MidiNote& a, const MidiNote& b) {
        return a.startBeats < b.startBeats;
    });
    return notes;
}

std::vector<MidiClipEvent> parseMidiClipEvents(const glz::generic& doc) {
    std::vector<MidiClipEvent> events;
    if (!doc.contains("events") || !doc["events"].is_array()) return events;
    const auto& values = doc["events"].get_array();
    if (values.size() > 200'000) return events;
    events.reserve(values.size());
    size_t totalPayloadBytes = 0;
    for (const auto& value : values) {
        if (!value.is_object()) continue;
        MidiClipEvent event;
        int status = 0;
        if (!getDouble(value, "beat", event.beat) || !getInt(value, "status", status)) continue;
        event.beat = std::max(0.0, event.beat);
        event.status = static_cast<uint8_t>(std::clamp(status, 0, 255));
        if (const auto* data = getArray(value, "data")) {
            if (data->size() > 65'536 || totalPayloadBytes + data->size() > 8 * 1024 * 1024) continue;
            event.data.reserve(data->size());
            for (const auto& byteValue : *data) {
                if (!byteValue.is_number()) { event.data.clear(); break; }
                const auto byte = static_cast<int>(byteValue.get_number());
                event.data.push_back(static_cast<uint8_t>(std::clamp(byte, 0, 255)));
            }
            totalPayloadBytes += event.data.size();
        }
        events.push_back(std::move(event));
    }
    std::stable_sort(events.begin(), events.end(), [](const auto& a, const auto& b) { return a.beat < b.beat; });
    return events;
}

std::vector<MidiUmpEvent> parseMidiUmpEvents(const glz::generic& doc) {
    std::vector<MidiUmpEvent> events;
    if (!doc.contains("umpEvents") || !doc["umpEvents"].is_array()) return events;
    const auto& values = doc["umpEvents"].get_array();
    if (values.size() > 200'000) return events;
    events.reserve(values.size());
    size_t totalWords = 0;
    for (const auto& value : values) {
        if (!value.is_object()) continue;
        MidiUmpEvent event;
        int wordCount = 0;
        if (!getDouble(value, "beat", event.beat) || !getInt(value, "wordCount", wordCount)
            || !std::isfinite(event.beat) || wordCount < 1 || wordCount > 4
            || !value.contains("words") || !value["words"].is_array()) continue;
        const auto& words = value["words"].get_array();
        // The project/wire DTO uses a fixed four-word packet array; only the
        // leading `wordCount` entries are meaningful for shorter UMP types.
        if (words.size() < static_cast<size_t>(wordCount) || words.size() > 4
            || totalWords + static_cast<size_t>(wordCount) > 800'000) continue;
        bool valid = true;
        for (size_t i = 0; i < words.size(); ++i) {
            if (!words[i].is_number()) { valid = false; break; }
            const double raw = words[i].get_number();
            if (!std::isfinite(raw) || raw < 0.0 || raw > 4294967295.0 || std::floor(raw) != raw) {
                valid = false;
                break;
            }
            event.words[i] = static_cast<uint32_t>(raw);
        }
        if (!valid) continue;
        event.beat = std::max(0.0, event.beat);
        event.wordCount = static_cast<uint8_t>(wordCount);
        events.push_back(event);
        totalWords += static_cast<size_t>(wordCount);
    }
    std::stable_sort(events.begin(), events.end(), [](const auto& a, const auto& b) { return a.beat < b.beat; });
    return events;
}

} // namespace


void MainComponent::builderTrackAdd(const std::string& json) {
    if (!engine.isProjectLoaded())
        return;
    Project& proj = engine.project();

    glz::generic doc;
    std::string kindStr;
    std::string customName;
    int channelsVal = 2;
    std::string pluginId;
    if (parseJson(json, doc)) {
        getString(doc, "kind", kindStr);
        getString(doc, "name", customName);
        getInt(doc, "channels", channelsVal);
        getString(doc, "instrumentPluginId", pluginId);
    }

    std::vector<std::string> used;
    for (const auto& t : proj.tracks)
        used.push_back(t.id);
    TrackDef track;
    std::string customId;
    getString(doc, "id", customId);
    if (!customId.empty() && std::find(used.begin(), used.end(), customId) == used.end()) {
        track.id = customId;
    } else {
        track.id = makeUniqueId("trk", used);
    }

    TrackKind trackKind = TrackKind::Audio;
    if (kindStr == "instrument") trackKind = TrackKind::Instrument;
    else if (kindStr == "midi") trackKind = TrackKind::MIDI;
    track.kind = trackKind;

    if (!customName.empty()) {
        track.name = customName;
    } else {
        if (trackKind == TrackKind::Instrument) {
            track.name = "Inst " + std::to_string(proj.tracks.size() + 1);
        } else if (trackKind == TrackKind::MIDI) {
            track.name = "MIDI " + std::to_string(proj.tracks.size() + 1);
        } else {
            track.name = "Audio " + std::to_string(proj.tracks.size() + 1);
        }
    }

    track.channels = (channelsVal == 1) ? 1 : 2;
    track.output.type = OutputType::Main;

    if (trackKind == TrackKind::Instrument || trackKind == TrackKind::MIDI) {
        track.midiInputChannel = 0; // Omni
        track.midiInputDevice = "all";
        track.inputSource = "none";
        if (!pluginId.empty()) {
            PluginSlot slot;
            slot.id = "slot:0";
            slot.plugin.identifier = pluginId;
            slot.plugin.instrument = true;
            slot.bypassed = false;
            track.plugins.push_back(std::move(slot));
        }
    } else {
        track.inputSource = (channelsVal == 1) ? "in:1" : "in:1+2";
    }

    engine.projectHistoryBeginEdit("", trackKind == TrackKind::Instrument ? "Add instrument track" : "Add track");
    proj.tracks.push_back(track);

    int songIdx = -1;
    getInt(doc, "songIndex", songIdx);
    if (trackKind == TrackKind::Instrument && songIdx >= 0 && songIdx < static_cast<int>(proj.songs.size())) {
        SongDef& s = proj.songs[static_cast<size_t>(songIdx)];
        std::vector<std::string> usedMidi;
        for (const auto& r : s.midiRegions)
            usedMidi.push_back(r.id);
        MidiRegion reg;
        reg.id = makeUniqueId("midi_reg", usedMidi);
        reg.trackId = track.id;
        reg.name = "Pattern 1";
        reg.startBeats = 0.0;
        reg.durationBeats = 16.0;
        reg.loop = true;
        reg.loopLengthBeats = 16.0;
        s.midiRegions.push_back(std::move(reg));
    }

    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus(trackKind == TrackKind::Instrument ? "Instrument track added" : "Track added");
}

void MainComponent::builderTrackRemove(const std::string& json) {
    glz::generic doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.tracks.size()))
        return;

    engine.projectHistoryBeginEdit("", "Remove track");
    proj.tracks.erase(proj.tracks.begin() + index);
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus("Track removed");
}

void MainComponent::builderTrackDuplicate(const std::string& json) {
    glz::generic doc;
    int index = -1;
    bool withContent = false;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    getBool(doc, "withContent", withContent);
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.tracks.size()))
        return;

    std::vector<std::string> usedTrackIds;
    usedTrackIds.reserve(proj.tracks.size());
    for (const auto& existing : proj.tracks)
        usedTrackIds.push_back(existing.id);
    const TrackDef& original = proj.tracks[static_cast<size_t>(index)];
    size_t pluginCount = proj.main.plugins.size() + proj.click.plugins.size();
    for (const auto& track : proj.tracks) pluginCount += track.plugins.size();
    for (const auto& send : proj.sends) pluginCount += send.plugins.size();
    if (pluginCount + original.plugins.size() > 128) {
        setStatus("Could not duplicate track: plug-in limit reached");
        return;
    }
    TrackDef duplicate = original;
    duplicate.id = makeUniqueId("trk", usedTrackIds);
    // A duplicate is a new signal strip, even when the original aliases one.
    duplicate.stripId.reset();
    duplicate.recordArmed = false;
    duplicate.inputMonitoring = false;
    std::vector<std::pair<std::string, std::string>> pluginIdRemap;
    for (auto& slot : duplicate.plugins) {
        const std::string newId = generateUUIDv7();
        pluginIdRemap.emplace_back(slot.id, newId);
        slot.id = newId;
    }
    const auto remapAutomationTarget = [&](AutomationLane& lane,
                                           const std::string& oldRegionId = {},
                                           const std::string& newRegionId = {}) {
        lane.id = generateUUIDv7();
        if (lane.target.entityId == original.id)
            lane.target.entityId = duplicate.id;
        else if (!oldRegionId.empty() && lane.target.entityId == oldRegionId)
            lane.target.entityId = newRegionId;
        else for (const auto& [oldId, newId] : pluginIdRemap)
            if (lane.target.entityId == oldId) {
                lane.target.entityId = newId;
                break;
            }
    };
    const std::string baseName = original.name + " copy";
    duplicate.name = baseName;
    for (int suffix = 2; std::any_of(proj.tracks.begin(), proj.tracks.end(), [&](const TrackDef& t) {
             return t.name == duplicate.name;
         }); ++suffix)
        duplicate.name = baseName + " " + std::to_string(suffix);

    engine.projectHistoryBeginEdit("", withContent ? "Duplicate track with content" : "Duplicate track");
    if (withContent) {
        for (auto& song : proj.songs) {
            std::vector<std::string> usedAudioIds;
            for (const auto& region : song.regions) usedAudioIds.push_back(region.id);
            const size_t audioCount = song.regions.size();
            for (size_t i = 0; i < audioCount; ++i) {
                if (song.regions[i].trackId != original.id) continue;
                Region copy = song.regions[i];
                copy.id = makeUniqueId("reg", usedAudioIds);
                usedAudioIds.push_back(copy.id);
                copy.trackId = duplicate.id;
                for (auto& lane : copy.automationLanes)
                    remapAutomationTarget(lane, song.regions[i].id, copy.id);
                song.regions.push_back(std::move(copy));
            }
            std::vector<std::string> usedMidiIds;
            for (const auto& region : song.midiRegions) usedMidiIds.push_back(region.id);
            const size_t midiCount = song.midiRegions.size();
            for (size_t i = 0; i < midiCount; ++i) {
                if (song.midiRegions[i].trackId != original.id) continue;
                MidiRegion copy = song.midiRegions[i];
                copy.id = makeUniqueId("midi_reg", usedMidiIds);
                usedMidiIds.push_back(copy.id);
                copy.trackId = duplicate.id;
                for (auto& lane : copy.automationLanes)
                    remapAutomationTarget(lane, song.midiRegions[i].id, copy.id);
                song.midiRegions.push_back(std::move(copy));
            }
            const size_t automationCount = song.automationLanes.size();
            for (size_t i = 0; i < automationCount; ++i) {
                const auto& lane = song.automationLanes[i];
                const bool belongsToTrack = lane.target.entityId == original.id
                    || std::any_of(pluginIdRemap.begin(), pluginIdRemap.end(), [&](const auto& pair) {
                           return pair.first == lane.target.entityId;
                       });
                if (!belongsToTrack) continue;
                AutomationLane copy = lane;
                remapAutomationTarget(copy);
                song.automationLanes.push_back(std::move(copy));
            }
        }
    }
    proj.tracks.insert(proj.tracks.begin() + index + 1, std::move(duplicate));
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
    setStatus(withContent ? "Track and content duplicated" : "Track duplicated");
}

void MainComponent::builderTrackMove(const std::string& json) {
    glz::generic doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    int to = -1;
    if (!getInt(doc, "to", to)) {
        int delta = 0;
        if (getInt(doc, "delta", delta))
            to = index + delta;
    }
    if (index < 0 || index >= static_cast<int>(proj.tracks.size())
        || to < 0 || to >= static_cast<int>(proj.tracks.size()) || index == to)
        return;

    engine.projectHistoryBeginEdit("", "Move track");
    auto item = std::move(proj.tracks[static_cast<size_t>(index)]);
    proj.tracks.erase(proj.tracks.begin() + index);
    proj.tracks.insert(proj.tracks.begin() + to, std::move(item));
    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
}

void MainComponent::builderTrackUpdate(const std::string& json) {
    glz::generic doc;
    int index = -1;
    if (!parseJson(json, doc) || !getInt(doc, "index", index) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (index < 0 || index >= static_cast<int>(proj.tracks.size()))
        return;
    TrackDef& t = proj.tracks[static_cast<size_t>(index)];

    // Covers every field this endpoint can touch, including the Mixer's
    // "Direct Output" bus (re)assignment (see mixer.setTrackBus in api.ts) --
    // the fast dedicated endpoints for gain/pan/mute/solo/mono already wrap
    // their own history in MainComponent::drainWebCommands' dispatchOne, so
    // this is what was missing for "any mixer action" to be undoable.
    engine.projectHistoryBeginEdit("", "Edit track");

    std::string strVal;
    double numVal;
    bool boolVal;
    if (getString(doc, "name", strVal)) t.name = strVal;
    if (getString(doc, "busId", strVal)) {
        // Same 3-way route mapping as the click's busId: "" = Sends Only,
        // "audio::main" = Main, otherwise an ext-out target string.
        if (strVal.empty()) {
            t.output.type = OutputType::SendsOnly;
            t.output.target.reset();
        } else if (strVal == "audio::main") {
            t.output.type = OutputType::Main;
            t.output.target.reset();
        } else {
            t.output.type = OutputType::ExtOut;
            t.output.target = strVal;
        }
    }
    if (getDouble(doc, "gainDb", numVal)) t.gainDb = numVal;
    if (getDouble(doc, "pan", numVal)) t.pan = numVal;
    if (getBool(doc, "mute", boolVal)) t.mute = boolVal;
    if (getBool(doc, "solo", boolVal)) t.solo = boolVal;
    if (getBool(doc, "mono", boolVal)) t.channels = boolVal ? 1 : 2;

    engine.setTrackGainDb(0, static_cast<size_t>(index), t.gainDb);
    engine.setTrackPan(0, static_cast<size_t>(index), t.pan);
    engine.setTrackBusId(0, static_cast<size_t>(index), routeIdOf(t.output));
    engine.setTrackMute(0, static_cast<size_t>(index), t.mute);
    engine.setTrackSolo(0, static_cast<size_t>(index), t.solo);
    engine.setTrackMono(0, static_cast<size_t>(index), t.channels == 1);

    engine.projectHistoryCommitEdit();
    notifyProjectStructureChanged();
}

void MainComponent::builderRegionAdd(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string trackId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "trackId", trackId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    std::vector<std::string> used;
    for (const auto& r : s.regions)
        used.push_back(r.id);

    Region reg;
    reg.id = makeUniqueId("reg", used);
    reg.trackId = trackId;
    getString(doc, "file", reg.source.file);
    if (reg.source.file.empty())
        return;

    getDouble(doc, "startSeconds", reg.startSeconds);
    getDouble(doc, "sourceOffsetSeconds", reg.source.offsetSeconds);
    getDouble(doc, "durationSeconds", reg.durationSeconds);
    getDouble(doc, "gainDb", reg.gainDb);
    getDouble(doc, "fadeInSeconds", reg.fade.inSeconds);
    getDouble(doc, "fadeOutSeconds", reg.fade.outSeconds);
    getDouble(doc, "fadeInCurve", reg.fade.inCurve);
    getDouble(doc, "fadeOutCurve", reg.fade.outCurve);
    bool loopEnabled = false;
    getBool(doc, "loop", loopEnabled);
    reg.loop.enabled = loopEnabled;

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Add region");
    s.regions.push_back(std::move(reg));
    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus("Region added");
}

void MainComponent::builderRegionRemove(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string regionId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "regionId", regionId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    const auto it = std::find_if(s.regions.begin(), s.regions.end(), [&](const Region& r) { return r.id == regionId; });
    if (it != s.regions.end()) {
        std::string gestureId;
        getString(doc, "gestureId", gestureId);
        engine.projectHistoryBeginEdit(gestureId, "Remove region");
        // The before-snapshot must precede erase/remove's move compaction.
        std::erase_if(s.regions, [&](const Region& r) { return r.id == regionId; });
        engine.projectHistoryCommitEdit();
        notifyProjectStructureChanged();
        setStatus("Region removed");
    }
}

void MainComponent::builderRegionUpdate(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string regionId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "regionId", regionId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    Region* regPtr = nullptr;
    for (auto& r : s.regions) {
        if (r.id == regionId) {
            regPtr = &r;
            break;
        }
    }
    if (!regPtr) return;

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Edit region");

    std::string strVal;
    double numVal;
    if (getString(doc, "trackId", strVal)) regPtr->trackId = strVal;
    if (getString(doc, "file", strVal)) regPtr->source.file = strVal;
    if (getDouble(doc, "startSeconds", numVal)) regPtr->startSeconds = numVal;
    if (getDouble(doc, "sourceOffsetSeconds", numVal)) regPtr->source.offsetSeconds = numVal;
    if (getDouble(doc, "durationSeconds", numVal)) regPtr->durationSeconds = numVal;
    if (getDouble(doc, "gainDb", numVal)) regPtr->gainDb = numVal;
    if (getDouble(doc, "fadeInSeconds", numVal)) regPtr->fade.inSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "fadeOutSeconds", numVal)) regPtr->fade.outSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "fadeInCurve", numVal))
        regPtr->fade.inCurve = std::clamp(numVal, -1.0, 1.0);
    if (getDouble(doc, "fadeOutCurve", numVal))
        regPtr->fade.outCurve = std::clamp(numVal, -1.0, 1.0);
    bool loopEnabled = false;
    if (getBool(doc, "loop", loopEnabled))
        regPtr->loop.enabled = loopEnabled;
    if (getDouble(doc, "loopLengthSeconds", numVal))
        regPtr->loop.lengthSeconds = std::max(0.0, numVal);
    if (getDouble(doc, "speed", numVal))
        regPtr->playback.speed = std::clamp(numVal, 0.25, 4.0);
    if (getDouble(doc, "semitones", numVal))
        regPtr->playback.semitones = std::clamp(numVal, -24.0, 24.0);
    bool reverseFlag = false;
    if (getBool(doc, "reverse", reverseFlag))
        regPtr->playback.reverse = reverseFlag;

    // Keep fades from exceeding the clip length (each side ≤ half duration).
    if (regPtr->durationSeconds > 0.0) {
        const double maxFade = std::max(0.0, regPtr->durationSeconds * 0.5);
        regPtr->fade.inSeconds = std::min(regPtr->fade.inSeconds, maxFade);
        regPtr->fade.outSeconds = std::min(regPtr->fade.outSeconds, maxFade);
    }

    engine.projectHistoryCommitEdit();
    engine.updateRegionWindow(*regPtr);
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus("Region updated");
}

void MainComponent::builderMIDIRegionAdd(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string trackId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "trackId", trackId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    std::vector<AutomationLane> embeddedAutomationLanes;
    std::string automationError;
    if (!builder_json::parseAutomationLanes(doc, embeddedAutomationLanes, automationError)) {
        setStatus("MIDI region automation rejected: " + juce::String(automationError));
        return;
    }

    std::vector<std::string> used;
    for (const auto& r : s.midiRegions)
        used.push_back(r.id);

    MidiRegion reg;
    reg.id = makeUniqueId("midi_reg", used);
    reg.trackId = trackId;
    getString(doc, "name", reg.name);
    if (reg.name.empty()) reg.name = "MIDI Region";
    getDouble(doc, "startBeats", reg.startBeats);
    getDouble(doc, "durationBeats", reg.durationBeats);
    if (reg.durationBeats <= 0.0) reg.durationBeats = 16.0;
    getDouble(doc, "clipOffsetBeats", reg.clipOffsetBeats);
    bool loop = false;
    getBool(doc, "loop", loop);
    reg.loop = loop;
    getDouble(doc, "loopLengthBeats", reg.loopLengthBeats);
    getDouble(doc, "loopStartBeats", reg.loopStartBeats);
    if (reg.loopLengthBeats <= 0.0) reg.loopLengthBeats = reg.durationBeats;
    getString(doc, "color", reg.color);
    getBool(doc, "muted", reg.muted);
    if (doc.contains("notes") && doc["notes"].is_array())
        reg.notes = parseMidiNotes(doc);
    if (doc.contains("events") && doc["events"].is_array())
        reg.events = parseMidiClipEvents(doc);
    if (doc.contains("umpEvents") && doc["umpEvents"].is_array())
        reg.umpEvents = parseMidiUmpEvents(doc);
    reg.automationLanes = std::move(embeddedAutomationLanes);
    for (auto& lane : reg.automationLanes) {
        if (lane.scope == AutomationScope::Region)
            lane.target.entityId = reg.id;
    }

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Add MIDI region");
    s.midiRegions.push_back(std::move(reg));
    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
    setStatus("MIDI region added");
}

void MainComponent::builderMIDIRegionRemove(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string regionId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "regionId", regionId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    const auto it = std::find_if(s.midiRegions.begin(), s.midiRegions.end(), [&](const MidiRegion& r) { return r.id == regionId; });
    if (it != s.midiRegions.end()) {
        std::string gestureId;
        getString(doc, "gestureId", gestureId);
        engine.projectHistoryBeginEdit(gestureId, "Remove MIDI region");
        std::erase_if(s.midiRegions, [&](const MidiRegion& r) { return r.id == regionId; });
        engine.projectHistoryCommitEdit();
        engine.markDirty();
        notifyProjectStructureChanged();
        setStatus("MIDI region removed");
    }
}

void MainComponent::builderMIDIRegionUpdate(const std::string& json) {
    glz::generic doc;
    int songIndex = -1;
    std::string regionId;
    if (!parseJson(json, doc) || !getInt(doc, "songIndex", songIndex) || !getString(doc, "regionId", regionId) || !engine.isProjectLoaded())
        return;
    Project& proj = engine.project();
    if (songIndex < 0 || songIndex >= static_cast<int>(proj.songs.size()))
        return;
    SongDef& s = proj.songs[static_cast<size_t>(songIndex)];

    MidiRegion* regPtr = nullptr;
    for (auto& r : s.midiRegions) {
        if (r.id == regionId) {
            regPtr = &r;
            break;
        }
    }
    if (!regPtr) return;

    std::vector<AutomationLane> embeddedAutomationLanes;
    std::string automationError;
    if (doc.contains("automationLanes")
        && !builder_json::parseAutomationLanes(doc, embeddedAutomationLanes, automationError)) {
        setStatus("MIDI region automation rejected: " + juce::String(automationError));
        return;
    }

    std::string gestureId;
    getString(doc, "gestureId", gestureId);
    engine.projectHistoryBeginEdit(gestureId, "Edit MIDI region");

    std::string strVal;
    double numVal;
    bool boolVal;
    if (getString(doc, "trackId", strVal)) regPtr->trackId = strVal;
    if (getString(doc, "name", strVal)) regPtr->name = strVal;
    if (getDouble(doc, "startBeats", numVal)) regPtr->startBeats = std::max(0.0, numVal);
    if (getDouble(doc, "durationBeats", numVal)) regPtr->durationBeats = std::max(0.25, numVal);
    if (getDouble(doc, "clipOffsetBeats", numVal)) regPtr->clipOffsetBeats = numVal;
    if (getBool(doc, "loop", boolVal)) regPtr->loop = boolVal;
    if (getDouble(doc, "loopLengthBeats", numVal)) regPtr->loopLengthBeats = std::max(0.25, numVal);
    if (getDouble(doc, "loopStartBeats", numVal)) regPtr->loopStartBeats = std::max(0.0, numVal);
    if (getBool(doc, "muted", boolVal)) regPtr->muted = boolVal;
    if (getString(doc, "color", strVal)) regPtr->color = strVal;

    // Optional notes array update
    if (doc.contains("notes") && doc["notes"].is_array())
        regPtr->notes = parseMidiNotes(doc);
    if (doc.contains("events") && doc["events"].is_array())
        regPtr->events = parseMidiClipEvents(doc);
    if (doc.contains("umpEvents") && doc["umpEvents"].is_array())
        regPtr->umpEvents = parseMidiUmpEvents(doc);
    if (doc.contains("automationLanes")) {
        regPtr->automationLanes = std::move(embeddedAutomationLanes);
        for (auto& lane : regPtr->automationLanes) {
            if (lane.scope == AutomationScope::Region)
                lane.target.entityId = regPtr->id;
        }
    }

    engine.projectHistoryCommitEdit();
    engine.markDirty();
    notifyProjectStructureChanged();
}

} // namespace resostage
