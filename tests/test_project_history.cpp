#include "doctest.h"

#include "project/ProjectHistory.h"

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
