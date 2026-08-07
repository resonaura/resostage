#pragma once

#include "ProjectSchema.h"

#include <algorithm>
#include <cmath>
#include <string>

namespace resostage {

// Convert a SendConfig::level (0-100 linear percent, 100 == unity / 0 dB) to
// the dB value the wire has always carried for sends. level <= 0 floors to
// -144 dB. Exact inverse of sendDbToLevel().
inline double sendLevelToDb(double level) {
    if (!(level > 0.0))
        return -144.0;
    return 20.0 * std::log10(level / 100.0);
}

// Convert a wire dB send value to the schema's 0-100 linear level. Same curve
// LegacyProjectMigration uses for old projects (gain past unity clamps to
// 100%) so round-trips and migrated projects agree on one mapping.
inline double sendDbToLevel(double db) {
    if (!std::isfinite(db))
        return 0.0;
    return std::clamp(std::pow(10.0, db / 20.0) * 100.0, 0.0, 100.0);
}

// Serialize Project → project.json via Glaze (reflection wire DTOs).
// Output is UTF-8 pretty JSON with a trailing newline.
std::string serializeProjectJson(const Project& project);

// Parse project.json via Glaze into Project. Unknown keys ignored. Assumes
// the CURRENT on-disk shape -- does not migrate older formats; that's
// ProjectLoader::reparseProject()'s job, via LegacyProjectMigration.h.
bool parseProjectJson(std::string_view json, Project& out, std::string& error);

// Tolerantly reads just `format.version` (0 if absent/unparseable), so
// ProjectLoader::reparseProject() can decide current-shape vs. legacy-shape
// BEFORE running the strict parser -- a current-format file that fails
// semantic validation (e.g. an unknown event type) must surface that real
// error, not silently fall back to the lenient legacy migrator.
int peekProjectFormatVersion(std::string_view json);

// Escape a string for embedding in a JSON string literal.
std::string jsonEscapeString(const std::string& s);

const char* eventTypeToString(EventType type);
const char* playbackModeToString(PlaybackMode mode);
const char* lightFixtureKindToString(LightFixture::Kind kind);
const char* lightingKindToString(LightingKind kind);
const char* outputTypeToString(OutputType type);
OutputType outputTypeFromString(const std::string& s);

// "audio::out:N" (mono) or "audio::out:N,audio::out:N+1" (stereo pair) from
// a 0-based physical start channel + width. Shared by LegacyProjectMigration
// and AudioEngineRouting so the id scheme has exactly one source of truth.
std::string extOutTarget(int startChannel0Based, int channels);

// Inverse of extOutTarget: parses an ExtOut BusRoute/SourceOutput target
// string into a 0-based start channel + channel count. Unparseable/empty
// input yields {0, 1} (never guesses stereo).
void parseExtOutTarget(const std::string& target, int& startChannel0Based, int& channelCount);

} // namespace resostage
