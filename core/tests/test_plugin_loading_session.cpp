/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"
#include "plugins/PluginLoadingSession.h"
#include "plugins/PluginPowerControl.h"
#include "plugins/PluginRetryScope.h"
#include "plugins/PluginSlotIdentity.h"
#include "project/ProjectJson.h"
#include <thread>

using namespace resostage;

TEST_CASE("targeted plug-in retry scope uses exact stable strip identity") {
    CHECK(pluginRetryIncludesStrip({}, "audio::track:1"));
    CHECK(pluginRetryIncludesStrip({}, "audio::send:4"));
    CHECK(pluginRetryIncludesStrip("audio::track:1", "audio::track:1"));
    CHECK_FALSE(pluginRetryIncludesStrip("audio::track:1", "audio::track:10"));
    CHECK_FALSE(pluginRetryIncludesStrip("audio::track:1", "audio::track:2"));
}

TEST_CASE("plug-in slot lookup scopes duplicates and rejects ambiguous legacy IDs") {
    CHECK(std::string_view(pluginPowerStateToString(PluginPowerState::Unknown)) == "unknown");
    PluginSlotLookup legacy;
    considerPluginSlot(legacy, {}, "slot:shared", "strip:first", "slot:shared", 2, 0);
    considerPluginSlot(legacy, {}, "slot:shared", "strip:second", "slot:shared", 5, 1);
    CHECK(legacy.found());
    CHECK(legacy.ambiguous);
    CHECK_FALSE(legacy.unique());

    PluginSlotLookup exact;
    considerPluginSlot(exact, "strip:second", "slot:shared",
                       "strip:first", "slot:shared", 2, 0);
    considerPluginSlot(exact, "strip:second", "slot:shared",
                       "strip:second", "slot:shared", 5, 1);
    CHECK(exact.unique());
    CHECK(exact.stripIndex == 5);
    CHECK(exact.slotIndex == 1);

    PluginSlotLookup repeatedWithinOneChain;
    considerPluginSlot(repeatedWithinOneChain, "strip:first", "slot:shared",
                       "strip:first", "slot:shared", 2, 0);
    considerPluginSlot(repeatedWithinOneChain, "strip:first", "slot:shared",
                       "strip:first", "slot:shared", 2, 1);
    CHECK(repeatedWithinOneChain.ambiguous);
    CHECK_FALSE(repeatedWithinOneChain.unique());
}

TEST_CASE("PluginLoadingSession holds a new document until its bank is published") {
    PluginLoadingSession session;
    session.replaceProject(1);
    session.begin(1, 4, 2);
    CHECK_FALSE(session.requestTransport(true));
    CHECK(session.snapshot().playRequested);
    session.progress(1, 4, 2, "Last plug-in");
    CHECK(session.snapshot().blocksPlayback); // Instantiation is not publication.
    CHECK_FALSE(session.takePlayIntent());
    session.finish(1, 4, 0);
    CHECK_FALSE(session.snapshot().showDialog);
    CHECK(session.takePlayIntent());
    CHECK_FALSE(session.takePlayIntent());
    CHECK(session.requestTransport(false));
}

TEST_CASE("PluginLoadingSession handles empty projects and non-disruptive insert edits") {
    PluginLoadingSession session;
    session.replaceProject(2);
    session.begin(2, 5, 0);
    CHECK_FALSE(session.snapshot().blocksPlayback);
    session.begin(2, 6, 1);
    CHECK(session.requestTransport(true));
    CHECK_FALSE(session.snapshot().showDialog);
    session.finish(2, 6, 1, "Missing insert");
    CHECK_FALSE(session.snapshot().blocksPlayback);
    session.begin(2, 7, 2); // A two-slot chain retry uses only that chain's progress count.
    const auto retry = session.snapshot();
    CHECK(retry.total == 2);
    CHECK_FALSE(retry.blocksPlayback);
    CHECK_FALSE(retry.showDialog);
    session.progress(2, 7, 1, "Track · Plug-in B");
    CHECK(session.snapshot().completed == 1);
}

TEST_CASE("PluginLoadingSession ignores stale progress, completion and dialog decisions") {
    PluginLoadingSession session;
    session.replaceProject(3);
    session.begin(3, 7, 2);
    session.replaceProject(4);
    session.begin(4, 9, 1);
    session.progress(3, 7, 2, "Old instrument");
    session.finish(3, 7, 0);
    CHECK_FALSE(session.decide(3, 7, true));
    CHECK(session.snapshot().blocksPlayback);
    CHECK(session.snapshot().completed == 0);
    session.begin(4, 8, 0);
    CHECK(session.snapshot().generation == 9);
    CHECK_FALSE(session.decide(4, 9, true)); // Cannot bypass an unfinished chain.
}

TEST_CASE("PluginLoadingSession makes degraded playback explicit and Stop cancels queued Play") {
    PluginLoadingSession session;
    session.replaceProject(5);
    session.begin(5, 10, 2);
    CHECK_FALSE(session.requestTransport(true));
    session.stop();
    session.finish(5, 10, 1);
    CHECK(session.snapshot().phase == "degraded");
    CHECK(session.snapshot().blocksPlayback);
    CHECK_FALSE(session.takePlayIntent());
    CHECK(session.decide(5, 10, false));
    CHECK_FALSE(session.snapshot().showDialog);
    CHECK_FALSE(session.requestTransport(true));
    CHECK(session.decide(5, 10, true));
    CHECK(session.takePlayIntent());
    CHECK_FALSE(session.takePlayIntent());
}

TEST_CASE("PluginLoadingSession retries remain blocked and concurrent status polling is safe") {
    PluginLoadingSession session;
    session.replaceProject(6);
    session.begin(6, 11, 1);
    session.finish(6, 11, 1, "Host initialization timed out");
    session.begin(6, 12, 1);
    CHECK(session.snapshot().blocksPlayback);
    std::thread worker([&] {
        for (uint32_t n = 0; n < 1000; ++n) session.progress(6, 12, n, std::string(500, 'x'));
        session.finish(6, 12, 0);
    });
    for (int n = 0; n < 1000; ++n) {
        const auto state = session.snapshot();
        CHECK(state.completed <= state.total);
        CHECK(state.currentName.size() <= 256);
    }
    worker.join();
    CHECK_FALSE(session.snapshot().blocksPlayback);
}

TEST_CASE("Project format 10 preserves explicit click solo-safe disengagement") {
    Project original;
    original.click.soloSafe = false;
    std::string json, error;
    json = serializeProjectJson(original);
    Project restored;
    REQUIRE(parseProjectJson(json, restored, error));
    CHECK(restored.format.version == 12);
    CHECK_FALSE(restored.click.soloSafe);
    original.format.version = 9;
    json = serializeProjectJson(original);
    REQUIRE(parseProjectJson(json, restored, error));
    CHECK(restored.click.soloSafe);
}
