// Synthesizes a test .rsnraset (ZIP: project.json + /Audio/*.wav) with
// sine-tone stems, so Milestone 1 can be verified on real hardware without
// needing real band recordings. See the plan's verification section.
//
// Layout: 2 songs, 3 busses (bus_synths -> phys ch 0-1, bus_guitars -> phys
// ch 2-3, bus_click -> phys ch 4-5). Each song's tracks use distinct
// frequencies so routing correctness is audible/identifiable by ear or by
// inspecting the recorded output. "Synths" is a genuine stereo file
// (different tone per channel) to exercise the stereo track -> stereo bus
// pass-through path; the others are mono to exercise the mono-track pan path.

#include "miniz.h"

#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr double kPi = 3.14159265358979323846;

void appendU32(std::vector<uint8_t>& buf, uint32_t v) {
    buf.push_back(static_cast<uint8_t>(v & 0xFF));
    buf.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
    buf.push_back(static_cast<uint8_t>((v >> 16) & 0xFF));
    buf.push_back(static_cast<uint8_t>((v >> 24) & 0xFF));
}
void appendU16(std::vector<uint8_t>& buf, uint16_t v) {
    buf.push_back(static_cast<uint8_t>(v & 0xFF));
    buf.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
}
void appendTag(std::vector<uint8_t>& buf, const char* tag) {
    buf.insert(buf.end(), tag, tag + 4);
}

// Writes a canonical 16-bit PCM WAV. `channelSamples` holds one vector of
// float samples (range [-1, 1]) per channel; all channels must be equal length.
std::vector<uint8_t> makeWavPCM16(const std::vector<std::vector<float>>& channelSamples, double sampleRate) {
    const uint16_t numChannels = static_cast<uint16_t>(channelSamples.size());
    const uint32_t numFrames = static_cast<uint32_t>(channelSamples.empty() ? 0 : channelSamples[0].size());
    const uint16_t bitsPerSample = 16;
    const uint32_t byteRate = static_cast<uint32_t>(sampleRate) * numChannels * (bitsPerSample / 8);
    const uint16_t blockAlign = static_cast<uint16_t>(numChannels * (bitsPerSample / 8));
    const uint32_t dataSize = numFrames * blockAlign;

    std::vector<uint8_t> out;
    out.reserve(44 + dataSize);

    appendTag(out, "RIFF");
    appendU32(out, 36 + dataSize);
    appendTag(out, "WAVE");

    appendTag(out, "fmt ");
    appendU32(out, 16); // fmt chunk size
    appendU16(out, 1);  // PCM
    appendU16(out, numChannels);
    appendU32(out, static_cast<uint32_t>(sampleRate));
    appendU32(out, byteRate);
    appendU16(out, blockAlign);
    appendU16(out, bitsPerSample);

    appendTag(out, "data");
    appendU32(out, dataSize);

    for (uint32_t i = 0; i < numFrames; ++i) {
        for (uint16_t ch = 0; ch < numChannels; ++ch) {
            float s = channelSamples[ch][i];
            s = std::max(-1.0f, std::min(1.0f, s));
            const int16_t sample = static_cast<int16_t>(std::lround(s * 32767.0f));
            out.push_back(static_cast<uint8_t>(sample & 0xFF));
            out.push_back(static_cast<uint8_t>((sample >> 8) & 0xFF));
        }
    }

    return out;
}

std::vector<float> sineTone(double freqHz, double sampleRate, double durationSec, float amplitude, double fadeSec = 0.02) {
    const int n = static_cast<int>(durationSec * sampleRate);
    const int fadeSamples = std::max(1, static_cast<int>(fadeSec * sampleRate));
    std::vector<float> out(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) {
        float env = 1.0f;
        if (i < fadeSamples)
            env = static_cast<float>(i) / static_cast<float>(fadeSamples);
        else if (i > n - fadeSamples)
            env = static_cast<float>(n - i) / static_cast<float>(fadeSamples);
        out[static_cast<size_t>(i)] =
            amplitude * env * static_cast<float>(std::sin(2.0 * kPi * freqHz * i / sampleRate));
    }
    return out;
}

struct TrackSpec {
    std::string id, name, busId, fileName;
    bool stereo = false;
    double freqL = 220.0, freqR = 330.0;
};

struct SongSpec {
    std::string id, name;
    double bpm;
    std::vector<TrackSpec> tracks;
};

} // namespace

