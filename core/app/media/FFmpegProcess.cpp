/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "FFmpegProcess.h"

#include <juce_core/juce_core.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <thread>

namespace resostage::media {
namespace {

juce::File bundledFFmpeg() {
    const auto app = juce::File::getSpecialLocation(juce::File::currentApplicationFile);
#if JUCE_MAC
    if (app.isDirectory())
        return app.getChildFile("Contents/Helpers/ResoStage Media.app/Contents/MacOS/ResoStage Media");
    return app.getParentDirectory().getParentDirectory()
        .getChildFile("Helpers/ResoStage Media.app/Contents/MacOS/ResoStage Media");
#elif JUCE_WINDOWS
    return app.getSiblingFile("media.exe");
#else
    return app.getSiblingFile("resostage-media");
#endif
}

void appendBounded(std::string& destination, const char* bytes, size_t count) {
    constexpr size_t kMaximumDiagnosticBytes = 8192;
    if (destination.size() >= kMaximumDiagnosticBytes)
        return;
    const size_t keep = std::min(count, kMaximumDiagnosticBytes - destination.size());
    destination.append(bytes, keep);
}

} // namespace

bool runFFmpeg(const std::vector<std::string>& arguments,
               std::string& error,
               const std::atomic<bool>* cancel) {
    error.clear();
    if (cancel != nullptr && cancel->load(std::memory_order_acquire)) {
        error = "Media conversion cancelled";
        return false;
    }
    const juce::File executable = bundledFFmpeg();
    if (!executable.existsAsFile()) {
        error = "The bundled FFmpeg runtime is missing from this ResoStage installation";
        return false;
    }

    juce::StringArray command;
    command.add(executable.getFullPathName());
    for (const auto& argument : arguments)
        command.add(juce::String::fromUTF8(argument.c_str()));

    juce::ChildProcess process;
    if (!process.start(command, juce::ChildProcess::wantStdErr)) {
        error = "Could not start the bundled FFmpeg runtime";
        return false;
    }

    std::array<char, 2048> readBuffer{};
    std::string diagnostics;
    // JUCE's POSIX pipe read is blocking. Drain it on this job's temporary
    // reader so cancellation/deadline checks never depend on codec output.
    std::thread diagnosticReader([&process, &readBuffer, &diagnostics]() {
        for (;;) {
            const int read = process.readProcessOutput(readBuffer.data(),
                static_cast<int>(readBuffer.size()));
            if (read <= 0)
                break;
            appendBounded(diagnostics, readBuffer.data(), static_cast<size_t>(read));
        }
    });
    // A malformed input must not leave shutdown waiting forever. Six hours
    // allows long shows on slow machines while bounding a stuck codec job.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::hours(6);
    while (process.isRunning()) {
        const bool cancelled = cancel != nullptr && cancel->load(std::memory_order_acquire);
        if (cancelled || std::chrono::steady_clock::now() >= deadline) {
            process.kill();
            (void) process.waitForProcessToFinish(5000);
            diagnosticReader.join();
            error = cancelled ? "Media conversion cancelled" : "Media conversion exceeded its six-hour deadline";
            return false;
        }
        (void) process.waitForProcessToFinish(40);
    }

    diagnosticReader.join();

    if (process.getExitCode() != 0) {
        while (!diagnostics.empty()
               && (diagnostics.back() == '\n' || diagnostics.back() == '\r'))
            diagnostics.pop_back();
        error = diagnostics.empty()
            ? "FFmpeg failed with exit code " + std::to_string(process.getExitCode())
            : "FFmpeg: " + diagnostics;
        return false;
    }
    return true;
}

} // namespace resostage::media
