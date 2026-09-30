#include "server/WebServerTelemetryBinary.h"
#include "events/MidiNoteActivity.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <vector>

namespace resostage {
std::vector<uint8_t> buildBinaryTelemetryFrame(const WebUiState& s, uint32_t seq) {
    const uint16_t numTracks = static_cast<uint16_t>(s.tracks.size());
    const uint16_t numMeters = static_cast<uint16_t>(s.meters.size());
    const uint16_t numLights = static_cast<uint16_t>(s.lightOutput.size());
    const uint16_t numBusses = static_cast<uint16_t>(s.busses.size());

    // Sparse per-track pitch bitmaps: worst case is 1024 tracks × 128 pitches
    // (about 18 KiB including row indices), while ordinary sessions send only
    // a few active rows. This is a full snapshot, not an event delta, so a lost
    // UDP packet cannot leave a key lit indefinitely.
    std::array<std::array<uint64_t, 2>, kMaxActiveMidiTracks> activeMidiMasks{};
    for (const auto& note : s.activeMidiNotes) {
        if (note.trackIndex < 0
            || static_cast<size_t>(note.trackIndex) >= kMaxActiveMidiTracks
            || note.pitch < 0 || note.pitch >= static_cast<int>(kMidiPitchCount))
            continue;
        const auto pitch = static_cast<size_t>(note.pitch);
        activeMidiMasks[static_cast<size_t>(note.trackIndex)][pitch / 64]
            |= uint64_t{1} << (pitch % 64);
    }
    uint16_t activeMidiTrackRows = 0;
    for (const auto& mask : activeMidiMasks)
        if (mask[0] != 0 || mask[1] != 0) ++activeMidiTrackRows;

    size_t ledByteCount = 0;
    for (const auto& lo : s.lightOutput)
        ledByteCount += std::min<size_t>(lo.ledColors.size(), 512) * 3;

    // v9 header is 66 bytes:
    // Layout:
    //   0  u16 magic (0x5253)
    //   2  u8  version (9)
    //   3  u8  flags (bit 0 = playing)
    //   4  u32 seq (monotonically increasing frame index)
    //   8  f32 playheadSeconds
    //  12  f32 clickPeakDbL
    //  16  f32 clickPeakDbR
    //  20  f32 clickIntervalPeakDbL
    //  24  f32 clickIntervalPeakDbR
    //  28  f32 bpm
    //  32  i16 songIndex
    //  34  u16 reserved (0)
    //  36  f32 globalPlayheadSeconds
    //  40  f32 driftFactor
    //  44  f32 cpuPercent
    //  48  f32 ramMb
    //  52  f32 totalRamMb
    //  56  u16 cpuCoreCount
    //  58  u16 numTracks
    //  60  u16 numMeters
    //  62  u16 numLights
    //  64  u16 numBusses
    // = 66 bytes
    const size_t totalSize = 66
        + static_cast<size_t>(numTracks) * 8
        + static_cast<size_t>(numMeters) * 16
        + static_cast<size_t>(numTracks)          // per-track flags
        + static_cast<size_t>(numBusses)          // per-bus flags
        + static_cast<size_t>(activeMidiTrackRows) * 18 // index + pitch mask
        + static_cast<size_t>(numLights) * 4  // fixtureIdx + ledCount per row
        + ledByteCount;

    std::vector<uint8_t> buf(totalSize);
    uint8_t* p = buf.data();

    const auto writeU32 = [&p](uint32_t val) {
        std::memcpy(p, &val, 4);
        p += 4;
    };
    const auto writeU64 = [&p](uint64_t val) {
        std::memcpy(p, &val, 8);
        p += 8;
    };
    const auto writeU16 = [&p](uint16_t val) {
        std::memcpy(p, &val, 2);
        p += 2;
    };
    const auto writeI16 = [&p](int16_t val) {
        std::memcpy(p, &val, 2);
        p += 2;
    };
    const auto writeU8 = [&p](uint8_t val) {
        *p++ = val;
    };
    const auto writeFloat = [&p](float val) {
        std::memcpy(p, &val, 4);
        p += 4;
    };

    writeU16(0x5253); // Magic "RS" (0x5253 in little-endian)
    writeU8(9);       // Version 9: v8 + active MIDI pitch masks
    writeU8(s.playing ? 1 : 0);
    writeU32(seq);
    writeFloat(static_cast<float>(s.playheadSeconds));
    writeFloat(s.clickPeakDbL);
    writeFloat(s.clickPeakDbR);
    writeFloat(s.clickIntervalPeakDbL);
    writeFloat(s.clickIntervalPeakDbR);
    writeFloat(static_cast<float>(s.bpm));
    writeI16(static_cast<int16_t>(s.songIndex));
    writeU16(activeMidiTrackRows);
    writeFloat(static_cast<float>(s.globalPlayheadSeconds));
    writeFloat(static_cast<float>(s.driftFactor)); // drift-correction factor
    writeFloat(static_cast<float>(std::max(0.0, s.cpuPercent)));
    writeFloat(static_cast<float>(s.rssBytes) / (1024.0f * 1024.0f));
    writeFloat(static_cast<float>(s.systemTotalBytes) / (1024.0f * 1024.0f));
    writeU16(static_cast<uint16_t>(std::max(1u, static_cast<uint32_t>(s.cpuCoreCount))));
    writeU16(numTracks);
    writeU16(numMeters);
    writeU16(numLights);
    writeU16(numBusses);

    for (const auto& tr : s.tracks) {
        writeFloat(tr.peakDbL);
        writeFloat(tr.peakDbR);
    }

    for (const auto& m : s.meters) {
        writeFloat(m.peakDbL);
        writeFloat(m.peakDbR);
        // What a bar is driven by. The peaks above stay as the last
        // callback's: the clip latch and the dB readout want that one.
        writeFloat(m.intervalPeakDbL);
        writeFloat(m.intervalPeakDbR);
    }

    // Per-track mixer flags (v5). Bit 0 = mute, bit 1 = solo, bit 2 =
    // soloActiveInGroup (this track is silenced by someone else's solo), bit 3 = soloSafe.
    for (const auto& tr : s.tracks) {
        uint8_t flags = 0;
        if (tr.mute) flags |= 1;
        if (tr.solo) flags |= 2;
        if (tr.soloActiveInGroup) flags |= 4;
        if (tr.soloSafe) flags |= 8;
        writeU8(flags);
    }
    // Per-bus mixer flags (v5).
    for (const auto& b : s.busses) {
        uint8_t flags = 0;
        if (b.mute) flags |= 1;
        if (b.solo) flags |= 2;
        if (b.soloActiveInGroup) flags |= 4;
        if (b.soloSafe) flags |= 8;
        writeU8(flags);
    }

    // Version 9 rows: u16 track index, then two u64 masks for pitches 0–63
    // and 64–127. Empty snapshots have zero rows and explicitly clear state.
    for (uint16_t track = 0; track < kMaxActiveMidiTracks; ++track) {
        const auto& mask = activeMidiMasks[track];
        if (mask[0] == 0 && mask[1] == 0) continue;
        writeU16(track);
        writeU64(mask[0]);
        writeU64(mask[1]);
    }

    // Per-LED wire colors, backend-rendered (see resolveLedWireColors) --
    // the frontend draws these as-is and never re-simulates an effect.
    // Each row: fixtureIdx (u16), ledCount (u16), then ledCount RGB triples.
    for (uint16_t i = 0; i < numLights; ++i) {
        const auto& lo = s.lightOutput[i];
        writeU16(static_cast<uint16_t>(std::max(0, lo.fixtureIdx)));
        const uint16_t n = static_cast<uint16_t>(
            std::min<size_t>(lo.ledColors.size(), 512));
        writeU16(n);
        for (uint16_t j = 0; j < n; ++j) {
            writeU8(static_cast<uint8_t>(std::clamp(lo.ledColors[j].r, 0, 255)));
            writeU8(static_cast<uint8_t>(std::clamp(lo.ledColors[j].g, 0, 255)));
            writeU8(static_cast<uint8_t>(std::clamp(lo.ledColors[j].b, 0, 255)));
        }
    }

    return buf;
}
} // namespace
