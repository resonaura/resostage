/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"
#include "server/MidiRegionAdmission.h"

#include <string>

using namespace resostage::builder_json;
using namespace resostage::midi_region_admission;

TEST_CASE("MIDI region JSON admission preserves valid event and UMP rows") {
    glz::generic document;
    REQUIRE(parseJson(R"({"notes":[],"events":[{"beat":0,"status":240,"data":[1,2,3]}],"umpEvents":[{"beat":0,"wordCount":1,"words":[536870912]}]})", document));
    std::string error;
    CHECK(validateMidiRegionCollectionLimits(document, error));
    CHECK(error.empty());
}

TEST_CASE("MIDI region JSON admission rejects event payloads Core would silently drop") {
    std::string json = R"({"events":[{"beat":0,"status":240,"data":[)";
    json.reserve(json.size() + kMaximumMidiEventDataBytes * 2 + 32);
    for (size_t index = 0; index <= kMaximumMidiEventDataBytes; ++index) {
        if (index != 0) json.push_back(',');
        json.push_back('0');
    }
    json += "]}]}";

    glz::generic document;
    REQUIRE(parseJson(json, document));
    std::string error;
    CHECK_FALSE(validateMidiRegionCollectionLimits(document, error));
    CHECK(error.find("65,536-byte") != std::string::npos);
}

TEST_CASE("MIDI region JSON admission rejects UMP word arrays the Core parser would omit") {
    glz::generic document;
    REQUIRE(parseJson(R"({"umpEvents":[{"beat":0,"wordCount":1,"words":[4294967296]}]})", document));
    std::string error;
    CHECK_FALSE(validateMidiRegionCollectionLimits(document, error));
    CHECK(error.find("32-bit word") != std::string::npos);
}

TEST_CASE("MIDI region JSON admission rejects fractional status and UMP word counts") {
    glz::generic midi1Document;
    REQUIRE(parseJson(R"({"events":[{"beat":0,"status":144.5,"data":[60,100]}]})", midi1Document));
    std::string error;
    CHECK_FALSE(validateMidiRegionCollectionLimits(midi1Document, error));

    glz::generic umpDocument;
    REQUIRE(parseJson(R"({"umpEvents":[{"beat":0,"wordCount":1.5,"words":[536870912]}]})", umpDocument));
    error.clear();
    CHECK_FALSE(validateMidiRegionCollectionLimits(umpDocument, error));
}
