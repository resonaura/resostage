#include "doctest.h"

#include "audio/MixGraph.h"
#include "project/RouteId.h"

#include <algorithm>

using namespace resostage;

namespace {

// A small but realistic desk: 2 tracks, 2 sends, master on outs 1/2.
Project makeProject() {
    Project p;
    p.main.channels = 2;
    p.main.output.type = OutputType::ExtOut;
    p.main.output.target = "audio::out:1,audio::out:2";

    p.click.enabled = true;
    p.click.channels = 2;
    p.click.output.type = OutputType::SendsOnly;

    SendBus wedge;
    wedge.id = "audio::send:1";
    wedge.name = "Wedge";
    wedge.channels = 1;
    wedge.output.type = OutputType::ExtOut;
    wedge.output.target = "audio::out:11";
    p.sends.push_back(wedge);

    SendBus iem;
    iem.id = "audio::send:2";
    iem.name = "IEM";
    iem.channels = 2;
    iem.output.type = OutputType::ExtOut;
    iem.output.target = "audio::out:13,audio::out:14";
    p.sends.push_back(iem);

    TrackDef drums;
    drums.id = "audio::track:1";
    drums.name = "Drums";
    drums.output.type = OutputType::Main;
    p.tracks.push_back(drums);

    TrackDef bass;
    bass.id = "audio::track:2";
    bass.name = "Bass";
    bass.output.type = OutputType::ExtOut;
    bass.output.target = "audio::out:3,audio::out:4";
    p.tracks.push_back(bass);

    return p;
}

OutputLaneConfig outputs16() {
    OutputLaneConfig cfg;
    cfg.totalChannels = 16;
    return cfg;
}

const MixStrip& stripFor(const MixGraph& g, const std::string& id) {
    const uint32_t index = g.find(id);
    REQUIRE(index != MixGraph::kNoStrip);
    return g.strips[index];
}

std::vector<const MixEdge*> edgesInto(const MixGraph& g, const std::string& id) {
    const uint32_t to = g.find(id);
    std::vector<const MixEdge*> found;
    for (const MixEdge& e : g.edges)
        if (e.to == to)
            found.push_back(&e);
    return found;
}

bool hasEdge(const MixGraph& g, const std::string& from, const std::string& to) {
    const uint32_t f = g.find(from);
    const uint32_t t = g.find(to);
    return std::any_of(g.edges.begin(), g.edges.end(),
                       [&](const MixEdge& e) { return e.from == f && e.to == t; });
}

} // namespace

TEST_CASE("buildMixGraph: every mixer row becomes a strip, master included") {
    const MixGraph g = buildMixGraph(makeProject(), outputs16());

    CHECK(g.find("audio::track:1") != MixGraph::kNoStrip);
    CHECK(g.find("audio::track:2") != MixGraph::kNoStrip);
    CHECK(g.find("audio::click") != MixGraph::kNoStrip);
    CHECK(g.find("audio::send:1") != MixGraph::kNoStrip);
    CHECK(g.find("audio::send:2") != MixGraph::kNoStrip);
    CHECK(g.find("audio::main") != MixGraph::kNoStrip);
    CHECK(g.find("audio::out:1") != MixGraph::kNoStrip);
}

TEST_CASE("buildMixGraph: strips are ordered sources -> busses -> lanes") {
    const MixGraph g = buildMixGraph(makeProject(), outputs16());
    CHECK(g.find("audio::track:1") < g.firstBusStrip);
    CHECK(g.find("audio::click") < g.firstBusStrip);
    CHECK(g.find("audio::send:1") >= g.firstBusStrip);
    CHECK(g.find("audio::send:1") < g.firstLaneStrip);
    CHECK(g.find("audio::main") < g.firstLaneStrip);
    CHECK(g.find("audio::out:1") >= g.firstLaneStrip);
}

