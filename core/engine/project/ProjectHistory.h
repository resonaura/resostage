#pragma once

#include "ProjectSchema.h"

#include <cstddef>
#include <deque>
#include <optional>
#include <string>

namespace resostage {

// Undo/redo stack for Project edits, built around whole-Project snapshots
// rather than hand-written per-mutator inverses -- Project/SongDef/Region
// etc. are plain copyable structs (no juce::ValueTree), so a before/after
// pair of full copies captures any edit, including compound multi-region
// ones, with no per-action inverse logic to keep in sync.
//
// Callers wrap each mutation like:
//   history.beginEdit(engine.project(), gestureId, "Move region");
//   ... mutate engine.project() in place ...
//   history.commitEdit(engine.project());
//
// `gestureId` lets several begin/commit pairs collapse into ONE undo step
// (e.g. splitting a region == one regionUpdate + one regionAdd; duplicating
// N regions == N regionAdd calls) -- pass the same non-empty id for every
// sub-edit belonging to one user gesture. Leave it empty for a normal
// single-step edit (always starts a new entry).
//
// In-memory only (not persisted across project reload/app restart) and
// capped at kMaxDepth entries -- a sane default for a DAW-like undo stack.
// Whole-Project copies are cheap here: setlists are tens of songs/regions,
// not thousands.
class ProjectHistory {
public:
    static constexpr size_t kMaxDepth = 100;

    void beginEdit(const Project& before, const std::string& gestureId, const std::string& label);
    void commitEdit(const Project& after);

    bool canUndo() const { return !undoStack_.empty(); }
    bool canRedo() const { return !redoStack_.empty(); }
    std::string undoLabel() const { return undoStack_.empty() ? std::string() : undoStack_.back().label; }
    std::string redoLabel() const { return redoStack_.empty() ? std::string() : redoStack_.back().label; }

    // Pops the most recent step and returns the Project state to restore
    // (its "before" snapshot), or nullopt if there's nothing to undo. The
    // popped step moves onto the redo stack.
    std::optional<Project> undo();
    // Mirror of undo(): reapplies the most recently undone step's "after"
    // snapshot, moving it back onto the undo stack.
    std::optional<Project> redo();

    // Clears both stacks -- call on new project load/import (a fresh
    // document has no history of its own).
    void clear();

private:
    struct Entry {
        Project before;
        Project after;
        std::string label;
        std::string openGestureId; // empty = not coalescible further
    };

    std::deque<Entry> undoStack_;
    std::deque<Entry> redoStack_;
};

} // namespace resostage