int main(int argc, char** argv) {
    std::string outPath = "test_project.rsnraset";
    double sampleRate = 48000.0;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--out" && i + 1 < argc)
            outPath = argv[++i];
        else if (arg == "--samplerate" && i + 1 < argc)
            sampleRate = std::stod(argv[++i]);
    }

    const double durationSec = 20.0;

    std::vector<SongSpec> songs = {
        SongSpec{"song_1", "Opener (Test Tones A)", 128.0,
                 {
                     TrackSpec{"trk_synths_1", "Synths", "bus_synths", "Audio/song1_synths.wav", true, 220.0, 330.0},
                     TrackSpec{"trk_guitars_1", "Guitars", "bus_guitars", "Audio/song1_guitars.wav", false, 440.0},
                     TrackSpec{"trk_click_1", "Click", "bus_click", "Audio/song1_click.wav", false, 880.0},
                 }},
        SongSpec{"song_2", "Second Song (Test Tones B)", 96.0,
                 {
                     TrackSpec{"trk_synths_2", "Synths", "bus_synths", "Audio/song2_synths.wav", true, 261.63, 392.0},
                     TrackSpec{"trk_guitars_2", "Guitars", "bus_guitars", "Audio/song2_guitars.wav", false, 523.25},
                     TrackSpec{"trk_click_2", "Click", "bus_click", "Audio/song2_click.wav", false, 987.77},
                 }},
    };

    mz_zip_archive zip;
    std::memset(&zip, 0, sizeof(zip));
    if (!mz_zip_writer_init_file(&zip, outPath.c_str(), 0)) {
        std::cerr << "Failed to create archive: " << outPath << "\n";
        return 1;
    }

    for (const SongSpec& song : songs) {
        for (const TrackSpec& track : song.tracks) {
            std::vector<std::vector<float>> channels;
            if (track.stereo) {
                channels.push_back(sineTone(track.freqL, sampleRate, durationSec, 0.5f));
                channels.push_back(sineTone(track.freqR, sampleRate, durationSec, 0.5f));
            } else {
                channels.push_back(sineTone(track.freqL, sampleRate, durationSec, 0.5f));
            }
            std::vector<uint8_t> wav = makeWavPCM16(channels, sampleRate);

            if (!mz_zip_writer_add_mem(&zip, track.fileName.c_str(), wav.data(), wav.size(), MZ_BEST_SPEED)) {
                std::cerr << "Failed to add " << track.fileName << " to archive\n";
                mz_zip_writer_end(&zip);
                return 1;
            }
            std::cout << "Wrote " << track.fileName << " (" << wav.size() << " bytes)\n";
        }
    }

    std::ostringstream json;
    json << "{\n";
    json << "  \"formatVersion\": 1,\n";
    json << "  \"name\": \"Milestone 1 Test Project\",\n";
    json << "  \"sampleRate\": " << static_cast<int>(sampleRate) << ",\n";
    json << "  \"busses\": [\n";
    json << "    { \"id\": \"bus_synths\", \"name\": \"Synths\", \"channels\": 2, \"output\": { \"startChannel\": 0 }, \"gainDb\": 0.0 },\n";
    json << "    { \"id\": \"bus_guitars\", \"name\": \"Guitars\", \"channels\": 2, \"output\": { \"startChannel\": 2 }, \"gainDb\": 0.0 },\n";
    json << "    { \"id\": \"bus_click\", \"name\": \"Click\", \"channels\": 2, \"output\": { \"startChannel\": 4 }, \"gainDb\": -6.0 }\n";
    json << "  ],\n";
    json << "  \"songs\": [\n";
    for (size_t s = 0; s < songs.size(); ++s) {
        const SongSpec& song = songs[s];
        json << "    {\n";
        json << "      \"id\": \"" << song.id << "\",\n";
        json << "      \"name\": \"" << song.name << "\",\n";
        json << "      \"bpm\": " << song.bpm << ",\n";
        json << "      \"timeSignature\": { \"numerator\": 4, \"denominator\": 4 },\n";
        json << "      \"playbackMode\": \"waitForTrigger\",\n";
        json << "      \"tracks\": [\n";
        for (size_t t = 0; t < song.tracks.size(); ++t) {
            const TrackSpec& track = song.tracks[t];
            json << "        { \"id\": \"" << track.id << "\", \"name\": \"" << track.name << "\", \"file\": \""
                 << track.fileName << "\", \"bus\": \"" << track.busId << "\", \"gainDb\": 0.0, \"pan\": 0.0, \"mute\": false }";
            json << (t + 1 < song.tracks.size() ? ",\n" : "\n");
        }
        json << "      ],\n";
        json << "      \"events\": []\n";
        json << "    }";
        json << (s + 1 < songs.size() ? ",\n" : "\n");
    }
    json << "  ],\n";
    json << "  \"keybindings\": {},\n";
    json << "  \"midiMappings\": []\n";
    json << "}\n";

    const std::string jsonStr = json.str();
    if (!mz_zip_writer_add_mem(&zip, "project.json", jsonStr.data(), jsonStr.size(), MZ_BEST_SPEED)) {
        std::cerr << "Failed to add project.json to archive\n";
        mz_zip_writer_end(&zip);
        return 1;
    }

    if (!mz_zip_writer_finalize_archive(&zip)) {
        std::cerr << "Failed to finalize archive\n";
        mz_zip_writer_end(&zip);
        return 1;
    }
    mz_zip_writer_end(&zip);

    std::cout << "Wrote " << outPath << "\n";
    return 0;
}
