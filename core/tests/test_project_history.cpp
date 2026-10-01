/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "project/ProjectHistory.h"
#include "project/HistoryRestore.h"

using namespace resostage;

namespace {

Project makeProjectWithRegions(std::initializer_list<const char*> regionIds) {
    Project p;
    SongDef song;
    song.id = "song_1";
    for (const char* id : regionIds) {
        Region r;
        r.id = id;
        r.trackId = "track_1";
        song.regions.push_back(r);
    }
    p.songs.push_back(song);
    return p;
}

} // namespace

TEST_CASE("ProjectHistory basic undo/redo round-trip") {
    ProjectHistory history;
    CHECK_FALSE(history.canUndo());
    CHECK_FALSE(history.canRedo());

    Project before = makeProjectWithRegions({"reg_a"});
    history.beginEdit(before, "", "Add region");

    Project after = before;
    after.songs[0].regions.push_back(Region{});
    after.songs[0].regions.back().id = "reg_b";
    history.commitEdit(after);

    REQUIRE(history.canUndo());
    CHECK_FALSE(history.canRedo());
    CHECK(history.undoLabel() == "Add region");

    auto undone = history.undo();
    REQUIRE(undone.has_value());
    CHECK(undone->songs[0].regions.size() == 1);
    CHECK(undone->songs[0].regions[0].id == "reg_a");
    CHECK_FALSE(history.canUndo());
    CHECK(history.canRedo());

    auto redone = history.redo();
    REQUIRE(redone.has_value());
    CHECK(redone->songs[0].regions.size() == 2);
    CHECK(redone->songs[0].regions[1].id == "reg_b");
    CHECK(history.canUndo());
    CHECK_FALSE(history.canRedo());
}

TEST_CASE("ProjectHistory coalesces begin/commit pairs sharing a gestureId into one undo step") {
    ProjectHistory history;

    Project state = makeProjectWithRegions({});
    const std::string gestureId = "duplicate-gesture-1";

    // Simulate "duplicate 3 regions": 3 begin/commit pairs, same gestureId.
    for (int i = 0; i < 3; ++i) {
        Project before = state;
        history.beginEdit(before, gestureId, "Duplicate regions");
        Region r;
        r.id = "reg_" + std::to_string(i);
        state.songs[0].regions.push_back(r);
        history.commitEdit(state);
    }

    REQUIRE(history.canUndo());
    CHECK(history.undoLabel() == "Duplicate regions");

    auto undone = history.undo();
    REQUIRE(undone.has_value());
    // All 3 additions must be undone in ONE step, back to zero regions.
    CHECK(undone->songs[0].regions.empty());
    CHECK_FALSE(history.canUndo());

    auto redone = history.redo();
    REQUIRE(redone.has_value());
    CHECK(redone->songs[0].regions.size() == 3);
}

TEST_CASE("ProjectHistory starts a new step when gestureId differs or is empty") {
    ProjectHistory history;
    Project state = makeProjectWithRegions({});

    history.beginEdit(state, "gesture-a", "Step 1");
    state.songs[0].regions.push_back(Region{});
    history.commitEdit(state);

    history.beginEdit(state, "gesture-b", "Step 2");
    state.songs[0].regions.push_back(Region{});
    history.commitEdit(state);

    // Two distinct gestures -> two separate undo steps.
    auto undone1 = history.undo();
    REQUIRE(undone1.has_value());
    CHECK(undone1->songs[0].regions.size() == 1);
    REQUIRE(history.canUndo());

    auto undone2 = history.undo();
    REQUIRE(undone2.has_value());
    CHECK(undone2->songs[0].regions.empty());
    CHECK_FALSE(history.canUndo());
}

TEST_CASE("ProjectHistory caps depth at kMaxDepth, evicting the oldest entries") {
    ProjectHistory history;
    Project state = makeProjectWithRegions({});

    const size_t total = ProjectHistory::kMaxDepth + 10;
    for (size_t i = 0; i < total; ++i) {
        Project before = state;
        history.beginEdit(before, "", "Edit " + std::to_string(i));
        Region r;
        r.id = "reg_" + std::to_string(i);
        state.songs[0].regions.push_back(r);
        history.commitEdit(state);
    }

    size_t undoCount = 0;
    while (history.canUndo()) {
        history.undo();
        ++undoCount;
    }
    CHECK(undoCount == ProjectHistory::kMaxDepth);
}

