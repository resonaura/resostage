// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

#include "WebServer.h"
#include "platform/MenuModel.h"
#include "server/WireTypes.h"
#include "server/BuilderJson.h"

#include <utility>

namespace resostage {

using namespace wire;

// MenuModel → JSON for the Electron shell (electron/main.mts builds the real
// NSMenu). Not drawn by Core. Keybindings + recent projects ride along for
// dynamic accelerators and File > Open Recent.
std::string WebServer::buildMenuModelJson() const {
    WMenuModelPayload wire;
    const auto& menus = menuModel();
    wire.menus.reserve(menus.size());

    const auto convertItem = [&](const auto& self, const MenuItemModel& item) -> WMenuItem {
        WMenuItem wItem;
        switch (item.kind) {
        case MenuItemModel::Kind::Separator:
            wItem.separator = true;
            break;
        case MenuItemModel::Kind::OpenRecent:
            wItem.kind = "open-recent";
            wItem.title = item.title;
            break;
        case MenuItemModel::Kind::Item:
            wItem.title = item.title;
            if (!item.role.empty()) {
                wItem.role = item.role;
            } else if (!item.actionId.empty()) {
                wItem.actionId = item.actionId;
                if (item.dynamicKey)
                    wItem.dynamicKey = true;
                else if (!item.key.empty())
                    wItem.key = item.key;
            }
            break;
        }
        for (const auto& child : item.children)
            wItem.children.push_back(self(self, child));
        return wItem;
    };

    for (const auto& menu : menus) {
        WMenu wMenu;
        wMenu.title = menu.title;
        wMenu.items.reserve(menu.items.size());

        for (const auto& item : menu.items)
            wMenu.items.push_back(convertItem(convertItem, item));
        wire.menus.push_back(std::move(wMenu));
    }

    const auto& tabs = touchBarTabs();
    wire.touchbar.reserve(tabs.size());
    for (const auto& tab : tabs) {
        WTouchBarTab wTab;
        wTab.id = tab.id;
        wTab.label = tab.label;
        wire.touchbar.push_back(std::move(wTab));
    }

    WebUiState snap;
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        snap = state;
    }

    for (const auto& kb : snap.settings.keybindings) {
        wire.keybindings[kb.action] = kb.key;
    }

    wire.recentProjects.reserve(snap.settings.recentProjects.size());
    for (const auto& rp : snap.settings.recentProjects) {
        WRecentProjectTelemetry wRp;
        wRp.path = rp.path;
        wRp.displayName = rp.displayName;
        wRp.lastOpenedIso = rp.lastOpenedIso;
        wire.recentProjects.push_back(std::move(wRp));
    }

    std::string json;
    (void)glz::write_json(wire, json);
    return json;
}


} // namespace resostage
