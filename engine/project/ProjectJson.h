#pragma once

#include "ProjectSchema.h"

#include <string>

namespace resostage {

// Round-trip serializer for project.json. Used by ProjectLoader::save and tests.
// Output is UTF-8 JSON without trailing newline requirements beyond a final \n.
std::string serializeProjectJson(const Project& project);

// Escape a string for embedding in a JSON string literal.
std::string jsonEscapeString(const std::string& s);

const char* eventTypeToString(EventType type);
const char* playbackModeToString(PlaybackMode mode);

} // namespace resostage
