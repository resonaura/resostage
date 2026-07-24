#pragma once

#include "ProjectSchema.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace resoset {

// Reads a .rsnraset container (ZIP: project.json + /Audio/*.wav) and parses its
// metadata. WAV decoding itself is NOT performed here (kept out of this
// portable, JUCE-free engine library) -- callers use the parsed TrackDef::file
// paths together with extractFile() to get raw bytes, then decode with a
// platform audio library (juce::AudioFormatReader in the app layer).
class ProjectLoader {
public:
    ProjectLoader();
    ~ProjectLoader();

    ProjectLoader(const ProjectLoader&) = delete;
    ProjectLoader& operator=(const ProjectLoader&) = delete;

    // Opens the .rsnraset (ZIP) file and parses project.json. Returns false and
    // fills `error` on failure (bad zip, missing project.json, malformed JSON).
    bool open(const std::string& path, std::string& error);
    void close();

    const Project& project() const { return parsedProject; }

    // Extracts a file (e.g. "Audio/song1_synths1.wav") from the currently open
    // archive into an in-memory buffer. Returns false if the archive isn't open
    // or the entry doesn't exist.
    bool extractFile(const std::string& archivePath, std::vector<uint8_t>& outData, std::string& error) const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
    Project parsedProject;
};

} // namespace resoset
