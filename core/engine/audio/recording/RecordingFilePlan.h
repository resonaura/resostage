/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include "project/Uuid.h"

#include <algorithm>
#include <string>
#include <string_view>

namespace resostage {

struct RecordingFilePlan {
    std::string recordingId;
    std::string filename;
};

/**
 * Message-thread take naming. A per-session UUID keeps case-folded, normalized
 * Unicode and sanitized track names distinct, including retakes in one second.
 * File creation must still be exclusive: a name is not a filesystem reservation.
 */
inline RecordingFilePlan makeRecordingFilePlan(std::string_view timestamp,
                                               std::string_view trackName,
                                               std::string_view trackId) {
    const std::string_view label = trackName.empty() ? trackId : trackName;
    constexpr size_t kMaxLabelBytes = 80;
    size_t length = std::min(label.size(), kMaxLabelBytes);
    // UTF-8 continuation bytes belong to the preceding code point. Leave that
    // entire point out when the byte limit falls inside it.
    if (length < label.size()) {
        while (length > 0 && (static_cast<unsigned char>(label[length]) & 0xc0u) == 0x80u)
            --length;
    }
    std::string safeLabel(label.substr(0, length));
    for (char& byte : safeLabel) {
        const auto value = static_cast<unsigned char>(byte);
        if (value < 32 || value == 127 || std::string_view("<>:\"/\\|?*").find(byte) != std::string_view::npos)
            byte = '_';
    }
    if (safeLabel.empty()) safeLabel = "Audio";

    const std::string sessionId = generateUuidV7();
    return {"rec_" + sessionId,
            "Take_" + std::string(timestamp) + "_" + safeLabel + "_" + sessionId + ".wav"};
}

} // namespace resostage
