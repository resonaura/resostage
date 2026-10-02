/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#pragma once

#include <cerrno>
#include <cstdio>
#include <filesystem>
#include <string>
#include <system_error>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#elif defined(__linux__)
#include <fcntl.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif

namespace resostage::offline_detail {

// HTTP and JUCE paths are UTF-8; native Windows filesystem APIs need UTF-16.
inline std::filesystem::path outputFilePath(const std::string& path) {
    return std::filesystem::path(std::u8string(path.begin(), path.end()));
}

inline FILE* openOutputFile(const std::string& path, const char* mode) {
#if defined(_WIN32)
    const std::wstring nativeMode(mode, mode + std::char_traits<char>::length(mode));
    return _wfopen(outputFilePath(path).c_str(), nativeMode.c_str());
#else
    return std::fopen(path.c_str(), mode);
#endif
}

// Offline-worker only. Publish a completed sibling temporary file atomically
// and exclusively: a file created during rendering must never be replaced.
inline bool publishOutputFile(const std::string& partial, const std::string& destination,
                              std::error_code& error) {
#if defined(__APPLE__)
    if (renamex_np(partial.c_str(), destination.c_str(), RENAME_EXCL) == 0) {
        error.clear();
        return true;
    }
    error = std::error_code(errno, std::generic_category());
#elif defined(_WIN32)
    if (MoveFileExW(outputFilePath(partial).c_str(), outputFilePath(destination).c_str(),
                    MOVEFILE_WRITE_THROUGH) != 0) {
        error.clear();
        return true;
    }
    error = std::error_code(static_cast<int>(GetLastError()), std::system_category());
#elif defined(__linux__) && defined(SYS_renameat2)
    constexpr unsigned kRenameNoReplace = 1;
    if (syscall(SYS_renameat2, AT_FDCWD, partial.c_str(), AT_FDCWD,
                destination.c_str(), kRenameNoReplace) == 0) {
        error.clear();
        return true;
    }
    error = std::error_code(errno, std::generic_category());
#else
    std::filesystem::create_hard_link(outputFilePath(partial), outputFilePath(destination), error);
    if (!error) {
        std::error_code ignored;
        std::filesystem::remove(outputFilePath(partial), ignored);
        return true;
    }
#endif
    return false;
}

} // namespace resostage::offline_detail
