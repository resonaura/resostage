/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

#include "PluginPresetStore.h"
#include "PluginPaths.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <fstream>
#include <random>
#include <system_error>
#include <string_view>

#if !defined(_WIN32)
#include <sys/stat.h>
#endif

namespace resostage {
namespace {

constexpr std::array<char, 8> kMagic{'R', 'S', 'P', 'R', 'S', 'T', '0', '1'};
constexpr uint32_t kFormatVersion = 1;
constexpr uint64_t kHeaderBytes = 32;
constexpr char kExtension[] = ".rspreset";

bool validUtf8(std::string_view text) noexcept {
    size_t index = 0;
    while (index < text.size()) {
        const auto first = static_cast<unsigned char>(text[index++]);
        if (first <= 0x7fu)
            continue;
        if (first >= 0xc2u && first <= 0xdfu) {
            if (index >= text.size()
                || (static_cast<unsigned char>(text[index++]) & 0xc0u) != 0x80u)
                return false;
            continue;
        }
        if (first >= 0xe0u && first <= 0xefu) {
            if (index + 1 >= text.size())
                return false;
            const auto second = static_cast<unsigned char>(text[index++]);
            const auto third = static_cast<unsigned char>(text[index++]);
            if ((third & 0xc0u) != 0x80u
                || (second & 0xc0u) != 0x80u
                || (first == 0xe0u && second < 0xa0u)
                || (first == 0xedu && second >= 0xa0u))
                return false;
            continue;
        }
        if (first >= 0xf0u && first <= 0xf4u) {
            if (index + 2 >= text.size())
                return false;
            const auto second = static_cast<unsigned char>(text[index++]);
            const auto third = static_cast<unsigned char>(text[index++]);
            const auto fourth = static_cast<unsigned char>(text[index++]);
            if ((second & 0xc0u) != 0x80u || (third & 0xc0u) != 0x80u
                || (fourth & 0xc0u) != 0x80u
                || (first == 0xf0u && second < 0x90u)
                || (first == 0xf4u && second > 0x8fu))
                return false;
            continue;
        }
        return false;
    }
    return true;
}

uint64_t stableHash(const std::string& value) noexcept {
    uint64_t hash = 1469598103934665603ull;
    for (const char character : value) {
        const auto byte = static_cast<unsigned char>(character);
        hash ^= byte;
        hash *= 1099511628211ull;
    }
    return hash;
}

uint32_t checksum(const uint8_t* bytes, size_t size) noexcept {
    uint32_t value = 0xffffffffu;
    for (size_t index = 0; index < size; ++index) {
        value ^= bytes[index];
        for (int bit = 0; bit < 8; ++bit)
            value = (value >> 1) ^ (0xedb88320u & (0u - (value & 1u)));
    }
    return ~value;
}

void writeU32(std::ostream& stream, uint32_t value) {
    std::array<char, 4> bytes{};
    for (int index = 0; index < 4; ++index)
        bytes[static_cast<size_t>(index)] = static_cast<char>(value >> (index * 8));
    stream.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

void writeU64(std::ostream& stream, uint64_t value) {
    std::array<char, 8> bytes{};
    for (int index = 0; index < 8; ++index)
        bytes[static_cast<size_t>(index)] = static_cast<char>(value >> (index * 8));
    stream.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

bool readU32(std::istream& stream, uint32_t& value) {
    std::array<uint8_t, 4> bytes{};
    stream.read(reinterpret_cast<char*>(bytes.data()),
                static_cast<std::streamsize>(bytes.size()));
    if (!stream)
        return false;
    value = 0;
    for (int index = 0; index < 4; ++index)
        value |= static_cast<uint32_t>(bytes[static_cast<size_t>(index)]) << (index * 8);
    return true;
}

bool readU64(std::istream& stream, uint64_t& value) {
    std::array<uint8_t, 8> bytes{};
    stream.read(reinterpret_cast<char*>(bytes.data()),
                static_cast<std::streamsize>(bytes.size()));
    if (!stream)
        return false;
    value = 0;
    for (int index = 0; index < 8; ++index)
        value |= static_cast<uint64_t>(bytes[static_cast<size_t>(index)]) << (index * 8);
    return true;
}

bool normalizeName(const std::string& input, std::string& output,
                   std::string& error) {
    size_t first = 0;
    size_t last = input.size();
    while (first < last && (input[first] == ' ' || input[first] == '\t')) ++first;
    while (last > first && (input[last - 1] == ' ' || input[last - 1] == '\t')) --last;
    if (first == last || last - first > PluginPresetStore::kMaximumPresetNameBytes) {
        error = "Preset name must contain 1–128 UTF-8 bytes";
        return false;
    }
    output.assign(input.data() + first, last - first);
    if (!validUtf8(output)) {
        error = "Preset name must be valid UTF-8";
        return false;
    }
    if (std::any_of(output.begin(), output.end(), [](unsigned char character) {
            return character < 0x20u || character == 0x7fu;
        })) {
        error = "Preset name cannot contain control characters";
        return false;
    }
    return true;
}

std::string makeId() {
    std::array<uint8_t, 16> bytes{};
    std::random_device random;
    for (auto& byte : bytes)
        byte = static_cast<uint8_t>(random());
    bytes[6] = static_cast<uint8_t>((bytes[6] & 0x0fu) | 0x40u);
    bytes[8] = static_cast<uint8_t>((bytes[8] & 0x3fu) | 0x80u);
    constexpr char hex[] = "0123456789abcdef";
    std::string id;
    id.reserve(32);
    for (const auto byte : bytes) {
        id.push_back(hex[byte >> 4]);
        id.push_back(hex[byte & 0x0fu]);
    }
    return id;
}

struct Header {
    std::string pluginIdentifier;
    std::string name;
    uint64_t stateBytes = 0;
    uint32_t stateChecksum = 0;
};

bool readHeader(const std::filesystem::path& path, Header& header,
                std::string& error) {
    std::error_code filesystemError;
    const uint64_t fileSize = std::filesystem::file_size(path, filesystemError);
    if (filesystemError || fileSize < kHeaderBytes) {
        error = "Preset file is missing or truncated";
        return false;
    }

    std::ifstream stream(path, std::ios::binary);
    std::array<char, kMagic.size()> magic{};
    uint32_t version = 0;
    uint32_t pluginBytes = 0;
    uint32_t nameBytes = 0;
    if (!stream || !stream.read(magic.data(), static_cast<std::streamsize>(magic.size()))
        || magic != kMagic || !readU32(stream, version)
        || !readU32(stream, pluginBytes) || !readU32(stream, nameBytes)
        || !readU64(stream, header.stateBytes)
        || !readU32(stream, header.stateChecksum)) {
        error = "Preset file has an invalid header";
        return false;
    }
    if (version != kFormatVersion || pluginBytes == 0
        || pluginBytes > PluginPresetStore::kMaximumPluginIdentifierBytes
        || nameBytes == 0 || nameBytes > PluginPresetStore::kMaximumPresetNameBytes
        || header.stateBytes == 0
        || header.stateBytes > PluginPresetStore::kMaximumStateBytes
        || fileSize != kHeaderBytes + pluginBytes + nameBytes + header.stateBytes) {
        error = "Preset file exceeds limits or uses an unsupported version";
        return false;
    }
    header.pluginIdentifier.resize(pluginBytes);
    header.name.resize(nameBytes);
    stream.read(header.pluginIdentifier.data(), static_cast<std::streamsize>(pluginBytes));
    stream.read(header.name.data(), static_cast<std::streamsize>(nameBytes));
    if (!stream || !validUtf8(header.pluginIdentifier) || !validUtf8(header.name)) {
        error = "Preset metadata is invalid or truncated";
        return false;
    }
    return true;
}

std::string safeSlotComponent(const std::string& slotId) {
    if (slotId.empty() || slotId.size() > 256)
        return {};
    std::string component = slotId;
    bool changed = false;
    for (char& character : component) {
        const auto value = static_cast<unsigned char>(character);
        if ((value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z')
            || (value >= '0' && value <= '9') || character == '-' || character == '_')
            continue;
        character = '_';
        changed = true;
    }
    if (component.empty())
        return {};
    if (component.size() > 80) {
        component.resize(80);
        changed = true;
    }
    if (changed) {
        constexpr char hex[] = "0123456789abcdef";
        const uint64_t hash = stableHash(slotId);
        component.push_back('_');
        for (int index = 15; index >= 0; --index)
            component.push_back(hex[(hash >> (index * 4)) & 0x0fu]);
    }
    return component;
}

std::filesystem::path presetPath(const std::filesystem::path& root,
                                 const std::string& pluginIdentifier,
                                 const std::string& presetId) {
    return PluginPresetStore::pluginDirectory(root, pluginIdentifier)
        / (presetId + kExtension);
}

} // namespace

bool PluginPresetStore::validPresetId(const std::string& presetId) noexcept {
    return presetId.size() == 32
        && std::all_of(presetId.begin(), presetId.end(), [](unsigned char value) {
            return (value >= '0' && value <= '9')
                || (value >= 'a' && value <= 'f');
        });
}

std::filesystem::path PluginPresetStore::userPresetRoot() {
    const auto path = pluginDataDirectory().getChildFile("Presets").getFullPathName();
#if JUCE_WINDOWS
    return std::filesystem::path(path.toWideCharPointer());
#else
    return std::filesystem::path(path.toStdString());
#endif
}

std::filesystem::path PluginPresetStore::pluginDirectory(
    const std::filesystem::path& root,
    const std::string& pluginIdentifier) {
    constexpr char hex[] = "0123456789abcdef";
    const uint64_t hash = stableHash(pluginIdentifier);
    std::string directory(16, '0');
    for (int index = 15; index >= 0; --index)
        directory[static_cast<size_t>(index)] = hex[(hash >> ((15 - index) * 4)) & 0x0fu];
    return root / directory;
}

std::string PluginPresetStore::projectResourceForSlot(
    const std::string& stripId, const std::string& slotId,
    const std::string& presetId) {
    const auto stripComponent = safeSlotComponent(stripId);
    const auto slotComponent = safeSlotComponent(slotId);
    if (stripComponent.empty() || slotComponent.empty() || !validPresetId(presetId))
        return {};
    return "PluginPresetState/" + stripComponent + "/" + slotComponent
        + "/" + presetId + ".state";
}

std::optional<std::string> PluginPresetStore::presetIdForProjectResource(
    const std::string& stripId, const std::string& slotId,
    const std::string& resource) {
    const auto marker = projectResourceForSlot(stripId, slotId, std::string(32, '0'));
    if (marker.empty())
        return std::nullopt;
    constexpr size_t suffixBytes = 32 + sizeof(".state") - 1;
    const std::string prefix = marker.substr(0, marker.size() - suffixBytes);
    if (resource.size() != prefix.size() + 32 + 6
        || resource.compare(0, prefix.size(), prefix) != 0
        || resource.compare(resource.size() - 6, 6, ".state") != 0)
        return std::nullopt;
    const std::string id = resource.substr(prefix.size(), 32);
    if (!validPresetId(id) || projectResourceForSlot(stripId, slotId, id) != resource)
        return std::nullopt;
    return id;
}

bool PluginPresetStore::list(const std::filesystem::path& root,
                             const std::string& pluginIdentifier,
                             std::vector<PluginPresetInfo>& presets,
                             std::string& error) {
    presets.clear();
    error.clear();
    if (pluginIdentifier.empty() || pluginIdentifier.size() > kMaximumPluginIdentifierBytes
        || !validUtf8(pluginIdentifier)) {
        error = "Invalid plug-in identifier";
        return false;
    }
    const auto directory = pluginDirectory(root, pluginIdentifier);
    std::error_code filesystemError;
    const auto directoryStatus = std::filesystem::symlink_status(directory, filesystemError);
    if (filesystemError == std::errc::no_such_file_or_directory)
        return true;
    if (filesystemError || !std::filesystem::exists(directoryStatus))
        return !filesystemError;
    if (std::filesystem::is_symlink(directoryStatus)
        || !std::filesystem::is_directory(directoryStatus)) {
        error = "Plug-in preset directory is unavailable";
        return false;
    }

    std::filesystem::directory_iterator iterator(directory, filesystemError);
    const std::filesystem::directory_iterator end;
    for (; !filesystemError && iterator != end
           && presets.size() < kMaximumListedPresets; iterator.increment(filesystemError)) {
        const auto& entry = *iterator;
        std::error_code entryError;
        const auto entryStatus = entry.symlink_status(entryError);
        if (entryError || std::filesystem::is_symlink(entryStatus)
            || !std::filesystem::is_regular_file(entryStatus)
            || entry.path().extension() != kExtension
            || !validPresetId(entry.path().stem().string()))
            continue;
        Header header;
        std::string ignored;
        if (!readHeader(entry.path(), header, ignored)
            || header.pluginIdentifier != pluginIdentifier)
            continue;
        presets.push_back({entry.path().stem().string(), std::move(header.name),
                           std::move(header.pluginIdentifier), header.stateBytes});
    }
    if (filesystemError) {
        error = "Could not enumerate plug-in presets";
        return false;
    }
    std::sort(presets.begin(), presets.end(), [](const auto& left, const auto& right) {
        if (left.name != right.name)
            return left.name < right.name;
        return left.id < right.id;
    });
    return true;
}

bool PluginPresetStore::save(const std::filesystem::path& root,
                             const std::string& pluginIdentifier,
                             const std::string& name,
                             const std::vector<uint8_t>& state,
                             PluginPresetInfo& saved,
                             std::string& error) {
    error.clear();
    saved = {};
    std::string normalizedName;
    if (pluginIdentifier.empty() || pluginIdentifier.size() > kMaximumPluginIdentifierBytes
        || !validUtf8(pluginIdentifier)) {
        error = "Invalid plug-in identifier";
        return false;
    }
    if (!normalizeName(name, normalizedName, error))
        return false;
    if (state.empty() || state.size() > kMaximumStateBytes) {
        error = "Plug-in state is empty or exceeds the 64 MiB preset limit";
        return false;
    }

    std::vector<PluginPresetInfo> existing;
    if (!list(root, pluginIdentifier, existing, error))
        return false;
    if (existing.size() >= kMaximumListedPresets) {
        error = "This plug-in already has the maximum of 256 saved presets";
        return false;
    }
    if (std::any_of(existing.begin(), existing.end(), [&normalizedName](const auto& preset) {
            return preset.name == normalizedName;
        })) {
        error = "A preset with this exact name already exists for the plug-in";
        return false;
    }

    const auto directory = pluginDirectory(root, pluginIdentifier);
    std::error_code filesystemError;
    std::filesystem::create_directories(directory, filesystemError);
    if (filesystemError) {
        error = "Could not create plug-in preset directory";
        return false;
    }
    const auto directoryStatus = std::filesystem::symlink_status(directory, filesystemError);
    if (filesystemError || std::filesystem::is_symlink(directoryStatus)
        || !std::filesystem::is_directory(directoryStatus)) {
        error = "Plug-in preset directory is not a private regular directory";
        return false;
    }
#if !defined(_WIN32)
    (void)::chmod(directory.c_str(), 0700);
#endif

    std::string id;
    std::filesystem::path finalPath;
    std::filesystem::path temporaryPath;
    for (int attempt = 0; attempt < 4; ++attempt) {
        try {
            id = makeId();
        } catch (...) {
            error = "Could not create a unique preset identifier";
            return false;
        }
        finalPath = presetPath(root, pluginIdentifier, id);
        temporaryPath = finalPath;
        temporaryPath += ".tmp";
        if (!std::filesystem::exists(finalPath, filesystemError)
            && !std::filesystem::exists(temporaryPath, filesystemError)
            && !filesystemError)
            break;
        id.clear();
    }
    if (id.empty()) {
        error = "Could not reserve a unique plug-in preset file";
        return false;
    }

    std::ofstream stream(temporaryPath, std::ios::binary | std::ios::out | std::ios::trunc);
    if (!stream) {
        error = "Could not create plug-in preset file";
        return false;
    }
#if !defined(_WIN32)
    (void)::chmod(temporaryPath.c_str(), 0600);
#endif
    stream.write(kMagic.data(), static_cast<std::streamsize>(kMagic.size()));
    writeU32(stream, kFormatVersion);
    writeU32(stream, static_cast<uint32_t>(pluginIdentifier.size()));
    writeU32(stream, static_cast<uint32_t>(normalizedName.size()));
    writeU64(stream, static_cast<uint64_t>(state.size()));
    writeU32(stream, checksum(state.data(), state.size()));
    stream.write(pluginIdentifier.data(), static_cast<std::streamsize>(pluginIdentifier.size()));
    stream.write(normalizedName.data(), static_cast<std::streamsize>(normalizedName.size()));
    stream.write(reinterpret_cast<const char*>(state.data()),
                 static_cast<std::streamsize>(state.size()));
    stream.flush();
    const bool written = static_cast<bool>(stream);
    stream.close();
    if (!written) {
        std::filesystem::remove(temporaryPath, filesystemError);
        error = "Could not write complete plug-in preset";
        return false;
    }

    std::filesystem::rename(temporaryPath, finalPath, filesystemError);
    if (filesystemError) {
        std::error_code cleanupError;
        std::filesystem::remove(temporaryPath, cleanupError);
        error = "Could not atomically publish plug-in preset";
        return false;
    }
    saved = {std::move(id), std::move(normalizedName), pluginIdentifier,
             static_cast<uint64_t>(state.size())};
    return true;
}

bool PluginPresetStore::load(const std::filesystem::path& root,
                             const std::string& pluginIdentifier,
                             const std::string& presetId,
                             PluginPresetData& preset,
                             std::string& error) {
    preset = {};
    error.clear();
    if (pluginIdentifier.empty() || pluginIdentifier.size() > kMaximumPluginIdentifierBytes
        || !validUtf8(pluginIdentifier)
        || !validPresetId(presetId)) {
        error = "Invalid plug-in or preset identifier";
        return false;
    }
    const auto path = presetPath(root, pluginIdentifier, presetId);
    std::error_code filesystemError;
    const auto fileStatus = std::filesystem::symlink_status(path, filesystemError);
    if (filesystemError || std::filesystem::is_symlink(fileStatus)
        || !std::filesystem::is_regular_file(fileStatus)) {
        error = "Plug-in preset file is unavailable";
        return false;
    }
    Header header;
    if (!readHeader(path, header, error))
        return false;
    if (header.pluginIdentifier != pluginIdentifier) {
        error = "Preset belongs to a different plug-in";
        return false;
    }

    std::ifstream stream(path, std::ios::binary);
    if (!stream) {
        error = "Could not open plug-in preset";
        return false;
    }
    stream.seekg(static_cast<std::streamoff>(kHeaderBytes
        + header.pluginIdentifier.size() + header.name.size()), std::ios::beg);
    std::vector<uint8_t> state(static_cast<size_t>(header.stateBytes));
    stream.read(reinterpret_cast<char*>(state.data()),
                static_cast<std::streamsize>(state.size()));
    if (!stream || checksum(state.data(), state.size()) != header.stateChecksum) {
        error = "Plug-in preset state is truncated or corrupted";
        return false;
    }
    preset.info = {presetId, std::move(header.name),
                   std::move(header.pluginIdentifier), header.stateBytes};
    preset.state = std::move(state);
    return true;
}

} // namespace resostage
