// Two bugs that fired nothing and said nothing.
//
// Both were found by pointing a real trigger at a real listener and noticing
// it never arrived. Neither would ever have shown up in a crash, a log line
// or a counter -- one silently emptied the payload it was holding, the other
// silently skipped the event entirely. So both rules are written down here.

#include "doctest.h"

#include "events/DueQueue.h"

#include <string>
#include <vector>

using namespace resostage;

namespace {

/** Stands in for a queued HTTP or DMX trigger: a payload plus a due time. */
struct Cue {
    std::string payload;
    uint64_t targetHostTimeNanos = 0;
};

} // namespace

TEST_CASE("due queue: holding a cue does not empty it") {
    // THE bug. Compacting the pending list in place moved an element onto
    // itself while nothing had been sent yet, and self-move-assignment leaves
    // a std::string empty. The cue was still there, still scheduled, and by
    // the time it came due its URL was gone -- so the send failed against an
    // unparseable address, silently.
    std::vector<Cue> pending{{"http://board.local/flash", 1000}};

    // Several passes before it is due, exactly as the dispatcher's 2 ms loop
    // would do.
    for (uint64_t now = 0; now < 1000; now += 100) {
        const size_t sent = drainDue(pending, now, [](const Cue&) {});
        CHECK(sent == 0);
        REQUIRE(pending.size() == 1);
        CHECK(pending[0].payload == "http://board.local/flash");
    }

    std::string delivered;
    CHECK(drainDue(pending, 1000, [&](const Cue& c) { delivered = c.payload; }) == 1);
    CHECK(delivered == "http://board.local/flash");
    CHECK(pending.empty());
}

TEST_CASE("due queue: a cue in the middle can come due without disturbing the rest") {
    // The compaction path proper: one of three fires, the other two survive
    // intact and in order.
    std::vector<Cue> pending{{"first", 3000}, {"second", 1000}, {"third", 4000}};

    std::vector<std::string> fired;
    CHECK(drainDue(pending, 2000, [&](const Cue& c) { fired.push_back(c.payload); }) == 1);
    CHECK(fired == std::vector<std::string>{"second"});
    REQUIRE(pending.size() == 2);
    CHECK(pending[0].payload == "first");
    CHECK(pending[1].payload == "third");
    CHECK(pending[0].targetHostTimeNanos == 3000);
    CHECK(pending[1].targetHostTimeNanos == 4000);
}

TEST_CASE("due queue: cues are delivered in the order they were queued") {
    std::vector<Cue> pending{{"a", 100}, {"b", 200}, {"c", 300}};
    std::vector<std::string> fired;
    CHECK(drainDue(pending, 1000, [&](const Cue& c) { fired.push_back(c.payload); }) == 3);
    CHECK(fired == std::vector<std::string>{"a", "b", "c"});
    CHECK(pending.empty());
}

TEST_CASE("due queue: late is not lost") {
    // A cue whose moment passed while the thread was busy still fires. The
    // alternative is a light that never comes on, which is a far worse
    // failure than one that comes on a few milliseconds late.
    std::vector<Cue> pending{{"missed", 10}};
    std::string delivered;
    CHECK(drainDue(pending, 999999, [&](const Cue& c) { delivered = c.payload; }) == 1);
    CHECK(delivered == "missed");
}

TEST_CASE("due queue: nothing due leaves everything exactly as it was") {
    std::vector<Cue> pending{{"x", 500}, {"y", 600}};
    CHECK(drainDue(pending, 400, [](const Cue&) {}) == 0);
    REQUIRE(pending.size() == 2);
    CHECK(pending[0].payload == "x");
    CHECK(pending[1].payload == "y");
}

TEST_CASE("due queue: many passes over a long wait keep every payload") {
    // A cue held for a full second at the dispatcher's 2 ms cadence is five
    // hundred compaction passes. The self-move bug destroyed the payload on
    // the very first one; this is the shape of the real workload.
    std::vector<Cue> pending;
    for (int i = 0; i < 8; ++i)
        pending.push_back({"cue-" + std::to_string(i), 1'000'000'000ull});

    for (uint64_t now = 0; now < 1'000'000'000ull; now += 2'000'000ull)
        CHECK(drainDue(pending, now, [](const Cue&) {}) == 0);

    REQUIRE(pending.size() == 8);
    for (int i = 0; i < 8; ++i)
        CHECK(pending[static_cast<size_t>(i)].payload == "cue-" + std::to_string(i));
}

TEST_CASE("fired flags: a trigger added to the open song is armed, not skipped") {
    // The other bug. The firing loop stops at this vector's length, so an
    // event appended to the song already open sat outside the bound and never
    // fired -- however many times Play was pressed, because Play only zeroed
    // the flags that already existed.
    std::vector<uint8_t> flags; // song staged with no events at all
    resizeFiredFlags(flags, 1);
    REQUIRE(flags.size() == 1);
    CHECK(flags[0] == 0); // armed
}

TEST_CASE("fired flags: adding an event does not re-fire the ones already past") {
    // Growing must preserve what is already there. Otherwise adding a cue
    // halfway through a song replays every cue before it -- every light, every
    // program change, at once.
    std::vector<uint8_t> flags{1, 1, 0};
    resizeFiredFlags(flags, 5);
    REQUIRE(flags.size() == 5);
    CHECK(flags[0] == 1);
    CHECK(flags[1] == 1);
    CHECK(flags[2] == 0);
    CHECK(flags[3] == 0);
    CHECK(flags[4] == 0);
}

TEST_CASE("fired flags: removing an event shrinks the vector to match") {
    std::vector<uint8_t> flags{1, 1, 1, 1};
    resizeFiredFlags(flags, 2);
    CHECK(flags.size() == 2);

    // ...and an unchanged count is left completely alone, which is what keeps
    // this callable from every routing republish -- a knob drag must not
    // re-arm a cue that has already fired.
    std::vector<uint8_t> steady{1, 0, 1};
    resizeFiredFlags(steady, 3);
    CHECK(steady == std::vector<uint8_t>{1, 0, 1});
}
