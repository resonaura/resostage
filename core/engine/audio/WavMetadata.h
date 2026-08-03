#pragma once

#include <string>

namespace resostage {

// Looks for an embedded tempo marker in a WAV file's RIFF metadata chunks.
// DAWs typically don't write a structured numeric BPM field -- instead
// (confirmed against real Logic Pro-exported stems) they write a standard
// 'cue ' chunk plus a 'LIST'/'adtl'/'labl' sub-chunk labeling that cue point
// with free text like "Tempo: 120.0". This scans top-level chunks (skipping
// the 'data' chunk's payload via seek, never reading multi-hundred-MB audio
// into memory) for any 'LIST'/'adtl' chunk, parses its 'labl' sub-chunks,
// and regex-ish matches a "tempo" label for a following number.
//
// Returns false if the file can't be opened, isn't a RIFF/WAVE file, or no
// tempo label was found -- callers should fall back to another source (e.g.
// parsing a "120BPM"-style token from the containing folder/file name).
bool extractTempoFromWavFile(const std::string& filesystemPath, double& outBpm);

// Parses a "120BPM" / "120 bpm" / "_120_BPM_" style token out of an
// arbitrary name (folder name, file name). Case-insensitive, requires the
// number to be immediately followed by "bpm" (ignoring whitespace/
// underscores). Returns false if no such token is found.
bool parseBpmFromName(const std::string& name, double& outBpm);

// Strips a trailing tempo token ("_120BPM", " 120 bpm", etc, case-insensitive)
// and surrounding separator characters from a name -- used to clean up a
// stem filename ("NVRLND_BASS_120BPM" -> "NVRLND_BASS") for use as a track
// display name. Returns the input unchanged if there's nothing to strip, and
// never returns an empty string (falls back to the original input).
std::string stripBpmSuffix(const std::string& name);

} // namespace resostage
