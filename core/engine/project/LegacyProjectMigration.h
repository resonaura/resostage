// DELETE THIS FILE WHOLESALE once no pre-beta (.rsnraset format v1) projects
// remain in the wild. This is a single bridge step from the old flat
// project.json shape (formatVersion, builtInClick*, busses[isAux], direct:N
// ids, dB-valued sends) to the current shape (ProjectSchema.h) -- NOT the
// first link of a version chain. If the schema changes again after this,
// write a new one-shot migration and delete this one; don't append to it.
#pragma once

#include "ProjectSchema.h"

#include <string>
#include <string_view>

namespace resostage {

// Parses `rawJson` as the OLD (pre-v2) project.json shape and converts it
// directly into the CURRENT Project struct. Returns false (with `error` set)
// only if the JSON is unparseable garbage -- never for "this just happens to
// already be new-shape JSON" (callers should try parseProjectJson() first
// and only fall back to this on failure / stale format.version).
bool migrateLegacyProject(std::string_view rawJson, Project& out, std::string& error);

} // namespace resostage
