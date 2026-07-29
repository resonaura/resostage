#include "WavMetadata.h"

#include <cstdint>
#include <cstring>
#include <fstream>
#include <regex>
#include <vector>

namespace resostage {

namespace {

uint32_t readU32LE(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

bool parseTempoFromLabel(const std::string& label, double& outBpm) {
    static const std::regex re(R"(tempo\s*[:=]?\s*(\d+(?:\.\d+)?))", std::regex::icase);
    std::smatch m;
    if (!std::regex_search(label, m, re))
        return false;
    try {
        outBpm = std::stod(m[1].str());
    } catch (...) {
        return false;
    }
    return outBpm > 20.0 && outBpm < 400.0;
}

} // namespace

bool extractTempoFromWavFile(const std::string& filesystemPath, double& outBpm) {
    std::ifstream f(filesystemPath, std::ios::binary);
    if (!f)
        return false;

    char riffHeader[12];
    f.read(riffHeader, sizeof(riffHeader));
    if (!f || std::memcmp(riffHeader, "RIFF", 4) != 0 || std::memcmp(riffHeader + 8, "WAVE", 4) != 0)
        return false;

    while (f.good()) {
        char chunkId[4];
        uint8_t sizeBuf[4];
        f.read(chunkId, sizeof(chunkId));
        f.read(reinterpret_cast<char*>(sizeBuf), sizeof(sizeBuf));
        if (!f)
            break;
        const uint32_t chunkSize = readU32LE(sizeBuf);
        const std::streamoff chunkDataStart = f.tellg();

        // 'LIST'/'adtl' holds cue-point labels ("Tempo: 120.0" etc). Everything
        // else -- most importantly 'data', which can be hundreds of MB -- is
        // skipped via seek, never read into memory.
        if (chunkSize >= 4 && chunkSize < (64u * 1024u * 1024u) && std::memcmp(chunkId, "LIST", 4) == 0) {
            std::vector<uint8_t> buf(chunkSize);
            f.read(reinterpret_cast<char*>(buf.data()), static_cast<std::streamsize>(chunkSize));
            if (f && buf.size() >= 4 && std::memcmp(buf.data(), "adtl", 4) == 0) {
                size_t p = 4;
                while (p + 8 <= buf.size()) {
                    const uint32_t subSize = readU32LE(buf.data() + p + 4);
                    const size_t dataOff = p + 8;
                    if (dataOff + subSize > buf.size())
                        break;
                    if (subSize > 4 && std::memcmp(buf.data() + p, "labl", 4) == 0) {
                        // labl payload = 4-byte cue point ID + null-terminated text.
                        const char* textPtr = reinterpret_cast<const char*>(buf.data() + dataOff + 4);
                        const size_t textLen = subSize - 4;
                        size_t len = 0;
                        while (len < textLen && textPtr[len] != '\0')
                            ++len;
                        const std::string label(textPtr, len);
                        if (parseTempoFromLabel(label, outBpm))
                            return true;
                    }
                    p = dataOff + subSize + (subSize % 2);
                }
            }
        }

        f.clear();
        f.seekg(chunkDataStart + static_cast<std::streamoff>(chunkSize) + static_cast<std::streamoff>(chunkSize % 2),
                std::ios::beg);
        if (!f)
            break;
    }
    return false;
}

bool parseBpmFromName(const std::string& name, double& outBpm) {
    static const std::regex re(R"((\d{2,3}(?:\.\d+)?)[\s_-]*bpm)", std::regex::icase);
    std::smatch m;
    if (!std::regex_search(name, m, re))
        return false;
    try {
        outBpm = std::stod(m[1].str());
    } catch (...) {
        return false;
    }
    return outBpm > 20.0 && outBpm < 400.0;
}

std::string stripBpmSuffix(const std::string& name) {
    static const std::regex tempoSuffix(R"([\s_-]*\d{2,3}(?:\.\d+)?[\s_-]*bpm\s*$)", std::regex::icase);
    std::string stripped = std::regex_replace(name, tempoSuffix, "");
    while (!stripped.empty() &&
           (stripped.back() == '_' || stripped.back() == '-' || stripped.back() == ' '))
        stripped.pop_back();
    return stripped.empty() ? name : stripped;
}

} // namespace resostage
