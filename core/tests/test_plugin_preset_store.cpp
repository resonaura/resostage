/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "doctest.h"

#include "plugins/PluginPresetStore.h"
#include "project/ProjectLoader.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

using namespace resostage;

namespace {

struct TemporaryPresetRoot {
    std::filesystem::path path = std::filesystem::temp_directory_path()
        / ("resostage-plugin-presets-"
            + std::to_string(std::chrono::steady_clock::now()
                                 .time_since_epoch().count()));
    ~TemporaryPresetRoot() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

} // namespace

TEST_SUITE("PluginPresetStore") {

TEST_CASE("save, list and load round-trip opaque state under exact plugin identity") {
    TemporaryPresetRoot root;
    const std::string pluginId = "VST3:vendor.example:synth";
    const std::vector<uint8_t> state{0x00, 0x13, 0xff, 0x41, 0x00};
    PluginPresetInfo saved;
    std::string error;

    REQUIRE(PluginPresetStore::save(root.path, pluginId, "  Warm pad  ",
                                    state, saved, error));
    CHECK(error.empty());
    CHECK(saved.name == "Warm pad");
    CHECK(saved.pluginIdentifier == pluginId);
    CHECK(saved.stateBytes == state.size());
    CHECK(PluginPresetStore::validPresetId(saved.id));
    const auto resource = PluginPresetStore::projectResourceForSlot(
        "track:one", "slot/one", saved.id);
    REQUIRE(!resource.empty());
    CHECK(resource.find("..") == std::string::npos);
    CHECK(PluginPresetStore::presetIdForProjectResource("track:one", "slot/one", resource)
          == std::optional<std::string>(saved.id));
    CHECK_FALSE(PluginPresetStore::presetIdForProjectResource("track:one", "slot/two", resource));
    CHECK_FALSE(PluginPresetStore::presetIdForProjectResource("track:two", "slot/one", resource));

    std::vector<PluginPresetInfo> listed;
    REQUIRE(PluginPresetStore::list(root.path, pluginId, listed, error));
    REQUIRE(listed.size() == 1);
    CHECK(listed.front().id == saved.id);
    CHECK(listed.front().name == saved.name);

    PluginPresetData loaded;
    REQUIRE(PluginPresetStore::load(root.path, pluginId, saved.id, loaded, error));
    CHECK(loaded.info.id == saved.id);
    CHECK(loaded.state == state);

    CHECK_FALSE(PluginPresetStore::load(root.path, "VST3:other:synth",
                                        saved.id, loaded, error));
    CHECK(error == "Plug-in preset file is unavailable");
}

TEST_CASE("reject invalid names, identifiers and corrupt preset payloads") {
    TemporaryPresetRoot root;
    const std::vector<uint8_t> state{1, 2, 3, 4};
    PluginPresetInfo saved;
    std::string error;

    CHECK_FALSE(PluginPresetStore::save(root.path, "", "Valid", state, saved, error));
    CHECK_FALSE(PluginPresetStore::save(root.path, "VST3:vendor:synth", "\nInvalid",
                                        state, saved, error));
    CHECK_FALSE(PluginPresetStore::save(root.path, "VST3:vendor:synth", " ",
                                        state, saved, error));
    CHECK_FALSE(PluginPresetStore::save(root.path, "VST3:vendor:synth",
                                        std::string("bad\xff", 4),
                                        state, saved, error));
    PluginPresetData invalid;
    CHECK_FALSE(PluginPresetStore::load(root.path, "VST3:vendor:synth", "../bad",
                                        invalid, error));

    REQUIRE(PluginPresetStore::save(root.path, "VST3:vendor:synth", "Valid",
                                    state, saved, error));
    const auto file = PluginPresetStore::pluginDirectory(
        root.path, "VST3:vendor:synth") / (saved.id + ".rspreset");
    {
        std::fstream stream(file, std::ios::binary | std::ios::in | std::ios::out);
        REQUIRE(stream.good());
        stream.seekp(-1, std::ios::end);
        const char corrupted = 0x55;
        stream.write(&corrupted, 1);
    }
    PluginPresetData loaded;
    CHECK_FALSE(PluginPresetStore::load(root.path, "VST3:vendor:synth",
                                        saved.id, loaded, error));
    CHECK(error == "Plug-in preset state is truncated or corrupted");
}

TEST_CASE("reject duplicate exact names without replacing existing opaque state") {
    TemporaryPresetRoot root;
    PluginPresetInfo first;
    PluginPresetInfo duplicate;
    std::string error;
    REQUIRE(PluginPresetStore::save(root.path, "VST3:vendor:synth", "Warm Pad",
                                    {1, 2, 3}, first, error));
    CHECK_FALSE(PluginPresetStore::save(root.path, "VST3:vendor:synth", "Warm Pad",
                                        {9, 9, 9}, duplicate, error));
    CHECK(error == "A preset with this exact name already exists for the plug-in");

    PluginPresetData loaded;
    REQUIRE(PluginPresetStore::load(root.path, "VST3:vendor:synth", first.id,
                                    loaded, error));
    CHECK(loaded.state == std::vector<uint8_t>{1, 2, 3});
}

TEST_CASE("project package preserves preset state as a portable opaque resource") {
    TemporaryPresetRoot root;
    const std::string pluginId = "VST3:vendor.synth";
    const std::string stripId = "track:one";
    const std::string slotId = "slot/one";
    const std::vector<uint8_t> state{0, 1, 2, 0xff, 0, 7};
    PluginPresetInfo saved;
    std::string error;
    REQUIRE(PluginPresetStore::save(root.path / "library", pluginId,
                                    "Portable", state, saved, error));
    const auto resource = PluginPresetStore::projectResourceForSlot(
        stripId, slotId, saved.id);

    ProjectLoader project;
    project.newProject("Portable preset");
    TrackDef track;
    track.id = stripId;
    track.name = "Instrument";
    PluginSlot slot;
    slot.id = slotId;
    slot.plugin.identifier = pluginId;
    slot.stateResource = resource;
    track.plugins.push_back(std::move(slot));
    project.project().tracks.push_back(std::move(track));
    const auto package = root.path / "project.rsnraset";
    const std::vector<ProjectLoader::ExtraFile> extras{{resource, state}};
    REQUIRE(project.saveAsWithExtras(package.string(), extras, error,
                                     &project.project()));

    ProjectLoader reopened;
    REQUIRE(reopened.open(package.string(), error));
    std::vector<uint8_t> extracted;
    REQUIRE(reopened.extractFile(resource, extracted, error,
                                 PluginPresetStore::kMaximumStateBytes));
    CHECK(extracted == state);
}

} // TEST_SUITE
