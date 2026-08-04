#pragma once

#include "ProjectSchema.h"

#include <string>

namespace resostage {

// Serialize Project → project.json via Glaze (reflection wire DTOs).
// Output is UTF-8 pretty JSON with a trailing newline.
std::string serializeProjectJson(const Project& project);

// Parse project.json via Glaze into Project. Unknown keys ignored; no legacy
// format migrations (per-song tracks/cycle/click are not supported).
bool parseProjectJson(std::string_view json, Project& out, std::string& error);

// Escape a string for embedding in a JSON string literal.
std::string jsonEscapeString(const std::string& s);

const char* eventTypeToString(EventType type);
const char* playbackModeToString(PlaybackMode mode);
const char* lightFixtureKindToString(LightFixture::Kind kind);
const char* lightingKindToString(LightingKind kind);

} // namespace resostage