TEST_CASE("buildMixGraph: every edge runs forward, so one sweep resolves the graph") {
    const MixGraph g = buildMixGraph(makeProject(), outputs16());
    REQUIRE_FALSE(g.edges.empty());
    for (const MixEdge& e : g.edges)
        CHECK(e.from < e.to);
    // ...and they are grouped by destination for the render cursor.
    for (size_t i = 1; i < g.edges.size(); ++i)
        CHECK(g.edges[i - 1].to <= g.edges[i].to);
}

TEST_CASE("buildMixGraph: master owns its physical channels as two mono lanes") {
    const MixGraph g = buildMixGraph(makeProject(), outputs16());
    CHECK(hasEdge(g, "audio::main", "audio::out:1"));
    CHECK(hasEdge(g, "audio::main", "audio::out:2"));

    // L into the first lane, R into the second -- not summed into both, which
    // would collapse the master to mono.
    const auto intoLeft = edgesInto(g, "audio::out:1");
    REQUIRE(intoLeft.size() == 1);
    CHECK(intoLeft[0]->sourceChannel == 0);
    const auto intoRight = edgesInto(g, "audio::out:2");
    REQUIRE(intoRight.size() == 1);
    CHECK(intoRight[0]->sourceChannel == 1);
}

TEST_CASE("buildMixGraph: master carries its own gain, pan, mute and channel count") {
    Project p = makeProject();
    p.main.gainDb = -6.0;
    p.main.pan = -1.0;
    p.main.mute = true;
    p.main.channels = 1;

    const MixGraph g = buildMixGraph(p, outputs16());
    const MixStrip& main = stripFor(g, "audio::main");
    CHECK(main.gainLinear == doctest::Approx(0.5011872f).epsilon(1e-5));
    CHECK(main.pan == doctest::Approx(-1.0f));
    CHECK(main.mute);
    CHECK_FALSE(main.audible);
    CHECK(main.channels == 1);
}

TEST_CASE("buildMixGraph: a track on ext-out bypasses master entirely") {
    const MixGraph g = buildMixGraph(makeProject(), outputs16());
    CHECK(hasEdge(g, "audio::track:2", "audio::out:3"));
    CHECK(hasEdge(g, "audio::track:2", "audio::out:4"));
    CHECK_FALSE(hasEdge(g, "audio::track:2", "audio::main"));
    CHECK(hasEdge(g, "audio::track:1", "audio::main"));
}

TEST_CASE("buildMixGraph: a mono send targeting one lane gets a single summing edge") {
    const MixGraph g = buildMixGraph(makeProject(), outputs16());
    const auto intoWedge = edgesInto(g, "audio::out:11");
    REQUIRE(intoWedge.size() == 1);
    CHECK(intoWedge[0]->sourceChannel == -1); // sum, not "left only"
    CHECK(stripFor(g, "audio::send:1").channels == 1);
}

TEST_CASE("buildMixGraph: a send routed to Main folds into it instead of grabbing lanes") {
    Project p = makeProject();
    p.sends[1].output.type = OutputType::Main;
    p.sends[1].output.target.reset();

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK(hasEdge(g, "audio::send:2", "audio::main"));
    CHECK_FALSE(hasEdge(g, "audio::send:2", "audio::out:1"));
}

TEST_CASE("buildMixGraph: a track whose main route targets an aux lands on that bus") {
    Project p = makeProject();
    p.tracks[0].output.type = OutputType::Bus;
    p.tracks[0].output.target = "audio::send:2";

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK(hasEdge(g, "audio::track:1", "audio::send:2"));
    CHECK_FALSE(hasEdge(g, "audio::track:1", "audio::main"));
    // ...and it is a real edge, not a lane lookup that quietly found nothing.
    const auto into = edgesInto(g, "audio::send:2");
    REQUIRE(into.size() == 1);
    CHECK(into[0]->gainLinear == doctest::Approx(1.0f));
}

