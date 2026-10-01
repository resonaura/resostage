// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

// Audio and MIDI recording lifecycle plus live recording/key previews.
// Exact method bodies moved from AudioEngineTransport.cpp so capture state and
// its UI-facing snapshots have a focused implementation home.

#include "AudioEngine.h"
#include "AudioEngineInternal.h"
#include "project/RouteId.h"
#include "project/MidiRegionLoop.h"
#include "events/DueQueue.h"
#include "midi/Midi2Compatibility.h"
#include "timing/SongLength.h"
#include "automation/AutomationEvaluator.h"

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <limits>
#include <string>
#include <string_view>
#include <vector>
#include "project/Uuid.h"

namespace resostage {

using audio_engine_detail::dbToGain;
using audio_engine_detail::kRingBufferSeconds;

void AudioEngine::startRecording(int targetTrackIndex) {
    if (isRecordingState.load(std::memory_order_acquire))
        return;

    if (!projectLoaded || currentSong >= loader.project().songs.size())
        return;

    refreshMonitoringAndArmCounts();

    auto& tracks = loader.project().tracks;

    // Logic Pro standard behavior: If no tracks are record-armed when user hits record,
    // automatically arm the target track (or first eligible audio/instrument track).
    if (activeRecordArmCount.load(std::memory_order_relaxed) == 0 && !tracks.empty()) {
        int armTrackIdx = -1;
        if (targetTrackIndex >= 0 && targetTrackIndex < static_cast<int>(tracks.size())
            && trackSupportsRecordArm(tracks[static_cast<size_t>(targetTrackIndex)])) {
            armTrackIdx = targetTrackIndex;
        }
        if (armTrackIdx < 0 && focusedTrack() >= 0
            && focusedTrack() < static_cast<int>(tracks.size())) {
            if (trackSupportsRecordArm(tracks[static_cast<size_t>(focusedTrack())])) {
                armTrackIdx = focusedTrack();
            }
        }
        if (armTrackIdx < 0) {
            for (size_t t = 0; t < tracks.size(); ++t) {
                if (trackSupportsRecordArm(tracks[t])) {
                    armTrackIdx = static_cast<int>(t);
                    break;
                }
            }
        }

        if (armTrackIdx >= 0 && armTrackIdx < static_cast<int>(tracks.size())) {
            tracks[static_cast<size_t>(armTrackIdx)].recordArmed = true;
            refreshMonitoringAndArmCounts();
            publishRoutingSnapshot();
            markDirty();
        }
    }

    // Folder, lighting and bus-timeline rows cannot become recording targets.
    if (activeRecordArmCount.load(std::memory_order_relaxed) == 0)
        return;

    const double sr = currentSampleRate > 0.0 ? currentSampleRate : 48000.0;
    const int64_t startPos = clock.currentSamplePosition();
    const int64_t captureStartPos = autoPunchEnabledState.load(std::memory_order_acquire)
        ? std::max(startPos, autoPunchStartSample.load(std::memory_order_acquire))
        : startPos;
    const bool shouldCountIn = !playing.load(std::memory_order_acquire)
        && countInBarsState.load(std::memory_order_acquire) > 0;
    int64_t countInStartPos = captureStartPos;
    if (shouldCountIn) {
        const SongDef& song = loader.project().songs[currentSong];
        const double bpm = song.bpm > 0.0 ? song.bpm : 120.0;
        const int beatsPerBar = std::max(1, song.timeSignature.numerator);
        const double samplesPerBeat = sr * 60.0 / bpm;
        const double targetBeats = static_cast<double>(captureStartPos) / samplesPerBeat;
        const int64_t targetBar = static_cast<int64_t>(std::floor(targetBeats / beatsPerBar));
        const int bars = countInBarsState.load(std::memory_order_relaxed);
        const double startBeats = static_cast<double>(targetBar - bars) * beatsPerBar;
        countInStartPos = static_cast<int64_t>(std::llround(startBeats * samplesPerBeat));
    }

    // Prepare recording output directory
    std::filesystem::path recPath;
    if (!projectPath().empty()) {
        const std::filesystem::path p(projectPath());
        if (std::filesystem::is_directory(p)) {
            recPath = p / "Recordings";
        } else {
            recPath = p.parent_path() / "Recordings";
        }
    } else {
        recPath = std::filesystem::temp_directory_path() / "ResoStageRecordings";
    }
    std::error_code ec;
    std::filesystem::create_directories(recPath, ec);

    std::vector<TrackAudioRecordSession> requestedSessions;
    activeMidiRecordSessions.clear();
    liveMidiPreviewGeneration.fetch_add(1, std::memory_order_acq_rel);
    trackToAudioRecordSession.fill(-1);

    const auto nowTime = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    char timeStr[64];
    std::strftime(timeStr, sizeof(timeStr), "%Y%m%d_%H%M%S", std::localtime(&nowTime));

    for (size_t t = 0; t < tracks.size(); ++t) {
        const auto& track = tracks[t];
        if (!track.recordArmed)
            continue;

        if (track.kind == TrackKind::Audio) {
            TrackAudioRecordSession s;
            s.trackId = track.id;
            std::string sanitizedName = track.name.empty() ? track.id : track.name;
            for (char& c : sanitizedName) {
                if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_' && c != '-') c = '_';
            }
            s.filename = "Take_" + std::string(timeStr) + "_" + sanitizedName + ".wav";
            s.fullPath = (recPath / s.filename).string();
            s.channels = (track.channels == 1) ? 1 : 2;
            int chL = 0, chR = (track.channels == 1 ? -1 : 1);
            audio_engine_detail::parseInputRouting(track.inputSource, track.channels, chL, chR);
            s.inputChannel0 = chL;
            s.inputChannel1 = chR;
            if (t < trackToAudioRecordSession.size()) {
                trackToAudioRecordSession[t] = static_cast<int>(requestedSessions.size());
            }
            requestedSessions.push_back(std::move(s));
        }

        // Active MIDI recording session
        if (track.kind == TrackKind::Instrument || track.kind == TrackKind::MIDI || track.kind == TrackKind::ExternalMIDI) {
            TrackMidiRecordSession midiSession;
            midiSession.trackId = track.id;
            midiSession.inputChannel = track.midiInputChannel;
            midiSession.recordedNoteCount = 0;
            uint64_t maxNoteId = 0;
            for (const auto& region : loader.project().songs[currentSong].midiRegions) {
                if (region.trackId != track.id) continue;
                for (const auto& note : region.notes)
                    maxNoteId = std::max(maxNoteId, note.id);
            }
            midiSession.nextNoteId = maxNoteId + 1;
            activeMidiRecordSessions.push_back(std::move(midiSession));
        }
    }

    if (!requestedSessions.empty()) {
        std::string err;
        audioRecordWorker.prepareRecording(recPath.string(), requestedSessions, sr, captureStartPos, err);
    }

    if (shouldCountIn) {
        // Negative count-in time has no source material before sample zero;
        // positive anchors seek back to the bar where the count-in begins.
        std::string seekError;
        (void)streaming.seekActiveSongTo(
            std::max<int64_t>(0, countInStartPos), seekError,
            /*primeMaxWait=*/0.0);
    }

    {
        std::lock_guard<std::recursive_mutex> lock(routingMutex);
        recordStartSamplePos.store(captureStartPos, std::memory_order_release);
        if (shouldCountIn)
            pendingCountInStartSample.store(countInStartPos, std::memory_order_release);
        isRecordingState.store(true, std::memory_order_release);
    }

    if (!playing.load(std::memory_order_acquire)) {
        play();
    }
}

void AudioEngine::setCountInBars(int bars) {
    countInBarsState.store(std::clamp(bars, 0, 2), std::memory_order_release);
}

void AudioEngine::stopRecording() {
    if (!isRecordingState.load(std::memory_order_acquire))
        return;

    {
        std::lock_guard<std::recursive_mutex> lock(routingMutex);
        isRecordingState.store(false, std::memory_order_release);
        trackToAudioRecordSession.fill(-1);
    }

    std::vector<RecordedAudioTrackResult> recordedAudio = audioRecordWorker.stopAndFinalize();

    if (!projectLoaded || currentSong >= loader.project().songs.size())
        return;

    Project& proj = loader.project();
    SongDef& song = proj.songs[currentSong];

    bool hasRecordedContent = std::any_of(recordedAudio.begin(), recordedAudio.end(),
        [](const RecordedAudioTrackResult& result) { return result.recordedFrames > 0; });
    for (const auto& session : activeMidiRecordSessions) {
        hasRecordedContent = hasRecordedContent || session.recordedNoteCount > 0
            || session.recordedEventCount > 0
            || std::any_of(session.activeNotes.begin(), session.activeNotes.end(),
                [](const ActiveRecordedMidiNote& note) { return note.active; });
    }
    if (hasRecordedContent)
        projectHistory.beginEdit(proj, "", "Record");

    const double sr = currentSampleRate > 0.0 ? currentSampleRate : 48000.0;
    const int64_t startSample = recordStartSamplePos.load(std::memory_order_acquire);
    const double recordStartSeconds = static_cast<double>(startSample) / sr;
    const int64_t rawEndSample = clock.currentSamplePosition();
    const int64_t endSample = autoPunchEnabledState.load(std::memory_order_acquire)
        ? std::clamp(
            rawEndSample,
            autoPunchStartSample.load(std::memory_order_acquire),
            autoPunchEndSample.load(std::memory_order_acquire))
        : std::max(startSample, rawEndSample);
    const double recordEndSeconds = static_cast<double>(endSample) / sr;
    const double bpm = song.bpm > 0.0 ? song.bpm : 120.0;
    const double recordStartBeats = (recordStartSeconds * bpm) / 60.0;
    const double recordEndBeats = (recordEndSeconds * bpm) / 60.0;

    bool projectModified = false;
    double maxRecEndSec = 0.0;

    // 1. Commit recorded audio regions
    for (const auto& rec : recordedAudio) {
        if (rec.recordedFrames <= 0)
            continue;
        Region r;
        r.id = generateUuidV7();
        r.trackId = rec.trackId;
        r.startSeconds = recordStartSeconds;
        r.durationSeconds = static_cast<double>(rec.recordedFrames) / rec.sampleRate;
        r.gainDb = 0.0;
        if (!projectPath().empty() && rec.fullPath.find(projectPath()) == 0) {
            r.source.file = "Recordings/" + rec.filename;
        } else {
            r.source.file = rec.fullPath;
        }
        r.source.offsetSeconds = 0.0;
        r.fade.inSeconds = 0.005;
        r.fade.outSeconds = 0.005;
        maxRecEndSec = std::max(maxRecEndSec, r.startSeconds + r.durationSeconds);
        song.regions.push_back(std::move(r));
        projectModified = true;
    }

    // 2. Commit recorded MIDI regions (Logic Pro Merge vs Separate Region behavior)
    for (auto& session : activeMidiRecordSessions) {
        // Complete any notes that were still sounding when recording was stopped
        for (int p = 0; p < 128; ++p) {
            auto& activeNote = session.activeNotes[static_cast<size_t>(p)];
            if (activeNote.active && session.recordedNoteCount < TrackMidiRecordSession::kMaxSessionRecordedNotes) {
                MidiNote completed;
                completed.id = activeNote.id;
                completed.pitch = static_cast<uint8_t>(p);
                completed.velocity = activeNote.velocity;
                const double noteStartSec = static_cast<double>(activeNote.startSample) / sr;
                const double durSec = static_cast<double>(endSample - activeNote.startSample) / sr;
                completed.startBeats = (noteStartSec * bpm) / 60.0;
                completed.durationBeats = std::max(0.05, (durSec * bpm) / 60.0);
                session.recordedNotes[session.recordedNoteCount++] = completed;
                activeNote.active = false;
            }
        }

        if (session.recordedNoteCount > 0 || session.recordedEventCount > 0) {
            const auto appendRecordedEvents = [&](MidiRegion& region) {
                for (size_t i = 0; i < session.recordedEventCount; ++i) {
                    const auto& recorded = session.recordedEvents[i];
                    const double absoluteBeat = (static_cast<double>(recorded.sample) / sr * bpm) / 60.0;
                    const double regionBeat = midiRegionSourceBeat(
                        absoluteBeat - region.startBeats, region.clipOffsetBeats,
                        region.loopStartBeats, region.loopLengthBeats, region.loop);
                    if (regionBeat < 0.0) continue;
                    MidiClipEvent event;
                    event.beat = regionBeat;
                    event.status = recorded.status;
                    event.data = { recorded.data1, recorded.data2 };
                    region.events.push_back(std::move(event));
                }
                std::stable_sort(region.events.begin(), region.events.end(),
                    [](const MidiClipEvent& a, const MidiClipEvent& b) { return a.beat < b.beat; });
            };

            // Find existing MIDI region on this track containing recordStartBeats (Logic Pro Merge behavior)
            MidiRegion* targetRegion = nullptr;
            for (auto& mr : song.midiRegions) {
                if (mr.trackId == session.trackId) {
                    const double mrEndBeats = mr.startBeats + mr.durationBeats;
                    // Check if recording began within (or at the boundary of) this region
                    if (recordStartBeats >= (mr.startBeats - 0.25) && recordStartBeats <= (mrEndBeats + 0.25)) {
                        targetRegion = &mr;
                        break;
                    }
                }
            }

            if (targetRegion != nullptr) {
                // Merge notes into existing region
                for (size_t n = 0; n < session.recordedNoteCount; ++n) {
                    MidiNote note = session.recordedNotes[n];
                    note.startBeats = std::max(0.0, note.startBeats - targetRegion->startBeats);
                    if (note.startBeats + note.durationBeats > targetRegion->durationBeats) {
                        targetRegion->durationBeats = note.startBeats + note.durationBeats;
                    }
                    targetRegion->notes.push_back(note);
                }
                std::sort(targetRegion->notes.begin(), targetRegion->notes.end(),
                          [](const MidiNote& a, const MidiNote& b) {
                              return a.startBeats < b.startBeats;
                          });
                appendRecordedEvents(*targetRegion);
                const double rEndSec = ((targetRegion->startBeats + targetRegion->durationBeats) * 60.0) / bpm;
                maxRecEndSec = std::max(maxRecEndSec, rEndSec);
                projectModified = true;
            } else {
                // Outside existing region: create new distinct region (Logic Pro standard)
                MidiRegion mr;
                mr.id = generateUuidV7();
                mr.trackId = session.trackId;
                mr.name = "Recorded MIDI";
                mr.startBeats = recordStartBeats;
                const double durBeats = std::max(1.0, recordEndBeats - recordStartBeats);
                mr.durationBeats = durBeats;
                mr.notes.reserve(session.recordedNoteCount);
                for (size_t n = 0; n < session.recordedNoteCount; ++n) {
                    MidiNote note = session.recordedNotes[n];
                    note.startBeats = std::max(0.0, note.startBeats - mr.startBeats);
                    if (note.startBeats + note.durationBeats > mr.durationBeats) {
                        mr.durationBeats = note.startBeats + note.durationBeats;
                    }
                    mr.notes.push_back(note);
                }
                appendRecordedEvents(mr);
                std::sort(mr.notes.begin(), mr.notes.end(),
                          [](const MidiNote& a, const MidiNote& b) {
                              return a.startBeats < b.startBeats;
                          });
                const double rEndSec = ((mr.startBeats + mr.durationBeats) * 60.0) / bpm;
                maxRecEndSec = std::max(maxRecEndSec, rEndSec);
                song.midiRegions.push_back(std::move(mr));
                projectModified = true;
            }
        }
    }
    activeMidiRecordSessions.clear();

    // Auto-extend song if recording exceeded the song boundary
    if (projectModified && maxRecEndSec > 0.0) {
        const double beatsPerBar = static_cast<double>(song.timeSignature.numerator > 0 ? song.timeSignature.numerator : 4);
        const double barSec = (beatsPerBar * 60.0) / bpm;
        // Round up to nearest bar with 1 bar breathing room (Logic Pro behavior)
        const double candidateEndSec = std::ceil((maxRecEndSec + barSec * 0.5) / barSec) * barSec;
        if (song.endSeconds > 0.0) {
            if (candidateEndSec > song.endSeconds) {
                song.endSeconds = candidateEndSec;
            }
        } else {
            constexpr double kDefault64Bars = 64.0;
            const double default64Sec = (kDefault64Bars * beatsPerBar * 60.0) / bpm;
            if (candidateEndSec > default64Sec) {
                song.endSeconds = candidateEndSec;
            }
        }
    }

    if (projectModified) {
        if (hasRecordedContent)
            projectHistory.commitEdit(proj);
        markDirty();
        std::string err;
        (void)selectSong(currentSong, err, false, /*forceRestage=*/true);
        seekToSeconds(recordStartSeconds, err);
        publishRoutingSnapshot();
        rebuildTrackPeaks();
        if (onRecordingFinished) {
            onRecordingFinished();
        }
    }
}

void AudioEngine::toggleRecording(int targetTrackIndex) {
    if (isRecording()) {
        stopRecording();
    } else {
        startRecording(targetTrackIndex);
    }
}

bool AudioEngine::isRecording() const {
    return isRecordingState.load(std::memory_order_acquire);
}

bool AudioEngine::isRecordingCountIn() const {
    return isRecordingState.load(std::memory_order_acquire)
        && playing.load(std::memory_order_acquire)
        && clock.currentSamplePosition()
            < recordStartSamplePos.load(std::memory_order_acquire);
}

int AudioEngine::recordingCountInBeatsRemaining() const {
    if (!isRecordingCountIn() || !projectLoaded || currentSong >= loader.project().songs.size())
        return 0;
    const double bpm = std::max(1.0, loader.project().songs[currentSong].bpm);
    const double samplesPerBeat = std::max(1.0, currentSampleRate * 60.0 / bpm);
    const int64_t remaining = recordStartSamplePos.load(std::memory_order_acquire)
        - clock.currentSamplePosition();
    return std::max(0, static_cast<int>(std::ceil(static_cast<double>(remaining) / samplesPerBeat)));
}

std::vector<LiveRecordingRegionInfo> AudioEngine::getLiveRecordingRegions() const {
    auto result = audioRecordWorker.getLiveRegions();
    if (!isRecordingState.load(std::memory_order_acquire))
        return result;

    LiveMidiPreviewFrame frame;
    (void)liveMidiPreviewFrame.read(frame);
    const uint64_t previewGeneration = liveMidiPreviewGeneration.load(std::memory_order_acquire);
    const int64_t startSample = recordStartSamplePos.load(std::memory_order_acquire);
    const int64_t nowSample = std::max(startSample, clock.currentSamplePosition());

    result.reserve(result.size() + activeMidiRecordSessions.size());
    for (size_t sessionIndex = 0; sessionIndex < activeMidiRecordSessions.size(); ++sessionIndex) {
        LiveRecordingRegionInfo info;
        info.recordingId = "midi-live-" + activeMidiRecordSessions[sessionIndex].trackId;
        info.trackId = activeMidiRecordSessions[sessionIndex].trackId;
        info.timelineStartSample = startSample;
        info.capturedFrames = nowSample - startSample;
        info.channelCount = 0;
        info.state = LiveRecordingState::Capturing;
        info.kind = LiveRecordingKind::Midi;
        for (uint32_t i = 0;
             frame.generation == previewGeneration
                 && i < frame.noteCount
                 && i < LiveMidiPreviewFrame::kMaxNotes;
             ++i) {
            const auto& note = frame.notes[i];
            if (note.sessionIndex != sessionIndex) continue;
            info.midiNotes.push_back({
                note.id, note.pitch, note.startBeats, note.durationBeats,
                note.velocity, note.active
            });
        }
        result.push_back(std::move(info));
    }
    return result;
}

std::vector<AudioEngine::ActiveMidiNoteInfo> AudioEngine::getActiveMidiNotes() const {
    // Stop/seek requests are immediate from the UI's point of view. The audio
    // callback still owns the note counters and publishes the actual empty
    // frame at its next boundary, but do not expose the previous frame during
    // that hand-off window.
    if (activeMidiNotesClearRequested.load(std::memory_order_acquire))
        return {};

    ActiveMidiNotesFrame frame;
    (void)activeMidiNotesFrame.read(frame);
    std::vector<ActiveMidiNoteInfo> result;
    const size_t trackCount = std::min(trackIdByIndex.size(), kMaxActiveMidiTracks);
    for (size_t track = 0; track < trackCount; ++track) {
        for (int pitch = 0; pitch < 128; ++pitch) {
            if ((frame.masks[track][static_cast<size_t>(pitch) / 64]
                 & (uint64_t{1} << (static_cast<unsigned>(pitch) % 64))) != 0) {
                result.push_back({trackIdByIndex[track], pitch, track});
            }
        }
    }
    return result;
}

void AudioEngine::updateActiveMidiNote(size_t strip, int pitch, bool noteOn) {
    if (strip >= kMaxActiveMidiTracks || pitch < 0 || pitch >= static_cast<int>(kMidiPitchCount))
        return;
    auto& count = activeMidiNoteCounts[strip][static_cast<size_t>(pitch)];
    const bool wasActive = count != 0;
    if (noteOn) {
        if (count < std::numeric_limits<uint8_t>::max()) ++count;
    } else if (count != 0) {
        --count;
    }
    if (wasActive == (count != 0)) return;

    auto& mask = activeMidiNotesWorkingFrame.masks[strip][static_cast<size_t>(pitch) / 64];
    const uint64_t bit = uint64_t{1} << (static_cast<unsigned>(pitch) % 64);
    if (count != 0) mask |= bit;
    else mask &= ~bit;
    activeMidiNotesFrame.write(activeMidiNotesWorkingFrame);
}

void AudioEngine::clearActiveMidiNotes(uint64_t targetHostTimeNanos) {
    for (auto& track : activeMidiNoteCounts) track.fill(0);
    for (auto& track : liveMidiNoteCounts)
        for (auto& channel : track) channel.fill(0);
    uint16_t activeExternalChannels = activeExternalMidiChannelMask;
    const size_t trackCount = std::min(trackIdByIndex.size(), kMaxActiveMidiTracks);
    for (size_t strip = 0; strip < sequencedMidiNoteCounts.size(); ++strip) {
        const TrackDef* track = strip < trackCount ? trackDefAt(strip) : nullptr;
        const bool external = track != nullptr
            && (track->kind == TrackKind::ExternalMIDI
                || track->kind == TrackKind::MIDI);
        for (size_t channel = 0; channel < 16; ++channel) {
            auto& pitches = sequencedMidiNoteCounts[strip][channel];
            if (external && std::any_of(pitches.begin(), pitches.end(),
                                        [](uint8_t count) { return count != 0; })) {
                activeExternalChannels |= static_cast<uint16_t>(1u << channel);
            }
            pitches.fill(0);
        }
    }
    activeExternalMidiChannelMask = 0;

    // CC 123 is bounded to one event per active channel, unlike issuing a
    // Note-Off for every overlapping voice. It also clears external notes
    // whose scheduled Note-On has reached the device but whose matching
    // region Note-Off lies beyond the relocation/stop point.
    for (uint8_t channel = 0; channel < 16; ++channel) {
        if ((activeExternalChannels & static_cast<uint16_t>(1u << channel)) == 0)
            continue;
        MidiCommand command;
        command.kind = MidiCommandKind::ControlChange;
        command.channel = channel;
        command.data1 = 123; // All Notes Off
        command.data2 = 0;
        command.targetHostTimeNanos = targetHostTimeNanos;
        midiDispatcher.enqueue(command);
    }
    sequencedMidiFlushAtBlockStart = false;
    activeMidiNotesWorkingFrame = {};
    activeMidiNotesFrame.write(activeMidiNotesWorkingFrame);
}

void AudioEngine::publishLiveMidiPreview(double bpm, int64_t playheadSample) {
    LiveMidiPreviewFrame frame;
    frame.generation = liveMidiPreviewGeneration.load(std::memory_order_relaxed);
    const double safeRate = currentSampleRate > 0.0 ? currentSampleRate : 48000.0;
    const double safeBpm = bpm > 0.0 ? bpm : 120.0;

    for (size_t sessionIndex = 0; sessionIndex < activeMidiRecordSessions.size(); ++sessionIndex) {
        const auto& session = activeMidiRecordSessions[sessionIndex];
        const size_t completedToCopy = std::min(
            session.recordedNoteCount,
            LiveMidiPreviewFrame::kMaxNotes - frame.noteCount);
        const size_t completedStart = session.recordedNoteCount - completedToCopy;
        for (size_t n = completedStart; n < session.recordedNoteCount && frame.noteCount < LiveMidiPreviewFrame::kMaxNotes; ++n) {
            const auto& source = session.recordedNotes[n];
            auto& dest = frame.notes[frame.noteCount++];
            dest.sessionIndex = static_cast<uint16_t>(sessionIndex);
            dest.id = source.id;
            dest.pitch = source.pitch;
            dest.velocity = source.velocity;
            dest.startBeats = source.startBeats;
            dest.durationBeats = source.durationBeats;
            dest.active = false;
        }
        for (const auto& source : session.activeNotes) {
            if (!source.active || frame.noteCount >= LiveMidiPreviewFrame::kMaxNotes) continue;
            auto& dest = frame.notes[frame.noteCount++];
            dest.sessionIndex = static_cast<uint16_t>(sessionIndex);
            dest.id = source.id;
            dest.pitch = source.pitch;
            dest.velocity = source.velocity;
            dest.startBeats = (static_cast<double>(source.startSample) / safeRate) * safeBpm / 60.0;
            dest.durationBeats = std::max(
                0.0,
                (static_cast<double>(playheadSample - source.startSample) / safeRate) * safeBpm / 60.0);
            dest.active = true;
        }
    }
    liveMidiPreviewFrame.write(frame);
}

std::vector<PeakPair16> AudioEngine::getLiveRecordingPeaks(const std::string& trackId, size_t level, size_t first, size_t count) const {
    return audioRecordWorker.getPeakChunk(trackId, level, first, count);
}

} // namespace resostage

