#include "MainComponent.h"

#include "project/Uuid.h"
#include "server/BuilderJson.h"

#include <algorithm>

namespace resostage {
namespace {

std::vector<PluginSlot>* pluginChainFor(Project& project,
                                        const std::string& stripId) {
    if (stripId == "audio::main")
        return &project.main.plugins;
    if (stripId == "audio::click")
        return &project.click.plugins;
    for (auto& track : project.tracks)
        if (track.id == stripId)
            return &track.plugins;
    for (auto& send : project.sends)
        if (send.id == stripId)
            return &send.plugins;
    return nullptr;
}

size_t projectPluginCount(const Project& project) {
    size_t count = project.main.plugins.size() + project.click.plugins.size();
    for (const auto& track : project.tracks)
        count += track.plugins.size();
    for (const auto& send : project.sends)
        count += send.plugins.size();
    return count;
}

bool parseSlotTarget(const std::string& json, glz::generic& doc,
                     std::string& stripId, std::string& slotId) {
    return builder_json::parseJson(json, doc)
        && builder_json::getString(doc, "stripId", stripId)
        && builder_json::getString(doc, "slotId", slotId)
        && !stripId.empty() && !slotId.empty();
}

} // namespace

void MainComponent::pluginSlotAdd(const std::string& json) {
    glz::generic doc;
    std::string stripId;
    std::string pluginId;
    if (!builder_json::parseJson(json, doc)
        || !builder_json::getString(doc, "stripId", stripId)
        || !builder_json::getString(doc, "pluginId", pluginId)) {
        setStatus("Could not add plug-in: invalid request");
        return;
    }
    Project& project = engine.project();
    auto* chain = pluginChainFor(project, stripId);
    if (chain == nullptr) {
        setStatus("Could not add plug-in: strip no longer exists");
        return;
    }
    if (chain->size() >= 32 || projectPluginCount(project) >= 128) {
        setStatus("Could not add plug-in: insert limit reached");
        return;
    }
    const auto plugin = pluginCatalog.findPlugin(pluginId);
    if (!plugin.has_value()) {
        setStatus("Could not add plug-in: rescan or choose an available item");
        return;
    }
    if (plugin->instrument) {
        setStatus("Instrument plug-ins need a MIDI instrument track; audio inserts accept effects");
        return;
    }

    engine.projectHistoryBeginEdit("", "Add plug-in");
    PluginSlot slot;
    slot.id = generateUuidV7();
    slot.plugin = *plugin;
    chain->push_back(std::move(slot));
    engine.projectHistoryCommitEdit();
    engine.notifyPluginChainsChanged();
    setStatus("Plug-in added: " + juce::String(plugin->name));
    publishWebState();
}

void MainComponent::pluginSlotRemove(const std::string& json) {
    glz::generic doc;
    std::string stripId;
    std::string slotId;
    if (!parseSlotTarget(json, doc, stripId, slotId))
        return;
    auto* chain = pluginChainFor(engine.project(), stripId);
    if (chain == nullptr)
        return;
    const auto found = std::find_if(chain->begin(), chain->end(),
        [&](const PluginSlot& slot) { return slot.id == slotId; });
    if (found == chain->end())
        return;
    engine.projectHistoryBeginEdit("", "Remove plug-in");
    chain->erase(found);
    engine.projectHistoryCommitEdit();
    engine.notifyPluginChainsChanged();
    setStatus("Plug-in removed");
    publishWebState();
}

void MainComponent::pluginSlotMove(const std::string& json) {
    glz::generic doc;
    std::string stripId;
    std::string slotId;
    int toIndex = -1;
    if (!parseSlotTarget(json, doc, stripId, slotId)
        || !builder_json::getInt(doc, "toIndex", toIndex))
        return;
    auto* chain = pluginChainFor(engine.project(), stripId);
    if (chain == nullptr || chain->empty())
        return;
    const auto found = std::find_if(chain->begin(), chain->end(),
        [&](const PluginSlot& slot) { return slot.id == slotId; });
    if (found == chain->end())
        return;
    const size_t from = static_cast<size_t>(std::distance(chain->begin(), found));
    const size_t to = static_cast<size_t>(std::clamp(
        toIndex, 0, static_cast<int>(chain->size() - 1)));
    if (from == to)
        return;
    engine.projectHistoryBeginEdit("", "Move plug-in");
    PluginSlot moving = std::move((*chain)[from]);
    chain->erase(chain->begin() + static_cast<std::ptrdiff_t>(from));
    chain->insert(chain->begin() + static_cast<std::ptrdiff_t>(to),
                  std::move(moving));
    engine.projectHistoryCommitEdit();
    engine.notifyPluginChainsChanged();
    publishWebState();
}

void MainComponent::pluginSlotBypass(const std::string& json) {
    glz::generic doc;
    std::string stripId;
    std::string slotId;
    bool bypassed = false;
    if (!parseSlotTarget(json, doc, stripId, slotId)
        || !builder_json::getBool(doc, "bypassed", bypassed))
        return;
    auto* chain = pluginChainFor(engine.project(), stripId);
    if (chain == nullptr)
        return;
    const auto found = std::find_if(chain->begin(), chain->end(),
        [&](const PluginSlot& slot) { return slot.id == slotId; });
    if (found == chain->end() || found->bypassed == bypassed)
        return;
    engine.projectHistoryBeginEdit("", bypassed ? "Bypass plug-in"
                                                 : "Enable plug-in");
    found->bypassed = bypassed;
    engine.projectHistoryCommitEdit();
    engine.notifyPluginChainsChanged();
    publishWebState();
}

} // namespace resostage
