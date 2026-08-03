#include "ProjectHistory.h"

#include <utility>

namespace resostage {

void ProjectHistory::beginEdit(const Project& before, const std::string& gestureId, const std::string& label) {
    if (!gestureId.empty() && !undoStack_.empty() && undoStack_.back().openGestureId == gestureId) {
        // Continuing the same gesture as the top-of-stack entry: keep its
        // original `before` snapshot, nothing to push. commitEdit() will
        // overwrite `after` below.
        return;
    }

    Entry entry;
    entry.before = before;
    entry.after = before; // placeholder until commitEdit(); overwritten unconditionally there
    entry.label = label;
    entry.openGestureId = gestureId;
    undoStack_.push_back(std::move(entry));
    if (undoStack_.size() > kMaxDepth)
        undoStack_.pop_front();

    // A genuinely new edit (not a continuation of the in-flight gesture, if
    // any) invalidates any previously-undone future.
    redoStack_.clear();
}

void ProjectHistory::commitEdit(const Project& after) {
    if (undoStack_.empty())
        return;
    undoStack_.back().after = after;
}

std::optional<Project> ProjectHistory::undo() {
    if (undoStack_.empty())
        return std::nullopt;
    Entry entry = std::move(undoStack_.back());
    undoStack_.pop_back();
    Project restored = entry.before;
    redoStack_.push_back(std::move(entry));
    if (redoStack_.size() > kMaxDepth)
        redoStack_.pop_front();
    return restored;
}

std::optional<Project> ProjectHistory::redo() {
    if (redoStack_.empty())
        return std::nullopt;
    Entry entry = std::move(redoStack_.back());
    redoStack_.pop_back();
    Project restored = entry.after;
    undoStack_.push_back(std::move(entry));
    if (undoStack_.size() > kMaxDepth)
        undoStack_.pop_front();
    return restored;
}

void ProjectHistory::clear() {
    undoStack_.clear();
    redoStack_.clear();
}

} // namespace resostage
