/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"
#include "audio/graph/ProjectPlaybackSnapshot.h"
#include "audio/graph/SongActivityIndex.h"

#include <chrono>
#include <cmath>
#include <limits>
#include <memory>
#include <string>
#include <vector>

using namespace resostage;

TEST_SUITE("SongActivity") {

TEST_CASE("Activity preparation reuses coefficient, processor and locator publications") {
    MixGraph previous;
    previous.projectEpoch = 7;
    previous.routingLayoutKey = 13;
    MixGraph next = previous;
    next.processorLayoutKey = 100;
    next.latencyLayoutKey = 101;
    CHECK_FALSE(needsActivityPreparation(false, &previous, next));
    CHECK(needsActivityPreparation(true, &previous, next));
    CHECK(needsActivityPreparation(false, nullptr, next));
    next.projectEpoch++;
    CHECK(needsActivityPreparation(false, &previous, next));
    next = previous;
    next.routingLayoutKey++;
    CHECK(needsActivityPreparation(false, &previous, next));
}

TEST_CASE("ProjectPlaybackSnapshot is immutable, revisioned, and bounded") {
    Project project;
    TrackDef track;
    track.id = "track-1";
    track.kind = TrackKind::Instrument;
    track.recordArmed = true;
    track.inputMonitoring = true;
    project.tracks.push_back(track);

    SongDef song;
    song.id = "song-1";
    song.bpm = 123.0;
    song.timeSignature = {7, 8};
    Region region;
    region.id = "region-1";
    region.trackId = track.id;
    region.startSeconds = 2.0;
    region.durationSeconds = 3.0;
    song.regions.push_back(region);
    MidiRegion midiRegion;
    midiRegion.id = "midi-region-1";
    midiRegion.trackId = track.id;
    midiRegion.notes.push_back(MidiNote{});
    song.midiRegions.push_back(midiRegion);
    AutomationLane lane;
    lane.id = "lane-1";
    lane.target.entityId = track.id;
    lane.target.parameterId = "pan";
    lane.points.push_back({0.0, 0.25f, 0.0f});
    song.automationLanes.push_back(lane);
    TimelineEvent event;
    event.id = "event-1";
    event.timeSeconds = 1.0;
    song.events.push_back(event);
    project.songs.push_back(song);
    project.click.enabled = true;

    const auto graph = buildMixGraph(project, OutputLaneConfig{});
    constexpr uint64_t epoch = 11;
    constexpr uint64_t revision = 4;
    auto first = buildProjectPlaybackSnapshot(project, graph, epoch, revision, nullptr, true);
    REQUIRE(first.snapshot != nullptr);
    REQUIRE(first.snapshot->content != nullptr);
    REQUIRE(first.snapshot->tracks.size() == 1);
    REQUIRE(first.snapshot->content->songs.size() == 1);
    CHECK(first.snapshot->tracks[0].recordArmed);
    CHECK(first.snapshot->tracks[0].inputMonitoring);
    CHECK(first.snapshot->tracks[0].stripIndex == graph.find(track.id));
    CHECK(first.snapshot->clickEnabled);
    CHECK(first.snapshot->content->songs[0].bpm == doctest::Approx(123.0));
    CHECK(first.snapshot->content->songs[0].timeSignature.numerator == 7);
    REQUIRE(first.snapshot->content->songs[0].regions.size() == 1);
    REQUIRE(first.snapshot->content->songs[0].midiRegions.size() == 1);
    CHECK(first.snapshot->content->songs[0].automationLanes[0].points[0].value == doctest::Approx(0.25f));

    project.tracks[0].recordArmed = false;
    project.tracks[0].inputMonitoring = false;
    project.click.enabled = false;
    project.songs[0].regions[0].gainDb = -12.0;
    project.songs[0].midiRegions[0].notes[0].pitch = 48;
    project.songs[0].events[0].timeSeconds = 9.0;

    CHECK(first.snapshot->tracks[0].recordArmed);
    CHECK(first.snapshot->tracks[0].inputMonitoring);
    CHECK(first.snapshot->clickEnabled);
    CHECK(first.snapshot->content->songs[0].regions[0].gainDb == doctest::Approx(0.0));
    CHECK(first.snapshot->content->songs[0].midiRegions[0].notes[0].pitch == 60);
    CHECK(first.snapshot->content->songs[0].events[0].timeSeconds == doctest::Approx(1.0));

    auto coefficientOnly = buildProjectPlaybackSnapshot(
        project, graph, epoch, revision, first.snapshot, false);
    REQUIRE(coefficientOnly.snapshot != nullptr);
    CHECK(coefficientOnly.snapshot->content == first.snapshot->content);
    CHECK_FALSE(coefficientOnly.snapshot->tracks[0].recordArmed);
    CHECK_FALSE(coefficientOnly.snapshot->clickEnabled);
    CHECK(coefficientOnly.snapshot->content->songs[0].regions[0].gainDb == doctest::Approx(0.0));

    auto contentEdit = buildProjectPlaybackSnapshot(
        project, graph, epoch, revision + 1, coefficientOnly.snapshot, true);
    REQUIRE(contentEdit.snapshot != nullptr);
    CHECK(contentEdit.snapshot->content != coefficientOnly.snapshot->content);
    CHECK(contentEdit.snapshot->content->songs[0].regions[0].gainDb == doctest::Approx(-12.0));
    CHECK(contentEdit.snapshot->content->songs[0].midiRegions[0].notes[0].pitch == 48);
    CHECK(contentEdit.snapshot->content->songs[0].events[0].timeSeconds == doctest::Approx(9.0));

    Project oversized;
    oversized.tracks.resize(ProjectPlaybackSnapshot::kMaximumTracks + 1);
    const auto rejected = buildProjectPlaybackSnapshot(
        oversized, graph, epoch, revision, nullptr, true);
    CHECK(rejected.snapshot == nullptr);
    CHECK_FALSE(rejected.error.empty());
}

TEST_CASE("ProjectActivityIndex rejects a stale content revision") {
    Project project;
    SongDef song;
    song.id = "song-1";
    project.songs.push_back(song);
    MixGraph graph;
    graph.projectEpoch = 5;
    graph.contentRevision = 7;
    auto activity = buildProjectActivityIndex(project, graph, 5, 48000.0);
    REQUIRE(activity != nullptr);
    CHECK(activity->songAt(0, project.songs[0], graph, 5, 48000.0) != nullptr);
    graph.contentRevision++;
    CHECK(activity->songAt(0, project.songs[0], graph, 5, 48000.0) == nullptr);
}

TEST_CASE("SongActivityIndex: indexed lookahead pre-warming benchmark and correctness") {
    MixGraph graph;
    MixStrip s0;
    s0.id = "track-1";
    s0.kind = StripKind::Track;
    s0.projectIndex = 0;
    graph.strips.push_back(s0);
    graph.indexById[s0.id] = 0;

    MixStrip s1;
    s1.id = "track-2";
    s1.kind = StripKind::Track;
    s1.projectIndex = 1;
    graph.strips.push_back(s1);
    graph.indexById[s1.id] = 1;

    SongDef song;
    song.id = "song-1";
    song.bpm = 120.0;
    song.timeSignature = {4, 4};

    SUBCASE("Interval merging, MIDI beat mapping and boundary detection") {
        // Track 1 has overlapping audio regions: [1.0, 3.0] and [2.5, 5.0] -> should merge to [1.0, 5.0]
        Region r1;
        r1.trackId = "track-1";
        r1.startSeconds = 1.0;
        r1.durationSeconds = 2.0;
        song.regions.push_back(r1);

        Region r2;
        r2.trackId = "track-1";
        r2.startSeconds = 2.5;
        r2.durationSeconds = 2.5;
        song.regions.push_back(r2);

        // Track 2 has MIDI region: start 8 beats (4.0s @ 120bpm), duration 4 beats (2.0s) -> [4.0, 6.0]
        MidiRegion m1;
        m1.trackId = "track-2";
        m1.startBeats = 8.0;
        m1.durationBeats = 4.0;
        m1.muted = false;
        song.midiRegions.push_back(m1);

        // Muted MIDI region on track 2 -> must be ignored
        MidiRegion m2;
        m2.trackId = "track-2";
        m2.startBeats = 16.0;
        m2.durationBeats = 4.0;
        m2.muted = true;
        song.midiRegions.push_back(m2);

        TempoMap tempoMap(120.0);
        auto index = buildSongActivityIndex(song, graph, tempoMap, 1, 48000.0);
        REQUIRE(index != nullptr);
        CHECK(index->isCompatible(song, graph, 1, 48000.0));
        CHECK_FALSE(index->isCompatible(song, graph, 2, 48000.0)); // Wrong epoch
        REQUIRE(index->stripPlans.size() == 2);

        // Track 1 strip plan
        const auto& p0 = index->stripPlans[0];
        CHECK(p0.stripIndex == 0);
        REQUIRE(p0.intervals.size() == 1);
        CHECK(p0.intervals[0].startSeconds == doctest::Approx(1.0));
        CHECK(p0.intervals[0].endSeconds == doctest::Approx(5.0));

        // Track 2 strip plan
        const auto& p1 = index->stripPlans[1];
        CHECK(p1.stripIndex == 1);
        REQUIRE(p1.intervals.size() == 1);
        CHECK(p1.intervals[0].startSeconds == doctest::Approx(4.0));
        CHECK(p1.intervals[0].endSeconds == doctest::Approx(6.0));

        // Test intersection query:
        // Before all regions: [0.0, 0.5) -> neither
        CHECK_FALSE(p0.intersects(0.0, 0.5));
        CHECK_FALSE(p1.intersects(0.0, 0.5));

        // Enters 2-bar horizon for track 1: [0.0, 1.5) -> intersects p0 only
        CHECK(p0.intersects(0.0, 1.5));
        CHECK_FALSE(p1.intersects(0.0, 1.5));

        // At 3.5s with 1.0s lookahead [3.5, 4.5) -> intersects both p0 and p1
        CHECK(p0.intersects(3.5, 4.5));
        CHECK(p1.intersects(3.5, 4.5));

        // After all regions: [7.0, 8.0) -> neither
        CHECK_FALSE(p0.intersects(7.0, 8.0));
        CHECK_FALSE(p1.intersects(7.0, 8.0));

        // Edge case: Inverted interval [5.0, 2.0) or zero-width -> strictly false
        CHECK_FALSE(p0.intersects(5.0, 2.0));
        CHECK_FALSE(p0.intersects(2.0, 2.0));

        // Edge case: Non-finite / NaN values -> strictly false
        constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
        CHECK_FALSE(p0.intersects(kNaN, 2.0));
        CHECK_FALSE(p0.intersects(1.0, kNaN));
        CHECK_FALSE(p0.intersects(kNaN, kNaN));

        // Edge case: Empty strip plan -> strictly false
        StripActivityPlan emptyPlan;
        CHECK_FALSE(emptyPlan.intersects(0.0, 10.0));
    }

    SUBCASE("Corrupt and extreme inputs filtering") {
        SongDef corruptSong;
        corruptSong.id = "corrupt-song";
        corruptSong.bpm = 120.0;

        Region negDur;
        negDur.trackId = "track-1";
        negDur.startSeconds = 1.0;
        negDur.durationSeconds = -5.0; // Invalid
        corruptSong.regions.push_back(negDur);

        Region nanStart;
        nanStart.trackId = "track-1";
        nanStart.startSeconds = std::numeric_limits<double>::quiet_NaN();
        nanStart.durationSeconds = 2.0;
        corruptSong.regions.push_back(nanStart);

        MidiRegion negMidi;
        negMidi.trackId = "track-2";
        negMidi.startBeats = 4.0;
        negMidi.durationBeats = -2.0;
        corruptSong.midiRegions.push_back(negMidi);

        TempoMap tempoMap(120.0);
        auto index = buildSongActivityIndex(corruptSong, graph, tempoMap, 1, 48000.0);
        REQUIRE(index != nullptr);
        // All corrupt regions must be sanitized/discarded without throwing or crashing
        CHECK(index->stripPlans.empty());
    }

    SUBCASE("Legitimate negative pickup offsets and count-in") {
        SongDef pickupSong;
        pickupSong.id = "pickup-song";
        pickupSong.bpm = 120.0;

        Region pickup;
        pickup.trackId = "track-1";
        pickup.startSeconds = -0.5; // Starts half a second before bar 1
        pickup.durationSeconds = 1.0; // [-0.5, 0.5]
        pickupSong.regions.push_back(pickup);

        TempoMap tempoMap(120.0);
        auto index = buildSongActivityIndex(pickupSong, graph, tempoMap, 1, 48000.0);
        REQUIRE(index != nullptr);
        REQUIRE(index->stripPlans.size() == 1);
        const auto& plan = index->stripPlans[0];
        CHECK(plan.intervals[0].startSeconds == doctest::Approx(-0.5));
        CHECK(plan.intervals[0].endSeconds == doctest::Approx(0.5));

        // Intersects during count-in [-2.0, -0.2)
        CHECK(plan.intersects(-2.0, -0.2));
        // Does not intersect before pickup [-4.0, -1.0)
        CHECK_FALSE(plan.intersects(-4.0, -1.0));
    }

    SUBCASE("Benchmark: 10,000 regions linear scan vs indexed lookup") {
        constexpr int kNumRegions = 10000;
        song.regions.clear();
        song.midiRegions.clear();
        song.regions.reserve(kNumRegions);

        for (int i = 0; i < kNumRegions; ++i) {
            Region r;
            r.trackId = (i % 2 == 0) ? "track-1" : "track-2";
            r.startSeconds = static_cast<double>(i) * 0.05;
            r.durationSeconds = 0.04;
            song.regions.push_back(r);
        }

        TempoMap tempoMap(120.0);
        auto index = buildSongActivityIndex(song, graph, tempoMap, 1, 48000.0);
        REQUIRE(index != nullptr);

        constexpr int kBlocks = 1000;
        const double horizon = 2.0 * (4.0 * 60.0 / 120.0); // 2 bars = 4.0 seconds

        const auto startLinear = std::chrono::steady_clock::now();
        uint32_t linearWakeCount = 0;
        for (int b = 0; b < kBlocks; ++b) {
            const double curSec = static_cast<double>(b * 256) / 48000.0;
            const double endSec = curSec + horizon;
            for (const auto& reg : song.regions) {
                const double rStart = reg.startSeconds;
                const double rEnd = reg.startSeconds + reg.durationSeconds;
                if (rEnd > curSec && rStart < endSec) {
                    const uint32_t stripIdx = graph.find(reg.trackId);
                    if (stripIdx != MixGraph::kNoStrip) {
                        linearWakeCount++;
                    }
                }
            }
        }
        const auto linearDuration = std::chrono::duration<double, std::micro>(
            std::chrono::steady_clock::now() - startLinear).count();

        const auto startIndexed = std::chrono::steady_clock::now();
        uint32_t indexedWakeCount = 0;
        for (int b = 0; b < kBlocks; ++b) {
            const double curSec = static_cast<double>(b * 256) / 48000.0;
            const double endSec = curSec + horizon;
            for (const auto& plan : index->stripPlans) {
                if (plan.intersects(curSec, endSec)) {
                    indexedWakeCount++;
                }
            }
        }
        const auto indexedDuration = std::chrono::duration<double, std::micro>(
            std::chrono::steady_clock::now() - startIndexed).count();

        const double linearUsPerBlock = linearDuration / kBlocks;
        const double indexedUsPerBlock = indexedDuration / kBlocks;
        const double speedup = linearDuration / std::max(0.001, indexedDuration);

        CHECK(linearWakeCount > 0);
        CHECK(indexedWakeCount > 0);

        MESSAGE("10,000 regions prewarm: linear " << linearUsPerBlock << " µs/block vs indexed "
                << indexedUsPerBlock << " µs/block (Speedup: " << speedup << "x)");

        CHECK(indexedUsPerBlock < 2.0); // Sub-2 microsecond budget on deadline
        CHECK(speedup > 10.0);
    }
}

TEST_CASE("ProjectActivityIndex binds each gapless song to its own prepared tempo map") {
    MixGraph graph;
    graph.routingLayoutKey = 31;
    MixStrip track;
    track.id = "audio::track:1";
    track.kind = StripKind::Track;
    graph.strips.push_back(track);
    graph.indexById[track.id] = 0;

    Project project;
    const std::array<double, 4> bpms{120.0, 60.0, 120.0, 60.0};
    for (size_t songIndex = 0; songIndex < bpms.size(); ++songIndex) {
        SongDef song;
        song.id = "meta::song:" + std::to_string(songIndex + 1);
        song.bpm = bpms[songIndex];
        MidiRegion region;
        region.trackId = track.id;
        region.startBeats = 8.0;
        region.durationBeats = 4.0;
        song.midiRegions.push_back(region);
        project.songs.push_back(std::move(song));
    }
    project.songs[2].tempoPoints = {{0.0, 120.0, 0.0, 0.0}, {8.0, 60.0, 0.0, 0.0}};
    project.songs[3].tempoPoints = {{0.0, 60.0, 0.0, 1.0}, {8.0, 120.0, 0.0, 0.0}};
    project.songs[3].midiRegions[0].startBeats = 4.0;
    project.songs[3].midiRegions[0].durationBeats = 8.0;

    const auto index = buildProjectActivityIndex(project, graph, 7, 48000.0);
    REQUIRE(index != nullptr);
    REQUIRE(index->songs.size() == project.songs.size());
    const std::array<double, 4> expectedStarts{4.0, 8.0, 4.0, 8.0 * std::log(1.5)};
    const std::array<double, 4> expectedEnds{6.0, 12.0, 8.0, 8.0 * std::log(2.0) + 2.0};

    // Gapless promotion selects a row from one already-owned publication;
    // neither the previous song's index nor its tempo map may be reused.
    for (size_t songIndex = 0; songIndex < project.songs.size(); ++songIndex) {
        const auto* row = index->songAt(songIndex, project.songs[songIndex], graph, 7, 48000.0);
        REQUIRE(row != nullptr);
        CHECK(row == index->songs[songIndex].get());
        REQUIRE(row->tempoMap != nullptr);
        REQUIRE(row->stripPlans.size() == 1);
        REQUIRE(row->stripPlans[0].intervals.size() == 1);
        CHECK(row->stripPlans[0].intervals[0].startSeconds == doctest::Approx(expectedStarts[songIndex]));
        CHECK(row->stripPlans[0].intervals[0].endSeconds == doctest::Approx(expectedEnds[songIndex]));
        CHECK(row->tempoMap->beatsToSeconds(project.songs[songIndex].midiRegions[0].startBeats)
              == doctest::Approx(expectedStarts[songIndex]));
        CHECK(row->tempoMap->beatsToSamples(project.songs[songIndex].midiRegions[0].startBeats, 48000.0)
              == std::llround(expectedStarts[songIndex] * 48000.0));
        CHECK(row->intersects(0, expectedStarts[songIndex], expectedEnds[songIndex]));
        CHECK_FALSE(row->intersects(0, expectedStarts[songIndex] - 1.0, expectedStarts[songIndex]));
        CHECK_FALSE(row->intersects(0, expectedEnds[songIndex], expectedEnds[songIndex] + 1.0));
        CHECK_FALSE(row->intersects(MixGraph::kNoStrip, 0.0, 100.0));
        if (songIndex > 0) {
            CHECK(row->tempoMap.get() != index->songs[songIndex - 1]->tempoMap.get());
            CHECK(index->songAt(songIndex, project.songs[songIndex - 1], graph, 7, 48000.0) == nullptr);
        }
    }

    const auto* first = index->songAt(0, project.songs[0], graph, 7, 48000.0);
    for (int hop = 0; hop < 1000; ++hop) {
        CHECK(index->songAt(1, project.songs[1], graph, 7, 48000.0) == index->songs[1].get());
        CHECK(index->songAt(0, project.songs[0], graph, 7, 48000.0) == first);
    }
}

TEST_CASE("ProjectActivityIndex rejects incompatible row selection and retains coefficient-only compatibility") {
    Project project;
    SongDef song;
    song.id = "meta::song:1";
    project.songs.push_back(song);
    MixGraph graph;
    graph.routingLayoutKey = 42;
    graph.processorLayoutKey = 100;
    MixStrip track;
    track.id = "audio::track:1";
    track.kind = StripKind::Track;
    graph.strips.push_back(track);
    graph.indexById[track.id] = 0;

    const auto index = buildProjectActivityIndex(project, graph, 9, 48000.0);
    REQUIRE(index != nullptr);
    const auto* prepared = index->songAt(0, song, graph, 9, 48000.0);
    REQUIRE(prepared != nullptr);
    CHECK(index->songAt(1, song, graph, 9, 48000.0) == nullptr);
    CHECK(index->songAt(std::numeric_limits<size_t>::max(), song, graph, 9, 48000.0) == nullptr);
    CHECK(index->songAt(0, song, graph, 10, 48000.0) == nullptr);
    CHECK(index->songAt(0, song, graph, 9, 44100.0) == nullptr);
    CHECK(index->songAt(0, song, graph, 9, std::numeric_limits<double>::quiet_NaN()) == nullptr);
    CHECK(index->songAt(0, song, graph, 9, std::numeric_limits<double>::infinity()) == nullptr);

    SongDef otherSong = song;
    otherSong.id = "meta::song:2";
    CHECK(index->songAt(0, otherSong, graph, 9, 48000.0) == nullptr);
    MixGraph changedLayout = graph;
    ++changedLayout.routingLayoutKey;
    CHECK(index->songAt(0, song, changedLayout, 9, 48000.0) == nullptr);

    // Fader/pan and insert-chain publications do not change strip identity;
    // an existing activity row stays valid without project-sized rebuilding.
    MixGraph coefficientEdit = graph;
    coefficientEdit.strips[0].gainLinear = 0.25f;
    coefficientEdit.strips[0].pan = 0.8f;
    ++coefficientEdit.processorLayoutKey;
    CHECK(index->songAt(0, song, coefficientEdit, 9, 48000.0) == prepared);
}

TEST_CASE("ProjectActivityIndex snapshots keep merged intervals and tempo alive across replacement") {
    MixGraph graph;
    graph.routingLayoutKey = 7;
    for (const std::string id : {"audio::track:1", "audio::track:2"}) {
        MixStrip track;
        track.id = id;
        track.kind = StripKind::Track;
        graph.indexById[id] = static_cast<uint32_t>(graph.strips.size());
        graph.strips.push_back(track);
    }
    Project project;
    SongDef song;
    song.id = "meta::song:1";
    song.bpm = 120.0;
    for (const double start : {1.0, 2.0, 8.0}) {
        Region audio;
        audio.trackId = "audio::track:1";
        audio.startSeconds = start;
        audio.durationSeconds = 1.0;
        song.regions.push_back(audio);
    }
    MidiRegion midi;
    midi.trackId = "audio::track:2";
    midi.startBeats = 8.0;
    midi.durationBeats = 4.0;
    song.midiRegions.push_back(midi);
    midi.muted = true;
    midi.startBeats = 100.0;
    song.midiRegions.push_back(midi);
    Region absent;
    absent.trackId = "audio::deleted-track";
    absent.durationSeconds = 2.0;
    song.regions.push_back(absent);
    project.songs.push_back(song);

    auto published = buildProjectActivityIndex(project, graph, 1, 48000.0);
    REQUIRE(published != nullptr);
    const auto* previous = published->songAt(0, project.songs[0], graph, 1, 48000.0);
    REQUIRE(previous != nullptr);
    REQUIRE(previous->stripPlans.size() == 2);
    REQUIRE(previous->stripPlans[0].intervals.size() == 2);
    CHECK(previous->stripPlans[0].intervals[0].startSeconds == 1.0);
    CHECK(previous->stripPlans[0].intervals[0].endSeconds == 3.0);
    CHECK(previous->stripPlans[0].intervals[1].startSeconds == 8.0);
    CHECK(previous->stripPlans[0].intervals[1].endSeconds == 9.0);
    REQUIRE(previous->stripPlans[1].intervals.size() == 1);
    CHECK(previous->intersects(1, 4.0, 6.0));
    CHECK_FALSE(previous->intersects(1, 50.0, 52.0));

    const std::weak_ptr<const ProjectActivityIndex> previousIndex = published;
    const std::weak_ptr<const TempoMap> previousTempo = previous->tempoMap;
    auto retainedPublication = published;
    CHECK(retainedPublication->tempoMapsUnreferenced());
    auto activeTempo = previous->tempoMap;
    CHECK_FALSE(retainedPublication->tempoMapsUnreferenced());
    // The message thread replaces the publication after a content/tempo edit;
    // the retirement owner keeps callback raw row views valid until released.
    project.songs[0].regions.clear();
    project.songs[0].bpm = 60.0;
    published = buildProjectActivityIndex(project, graph, 1, 48000.0);
    REQUIRE(published != nullptr);
    const auto* replacement = published->songAt(0, project.songs[0], graph, 1, 48000.0);
    REQUIRE(replacement != nullptr);
    CHECK(replacement != previous);
    CHECK_FALSE(replacement->intersects(0, 1.0, 3.0));
    CHECK(replacement->intersects(1, 8.0, 12.0));
    CHECK_FALSE(replacement->intersects(1, 4.0, 6.0));
    CHECK(previous->intersects(0, 1.0, 3.0));
    CHECK(activeTempo->beatsToSeconds(8.0) == 4.0);
    CHECK(replacement->tempoMap->beatsToSeconds(8.0) == 8.0);
    CHECK_FALSE(previousIndex.expired());
    CHECK(retainedPublication.use_count() == 1);
    CHECK_FALSE(retainedPublication->tempoMapsUnreferenced());
    CHECK_FALSE(previousTempo.expired());
    activeTempo.reset();
    CHECK(retainedPublication->tempoMapsUnreferenced());
    CHECK_FALSE(previousTempo.expired());
    // Nested tempo owners, not just the top-level publication refcount,
    // decide when the message-thread retirement queue can reclaim this row.
    retainedPublication.reset();
    CHECK(previousIndex.expired());
    CHECK(previousTempo.expired());
}

TEST_CASE("ProjectActivityIndex enforces song and aggregate tempo budgets before preparation") {
    MixGraph graph;
    SUBCASE("Empty projects remain a valid bounded publication") {
        const auto index = buildProjectActivityIndex(Project{}, graph, 1, 48000.0);
        REQUIRE(index != nullptr);
        CHECK(index->songs.empty());
        CHECK(index->tempoMapsUnreferenced());
        CHECK(index->songAt(0, SongDef{}, graph, 1, 48000.0) == nullptr);
    }
    SUBCASE("The exact song limit is supported and its next row is rejected") {
        Project project;
        project.songs.resize(ProjectActivityIndex::kMaximumSongs);
        for (size_t i = 0; i < project.songs.size(); ++i)
            project.songs[i].id = "meta::song:" + std::to_string(i + 1);
        const auto index = buildProjectActivityIndex(project, graph, 1, 48000.0);
        REQUIRE(index != nullptr);
        CHECK(index->songs.size() == ProjectActivityIndex::kMaximumSongs);
        CHECK(index->songAt(project.songs.size() - 1, project.songs.back(), graph, 1, 48000.0) != nullptr);
        project.songs.emplace_back();
        CHECK(buildProjectActivityIndex(project, graph, 1, 48000.0) == nullptr);
    }
    SUBCASE("Tempo points are budgeted across songs, not independently") {
        Project project;
        project.songs.resize(2);
        for (size_t i = 0; i < project.songs.size(); ++i) {
            auto& song = project.songs[i];
            song.id = "meta::song:" + std::to_string(i + 1);
            song.tempoPoints.resize(ProjectActivityIndex::kMaximumTempoPoints / 2);
            for (size_t point = 0; point < song.tempoPoints.size(); ++point) {
                song.tempoPoints[point].beat = static_cast<double>(point);
                song.tempoPoints[point].bpm = 120.0;
            }
        }
        const auto index = buildProjectActivityIndex(project, graph, 1, 48000.0);
        REQUIRE(index != nullptr);
        REQUIRE(index->songs.size() == 2);
        CHECK(index->songs[0]->tempoMap->points().size() == ProjectActivityIndex::kMaximumTempoPoints / 2);
        CHECK(index->songs[1]->tempoMap->points().size() == ProjectActivityIndex::kMaximumTempoPoints / 2);
        project.songs[1].tempoPoints.push_back(TempoPoint{});
        CHECK(buildProjectActivityIndex(project, graph, 1, 48000.0) == nullptr);
    }
}

} // TEST_SUITE
