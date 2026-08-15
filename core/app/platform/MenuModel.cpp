#include "platform/MenuModel.h"
#include <juce_core/juce_core.h>

namespace resostage {

// Platform-adaptive modifier key: "cmd" on macOS, "ctrl" on Windows/Linux
static std::string platformModifier() {
#if JUCE_MAC
    return "cmd";
#else
    return "ctrl";
#endif
}

static const std::vector<MenuSectionModel> kMenuModel = [] {
    std::vector<MenuSectionModel> menus;
    menus.reserve(6);
    const std::string mod = platformModifier();

#if JUCE_MAC
    // ── ResoStage (macOS App Menu) ──────────────────────────────────────────
    {
        MenuSectionModel section;
        section.title = "ResoStage";
        MenuItemModel about;
        about.title = "About ResoStage";
        about.role = "about";
        section.items.push_back(std::move(about));
        MenuItemModel sep;
        sep.kind = MenuItemModel::Kind::Separator;
        section.items.push_back(sep);
        MenuItemModel quit;
        quit.title = "Quit ResoStage";
        quit.actionId = "quit";
        quit.key = mod + " + q";
        section.items.push_back(std::move(quit));
        menus.push_back(std::move(section));
    }
#endif

    // ── File ───────────────────────────────────────────────────────────────
    {
        MenuSectionModel section;
        section.title = "File";
        {
            MenuItemModel item;
            item.title = "New Project";
            item.actionId = "new_project";
            item.key = mod + " + n";
            section.items.push_back(std::move(item));
        }
        {
            MenuItemModel item;
            item.title = "Open…";
            item.actionId = "open_project";
            item.key = mod + " + o";
            section.items.push_back(std::move(item));
        }
        {
            MenuItemModel item;
            item.title = "Open Recent";
            item.kind = MenuItemModel::Kind::OpenRecent;
            section.items.push_back(std::move(item));
        }
        {
            MenuItemModel sep;
            sep.kind = MenuItemModel::Kind::Separator;
            section.items.push_back(sep);
        }
        {
            MenuItemModel item;
            item.title = "Save";
            item.actionId = "save_project";
            item.key = mod + " + s";
            section.items.push_back(std::move(item));
        }
        {
            MenuItemModel item;
            item.title = "Save As…";
            item.actionId = "save_project_as";
            item.key = mod + " + shift + s";
            section.items.push_back(std::move(item));
        }
        {
            MenuItemModel sep;
            sep.kind = MenuItemModel::Kind::Separator;
            section.items.push_back(sep);
        }
        {
            MenuItemModel item;
            item.title = "Import Song Folder…";
            item.actionId = "import_song_folder";
            section.items.push_back(std::move(item));
        }
#if !JUCE_MAC
        {
            MenuItemModel sep;
            sep.kind = MenuItemModel::Kind::Separator;
            section.items.push_back(sep);
        }
        {
            MenuItemModel item;
            item.title = "Exit";
            item.actionId = "quit";
            item.key = "alt + f4";
            section.items.push_back(std::move(item));
        }
#endif
        menus.push_back(std::move(section));
    }

    // ── Edit ───────────────────────────────────────────────────────────────
    {
        MenuSectionModel section;
        section.title = "Edit";
        {
            MenuItemModel item;
            item.title = "Undo";
            item.actionId = "undo";
            item.dynamicKey = true;
            section.items.push_back(std::move(item));
        }
        {
            MenuItemModel item;
            item.title = "Redo";
            item.actionId = "redo";
            item.dynamicKey = true;
            section.items.push_back(std::move(item));
        }
        menus.push_back(std::move(section));
    }

    // ── View ───────────────────────────────────────────────────────────────
    {
        MenuSectionModel section;
        section.title = "View";
        for (const auto& [id, label] : std::initializer_list<std::pair<const char*, const char*>>{
                 {"mode_player", "Player"},
                 {"mode_mixer", "Mixer"},
                 {"mode_editor", "Editor"},
                 {"mode_light", "Light"},
                 {"mode_settings", "Settings"},
             }) {
            MenuItemModel item;
            item.title = label;
            item.actionId = id;
            item.dynamicKey = true;
            section.items.push_back(std::move(item));
        }
        menus.push_back(std::move(section));
    }

    // ── Transport ──────────────────────────────────────────────────────────
    {
        MenuSectionModel section;
        section.title = "Transport";
        for (const auto& [id, label, sepBefore] : std::initializer_list<
                 std::tuple<const char*, const char*, bool>>{
                 {"play", "Play / Pause", false},
                 {"stop", "Stop", false},
                 {"stop_to_start", "Stop to Start", false},
                 {"next", "Next Song", true},
                 {"prev", "Previous Song", false},
                 {"section_prev", "Previous Section", true},
                 {"section_next", "Next Section", false},
                 {"bar_prev", "Previous Bar", true},
                 {"bar_next", "Next Bar", false},
             }) {
            if (sepBefore) {
                MenuItemModel sep;
                sep.kind = MenuItemModel::Kind::Separator;
                section.items.push_back(sep);
            }
            MenuItemModel item;
            item.title = label;
            item.actionId = id;
            item.dynamicKey = true;
            section.items.push_back(std::move(item));
        }
        menus.push_back(std::move(section));
    }

    // ── Window ─────────────────────────────────────────────────────────────
    {
        MenuSectionModel section;
        section.title = "Window";
        {
            MenuItemModel item;
            item.title = "Minimize";
            item.role = "minimize";
            item.key = mod + " + m";
            section.items.push_back(std::move(item));
        }
#if JUCE_MAC
        {
            MenuItemModel item;
            item.title = "Zoom";
            item.role = "zoom";
            section.items.push_back(std::move(item));
        }
#endif
        menus.push_back(std::move(section));
    }

#if !JUCE_MAC
    // ── Help (Windows / Linux) ─────────────────────────────────────────────
    {
        MenuSectionModel section;
        section.title = "Help";
        {
            MenuItemModel about;
            about.title = "About ResoStage";
            about.role = "about";
            section.items.push_back(std::move(about));
        }
        menus.push_back(std::move(section));
    }
#endif

    return menus;
}();

const std::vector<MenuSectionModel>& menuModel() {
    return kMenuModel;
}

static const std::vector<TouchBarTabModel> kTouchBarTabs = {
    {"player", "Player"},
    {"mixer", "Mixer"},
    {"editor", "Editor"},
    {"light", "Light"},
    {"settings", "Settings"},
};

const std::vector<TouchBarTabModel>& touchBarTabs() {
    return kTouchBarTabs;
}

} // namespace resostage
