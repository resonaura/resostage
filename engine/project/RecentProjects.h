#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace resostage {

// One entry in the rig-wide "recently opened/saved projects" list (see
// AppSettings::recentProjects). Kept plain/JUCE-free so the list-maintenance
// logic below is testable without a JUCE-linked test target.
struct RecentProjectEntry {
    std::string path;         // absolute .rsnraset path, uniquely identifies the entry
    std::string displayName;  // project name (or filename fallback) at time of last touch
    std::string lastOpenedIso; // ISO-8601 timestamp, most recent load/save
};

inline constexpr size_t kMaxRecentProjects = 10;

// Moves `entry` to the front of `list` (inserting if not already present,
// deduping by `path` if it is), then caps the list at `maxEntries` by
// evicting from the back (oldest). Most-recent-first ordering throughout.
inline void touchRecentProject(std::vector<RecentProjectEntry>& list,
                                RecentProjectEntry entry,
                                size_t maxEntries = kMaxRecentProjects) {
    for (size_t i = 0; i < list.size(); ++i) {
        if (list[i].path == entry.path) {
            list.erase(list.begin() + static_cast<std::ptrdiff_t>(i));
            break;
        }
    }
    list.insert(list.begin(), std::move(entry));
    if (list.size() > maxEntries)
        list.resize(maxEntries);
}

// Drops the entry for `path`, if present (e.g. opening a recent entry failed
// because the file was moved/deleted). No-op if not found.
inline void removeRecentProject(std::vector<RecentProjectEntry>& list, const std::string& path) {
    for (size_t i = 0; i < list.size(); ++i) {
        if (list[i].path == path) {
            list.erase(list.begin() + static_cast<std::ptrdiff_t>(i));
            return;
        }
    }
}

} // namespace resostage