TEST_CASE("ProjectHistory clears the redo stack on a fresh (non-redo) edit") {
    ProjectHistory history;
    Project state = makeProjectWithRegions({});

    history.beginEdit(state, "", "Edit 1");
    state.songs[0].regions.push_back(Region{});
    history.commitEdit(state);

    auto undone = history.undo();
    REQUIRE(undone.has_value());
    REQUIRE(history.canRedo());

    // A brand new edit (not a redo) must invalidate the redo stack.
    history.beginEdit(*undone, "", "Edit 2 (different branch)");
    Project branched = *undone;
    branched.songs[0].regions.push_back(Region{});
    branched.songs[0].regions.back().id = "reg_branch";
    history.commitEdit(branched);

    CHECK_FALSE(history.canRedo());
}

TEST_CASE("ProjectHistory clear() empties both stacks") {
    ProjectHistory history;
    Project state = makeProjectWithRegions({});

    history.beginEdit(state, "", "Edit 1");
    state.songs[0].regions.push_back(Region{});
    history.commitEdit(state);
    history.undo();

    REQUIRE(history.canRedo());
    history.clear();
    CHECK_FALSE(history.canUndo());
    CHECK_FALSE(history.canRedo());
}

TEST_CASE("ProjectHistory navigation closes replayed gestures before branching") {
    ProjectHistory history;
    Project state = makeProjectWithRegions({});
    for (const char* id : {"gesture-a", "gesture-b"}) {
        history.beginEdit(state, id, id);
        state.name = id;
        history.commitEdit(state);
    }
    state = *history.undo();
    state = *history.undo();
    state = *history.redo();
    REQUIRE(history.canRedo());
    // A slider can retain the same gesture ID across a quick Undo/Redo.
    // This edit must invalidate B and get its own undo boundary, not mutate A.
    history.beginEdit(state, "gesture-a", "New branch");
    state.name = "branch";
    history.commitEdit(state);
    CHECK_FALSE(history.canRedo());
    state = *history.undo();
    CHECK(state.name == "gesture-a");
    state = *history.undo();
    CHECK(state.name != "gesture-a");
}

TEST_CASE("ProjectHistory revision orders mutation snapshots across clear") {
    ProjectHistory history;
    Project state = makeProjectWithRegions({"a"});
    const auto initial = history.revision();
    history.beginEdit(state, "edit", "Rename");
    state.name = "After";
    history.commitEdit(state);
    const auto committed = history.revision();
    CHECK(committed > initial);
    REQUIRE(history.undo().has_value());
    CHECK(history.revision() > committed);
    const auto undone = history.revision();
    REQUIRE(history.redo().has_value());
    CHECK(history.revision() > undone);
    const auto redone = history.revision();
    history.clear();
    CHECK(history.revision() > redone);
    const auto cleared = history.revision();
    CHECK_FALSE(history.undo().has_value());
    CHECK(history.revision() == cleared);
}

TEST_CASE("History restore keeps stable song focus across reorder and handles removal") {
    Project project;
    SongDef a; a.id = "a";
    SongDef b; b.id = "b";
    project.songs = {b, a};
    REQUIRE(resolveHistorySongIndex(project, "a", 0).has_value());
    CHECK(*resolveHistorySongIndex(project, "a", 0) == 1);
    CHECK(*resolveHistorySongIndex(project, "b", 1) == 0);
    project.songs = {b};
    CHECK(*resolveHistorySongIndex(project, "a", 10) == 0);
    CHECK(*resolveHistorySongIndex(project, "", static_cast<size_t>(-1)) == 0);
    project.songs.clear();
    CHECK_FALSE(resolveHistorySongIndex(project, "b", 0).has_value());
}
