#include "doctest.h"

#include "project/RecentProjects.h"

using namespace resostage;

namespace {

RecentProjectEntry entry(const std::string& path, const std::string& name = "") {
    RecentProjectEntry e;
    e.path = path;
    e.displayName = name.empty() ? path : name;
    e.lastOpenedIso = "2026-07-31T00:00:00Z";
    return e;
}

} // namespace

TEST_CASE("touchRecentProject inserts a new entry at the front") {
    std::vector<RecentProjectEntry> list;
    touchRecentProject(list, entry("/a.rsnraset"));
    touchRecentProject(list, entry("/b.rsnraset"));

    REQUIRE(list.size() == 2);
    CHECK(list[0].path == "/b.rsnraset");
    CHECK(list[1].path == "/a.rsnraset");
}

TEST_CASE("touchRecentProject re-opening an existing path moves it to front without duplicating") {
    std::vector<RecentProjectEntry> list;
    touchRecentProject(list, entry("/a.rsnraset"));
    touchRecentProject(list, entry("/b.rsnraset"));
    touchRecentProject(list, entry("/c.rsnraset"));
    touchRecentProject(list, entry("/a.rsnraset", "A (renamed)"));

    REQUIRE(list.size() == 3);
    CHECK(list[0].path == "/a.rsnraset");
    CHECK(list[0].displayName == "A (renamed)");
    CHECK(list[1].path == "/c.rsnraset");
    CHECK(list[2].path == "/b.rsnraset");
}

TEST_CASE("touchRecentProject caps the list at maxEntries, evicting the oldest") {
    std::vector<RecentProjectEntry> list;
    for (int i = 0; i < 5; ++i)
        touchRecentProject(list, entry("/" + std::to_string(i) + ".rsnraset"), 3);

    REQUIRE(list.size() == 3);
    CHECK(list[0].path == "/4.rsnraset");
    CHECK(list[1].path == "/3.rsnraset");
    CHECK(list[2].path == "/2.rsnraset");
}

TEST_CASE("removeRecentProject drops a matching entry and leaves others in order") {
    std::vector<RecentProjectEntry> list;
    touchRecentProject(list, entry("/a.rsnraset"));
    touchRecentProject(list, entry("/b.rsnraset"));
    touchRecentProject(list, entry("/c.rsnraset"));

    removeRecentProject(list, "/b.rsnraset");

    REQUIRE(list.size() == 2);
    CHECK(list[0].path == "/c.rsnraset");
    CHECK(list[1].path == "/a.rsnraset");
}

TEST_CASE("removeRecentProject is a no-op when the path isn't present") {
    std::vector<RecentProjectEntry> list;
    touchRecentProject(list, entry("/a.rsnraset"));

    removeRecentProject(list, "/does-not-exist.rsnraset");

    REQUIRE(list.size() == 1);
    CHECK(list[0].path == "/a.rsnraset");
}