TEST_CASE("buildMixGraph: a bus-routed source still runs forward, so no cycle") {
    Project p = makeProject();
    p.tracks[0].output.type = OutputType::Bus;
    p.tracks[0].output.target = "audio::send:1";
    p.click.output.type = OutputType::Bus;
    p.click.output.target = "audio::send:1";

    const MixGraph g = buildMixGraph(p, outputs16());
    for (const MixEdge& e : g.edges)
        CHECK(e.from < e.to);
}

TEST_CASE("buildMixGraph: a bus is never allowed to route into another bus") {
    Project p = makeProject();
    // Bus -> Bus is the one edge that could close a feedback loop.
    p.sends[0].output.type = OutputType::Bus;
    p.sends[0].output.target = "audio::send:2";

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK_FALSE(hasEdge(g, "audio::send:1", "audio::send:2"));
    for (const MixEdge& e : g.edges)
        CHECK(e.from < e.to);
}

TEST_CASE("buildMixGraph: a main route at a deleted bus is dropped, not turned into a lane") {
    Project p = makeProject();
    p.tracks[0].output.type = OutputType::Bus;
    p.tracks[0].output.target = "audio::send:99";

    const MixGraph g = buildMixGraph(p, outputs16());
    const uint32_t track = g.find("audio::track:1");
    for (const MixEdge& e : g.edges)
        CHECK(e.from != track);
}

TEST_CASE("buildMixGraph: send rows become edges carrying their 0-100 level") {
    Project p = makeProject();
    SendConfig row;
    row.bus = "audio::send:1";
    row.level = 50.0;
    p.tracks[0].output.sends.push_back(row);

    const MixGraph g = buildMixGraph(p, outputs16());
    const auto into = edgesInto(g, "audio::send:1");
    REQUIRE(into.size() == 1);
    CHECK(into[0]->from == g.find("audio::track:1"));
    CHECK(into[0]->gainLinear == doctest::Approx(0.5f));
}

TEST_CASE("buildMixGraph: a disabled send row produces no edge at all") {
    Project p = makeProject();
    SendConfig row;
    row.bus = "audio::send:1";
    row.enabled = false;
    p.tracks[0].output.sends.push_back(row);

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK(edgesInto(g, "audio::send:1").empty());
}

TEST_CASE("buildMixGraph: a send row pointing at a deleted bus is dropped, not guessed") {
    Project p = makeProject();
    SendConfig row;
    row.bus = "audio::send:99";
    p.tracks[0].output.sends.push_back(row);

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK(g.find("audio::send:99") == MixGraph::kNoStrip);
    for (const MixEdge& e : g.edges)
        CHECK(e.to < g.strips.size());
}

// ── Solo groups ─────────────────────────────────────────────────────────────

TEST_CASE("solo groups: soloing a track silences other tracks but not the click's group peers") {
    Project p = makeProject();
    p.tracks[0].solo = true;

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK(g.anySoloIn(SoloGroup::Sources));
    CHECK(stripFor(g, "audio::track:1").audible);
    CHECK_FALSE(stripFor(g, "audio::track:2").audible);
    // The click shares the Sources group, so it is silenced too.
    CHECK_FALSE(stripFor(g, "audio::click").audible);
}

TEST_CASE("solo groups: soloing the click keeps the click and drops the tracks") {
    Project p = makeProject();
    p.click.solo = true;

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK(stripFor(g, "audio::click").audible);
    CHECK_FALSE(stripFor(g, "audio::track:1").audible);
}

TEST_CASE("solo groups: a track solo never touches the sends or the master") {
    Project p = makeProject();
    p.tracks[0].solo = true;

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK_FALSE(g.anySoloIn(SoloGroup::Sends));
    CHECK(stripFor(g, "audio::send:1").audible);
    CHECK(stripFor(g, "audio::send:2").audible);
    CHECK(stripFor(g, "audio::main").audible);
}

TEST_CASE("solo groups: soloing a send silences only the other sends") {
    Project p = makeProject();
    p.sends[0].solo = true;

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK(stripFor(g, "audio::send:1").audible);
    CHECK_FALSE(stripFor(g, "audio::send:2").audible);
    CHECK(stripFor(g, "audio::track:1").audible);
    CHECK(stripFor(g, "audio::main").audible);
}

TEST_CASE("solo groups: master is alone in its group, so its solo is inert") {
    Project p = makeProject();
    p.main.solo = true;

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK(g.anySoloIn(SoloGroup::Main));
    CHECK(stripFor(g, "audio::main").audible);
    CHECK(stripFor(g, "audio::track:1").audible);
    CHECK(stripFor(g, "audio::send:1").audible);
}

TEST_CASE("solo groups: output lanes are never soloed or silenced") {
    Project p = makeProject();
    p.tracks[0].solo = true;
    p.sends[0].solo = true;

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK_FALSE(g.anySoloIn(SoloGroup::None));
    CHECK(stripFor(g, "audio::out:1").audible);
    CHECK(stripFor(g, "audio::out:1").soloGroup == SoloGroup::None);
}

// ── Edge audibility ─────────────────────────────────────────────────────────

TEST_CASE("edges: a muted track feeds nothing downstream") {
    Project p = makeProject();
    SendConfig row;
    row.bus = "audio::send:1";
    p.tracks[0].output.sends.push_back(row);
    p.tracks[0].mute = true;

    const MixGraph g = buildMixGraph(p, outputs16());
    for (const MixEdge& e : g.edges)
        if (e.from == g.find("audio::track:1"))
            CHECK_FALSE(e.active);
}

TEST_CASE("edges: a pre-fader send survives the source's mute but not someone else's solo") {
    Project p = makeProject();
    SendConfig row;
    row.bus = "audio::send:1";
    row.preFader = true;
    p.tracks[0].output.sends.push_back(row);
    p.tracks[0].mute = true;

    {
        const MixGraph g = buildMixGraph(p, outputs16());
        const auto into = edgesInto(g, "audio::send:1");
        REQUIRE(into.size() == 1);
        CHECK(into[0]->preFader);
        CHECK(into[0]->active); // muted at FOH, still in the monitor mix
    }

    p.tracks[1].solo = true;
    {
        const MixGraph g = buildMixGraph(p, outputs16());
        const auto into = edgesInto(g, "audio::send:1");
        REQUIRE(into.size() == 1);
        CHECK_FALSE(into[0]->active);
    }
}

// ── Output lanes ────────────────────────────────────────────────────────────

TEST_CASE("lanes: one mono strip per active device channel, ids are 1-based") {
    OutputLaneConfig cfg;
    cfg.totalChannels = 4;
    const MixGraph g = buildMixGraph(makeProject(), cfg);

    CHECK(stripFor(g, "audio::out:1").physicalChannel == 0);
    CHECK(stripFor(g, "audio::out:4").physicalChannel == 3);
    CHECK(stripFor(g, "audio::out:1").channels == 1);
}

TEST_CASE("lanes: a referenced-but-missing channel becomes a silent shadow lane") {
    // The project routes sends to outs 11/13/14 but the device only has 4.
    OutputLaneConfig cfg;
    cfg.totalChannels = 4;
    const MixGraph g = buildMixGraph(makeProject(), cfg);

    const MixStrip& shadow = stripFor(g, "audio::out:11");
    CHECK(shadow.physicalChannel == -1); // routing preserved, audio goes nowhere
    CHECK(hasEdge(g, "audio::send:1", "audio::out:11"));
}

TEST_CASE("lanes: a channel switched off in Settings is not resurrected as a shadow") {
    OutputLaneConfig cfg;
    cfg.totalChannels = 16;
    cfg.active.assign(16, true);
    cfg.active[10] = false; // "Out 11" deliberately disabled by the user

    const MixGraph g = buildMixGraph(makeProject(), cfg);
    CHECK(g.find("audio::out:11") == MixGraph::kNoStrip);
}

TEST_CASE("lanes: many strips sharing one physical channel share one lane strip") {
    Project p = makeProject();
    // Put a send on the master's own pair -- the classic "aux on outs 1/2".
    p.sends[0].channels = 2;
    p.sends[0].output.target = "audio::out:1,audio::out:2";

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK(edgesInto(g, "audio::out:1").size() == 2); // master + send, summed
    CHECK(hasEdge(g, "audio::main", "audio::out:1"));
    CHECK(hasEdge(g, "audio::send:1", "audio::out:1"));
}

TEST_CASE("outputLaneId / outputLaneChannel round-trip and reject junk") {
    CHECK(outputLaneId(0) == "audio::out:1");
    CHECK(outputLaneId(10) == "audio::out:11");
    CHECK(outputLaneChannel("audio::out:1") == 0);
    CHECK(outputLaneChannel("audio::out:11") == 10);
    CHECK(outputLaneChannel("audio::out:0") == -1);
    CHECK(outputLaneChannel("audio::main") == -1);
    CHECK(outputLaneChannel("direct:3") == -1); // the pre-namespace spelling
    CHECK(outputLaneChannel("audio::out:x") == -1);
    CHECK(outputLaneChannel("") == -1);
}

TEST_CASE("buildMixGraph: a disabled metronome is simply a muted strip") {
    Project p = makeProject();
    p.click.enabled = false;

    const MixGraph g = buildMixGraph(p, outputs16());
    const MixStrip& click = stripFor(g, "audio::click");
    CHECK(click.mute);
    CHECK_FALSE(click.audible);
    CHECK(click.soloGroup == SoloGroup::Sources);
}

TEST_CASE("buildMixGraph: an empty project still yields a usable master and lanes") {
    Project p;
    p.main.output.type = OutputType::ExtOut;
    p.main.output.target = "audio::out:1,audio::out:2";

    const MixGraph g = buildMixGraph(p, outputs16());
    CHECK(g.find("audio::main") != MixGraph::kNoStrip);
    CHECK(hasEdge(g, "audio::main", "audio::out:1"));
    CHECK(hasEdge(g, "audio::main", "audio::out:2"));
}

// ── Flat route ids (engine/project/RouteId.h) ───────────────────────────────

TEST_CASE("routeId: every destination the UI can pick survives a round trip") {
    Project p = makeProject();

    struct Case {
        const char* routeId;
        OutputType expected;
    };
    const Case cases[] = {
        {"", OutputType::SendsOnly},
        {"audio::main", OutputType::Main},
        {"audio::send:1", OutputType::Bus},
        {"audio::send:2", OutputType::Bus},
        {"audio::out:11", OutputType::ExtOut},
        {"audio::out:3,audio::out:4", OutputType::ExtOut},
    };

    for (const Case& c : cases) {
        SourceOutput output;
        applyRouteId(output, c.routeId, p);
        CHECK(output.type == c.expected);
        // The flat id the SPA sent must be exactly what it reads back, or the
        // destination <select> snaps to something the user never chose.
        CHECK(routeIdOf(output) == c.routeId);
    }
}

TEST_CASE("routeId: an unknown id is treated as an output lane, never as a bus") {
    Project p = makeProject();
    SourceOutput output;
    applyRouteId(output, "audio::send:99", p);
    // No such bus -> falls through to ext-out, where buildMixGraph finds no
    // lanes and simply produces no edges (silent, but never mis-routed).
    CHECK(output.type == OutputType::ExtOut);
}

TEST_CASE("routeId: applying a new destination clears the previous target") {
    Project p = makeProject();
    SourceOutput output;
    applyRouteId(output, "audio::out:5", p);
    REQUIRE(output.target.has_value());
    applyRouteId(output, "audio::main", p);
    CHECK(output.type == OutputType::Main);
    CHECK_FALSE(output.target.has_value());
    applyRouteId(output, "", p);
    CHECK(output.type == OutputType::SendsOnly);
    CHECK_FALSE(output.target.has_value());
}
