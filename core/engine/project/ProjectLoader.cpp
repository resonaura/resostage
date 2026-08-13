#include "ProjectLoader.h"
#include "ProjectJson.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#if defined(__APPLE__)
#include <fcntl.h>
#include <unistd.h>
#endif
#include <fstream>
#include <iomanip>
#include <map>
#include <sstream>
#include <string_view>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <io.h>
#endif

namespace resostage {

namespace {

// Opens a FILE* with platform sequential-read hints.
//  - macOS: fileno(f) + fcntl(F_NOCACHE, F_RDAHEAD) -- bypass the unified
//    buffer cache so multi-GB stems don't evict other pages, and request
//    kernel read-ahead.
//  - Windows: CreateFileW with FILE_FLAG_SEQUENTIAL_SCAN, then _open_osfhandle
//    + _fdopen so the rest of the cursor can keep using fread/ftell/fseek. The
//    OS gets the sequential hint and pre-fetches ahead; we do NOT set
//    FILE_FLAG_OVERLAPPED -- buffered CRT I/O (fread/fseek) is incompatible
//    with overlapped handles.
//  - else: plain fopen.
FILE* openSequentialStream(const std::string& path8) {
#if defined(_WIN32)
    const std::wstring wide(path8.begin(), path8.end());
    HANDLE h = CreateFileW(wide.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                           OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (h == INVALID_HANDLE_VALUE)
        return nullptr;
    const intptr_t fd = _open_osfhandle(reinterpret_cast<intptr_t>(h), _O_RDONLY | _O_BINARY | _O_SEQUENTIAL);
    if (fd == -1) {
        CloseHandle(h);
        return nullptr;
    }
    return _fdopen(static_cast<int>(fd), "rb");
#else
    return std::fopen(path8.c_str(), "rb");
#endif
}

} // namespace

struct ProjectLoader::Impl {
    bool isContainerDir = false;
};

ProjectLoader::ProjectLoader() : impl(std::make_unique<Impl>()) {}
ProjectLoader::~ProjectLoader() = default;

void ProjectLoader::close() {
    impl->isContainerDir = false;
    parsedProject = Project{};
    openArchivePath.clear();
}

bool ProjectLoader::isDirectoryContainer() const {
    return impl != nullptr && impl->isContainerDir;
}

void ProjectLoader::newProject(const std::string& name) {
    close();
    parsedProject = Project{};
    parsedProject.name = name;
    parsedProject.main.output.type = OutputType::ExtOut;
    parsedProject.main.output.target = "audio::out:1,audio::out:2";

    const std::vector<std::string> defaultTrackNames = {
        "Drums", "Percussion", "Loops", "Bass", "Guitars", "Synths", "Keys", "Vocals", "Backing Vocals", "SFX", "Guide"
    };
    int idCounter = 1;
    for (const auto& tname : defaultTrackNames) {
        TrackDef t;
        t.id = "audio::track:" + std::to_string(idCounter++);
        t.name = tname;
        t.output.type = OutputType::Main;
        parsedProject.tracks.push_back(std::move(t));
    }
}

bool ProjectLoader::isOpen() const {
    return impl != nullptr && impl->isContainerDir;
}

bool ProjectLoader::saveAs(const std::string& path, std::string& error) const {
    return saveAsWithExtras(path, {}, error);
}

bool ProjectLoader::saveAsWithExtras(const std::string& path,
                                     const std::vector<ExtraFile>& extraFiles,
                                     std::string& error,
                                     const Project* projectOverride) const {
    namespace fs = std::filesystem;
    const fs::path dest(path);
    std::error_code ec;

    fs::create_directories(dest / "Audio", ec);
    fs::create_directories(dest / "Peaks", ec);
    fs::create_directories(dest / "Autosave", ec);
    fs::create_directories(dest / "Backups", ec);

    if (impl->isContainerDir && !openArchivePath.empty() && openArchivePath != path) {
        fs::path srcPath(openArchivePath);
        if (fs::exists(srcPath, ec)) {
            for (const auto& entry : fs::recursive_directory_iterator(srcPath, ec)) {
                if (entry.is_regular_file(ec)) {
                    fs::path rel = fs::relative(entry.path(), srcPath, ec);
                    if (rel == "project.json" || rel.string().rfind("Autosave/", 0) == 0)
                        continue;
                    fs::path targetFile = dest / rel;
                    fs::create_directories(targetFile.parent_path(), ec);
                    fs::copy_file(entry.path(), targetFile, fs::copy_options::overwrite_existing, ec);
                }
            }
        }
    }

    for (const auto& ex : extraFiles) {
        if (ex.archivePath.empty() || ex.archivePath == "project.json")
            continue;
        fs::path extraDest = dest / ex.archivePath;
        fs::create_directories(extraDest.parent_path(), ec);
        std::ofstream ofs(extraDest, std::ios::binary | std::ios::trunc);
        if (!ofs.is_open()) {
            error = "Failed to open for write: " + extraDest.string();
            return false;
        }
        if (!ex.data.empty()) {
            ofs.write(reinterpret_cast<const char*>(ex.data.data()),
                      static_cast<std::streamsize>(ex.data.size()));
        }
        ofs.flush();
        if (!ofs) {
            error = "Failed to write " + extraDest.string()
                    + " (" + std::to_string(ex.data.size()) + " bytes)";
            ofs.close();
            fs::remove(extraDest, ec);
            return false;
        }
        ofs.close();
        const auto written = fs::file_size(extraDest, ec);
        if (ec || written != ex.data.size()) {
            error = "Size mismatch writing " + extraDest.string()
                    + " (expected " + std::to_string(ex.data.size())
                    + ", got " + std::to_string(static_cast<uint64_t>(written)) + ")";
            fs::remove(extraDest, ec);
            return false;
        }
    }

    const std::string json = serializeProjectJson(projectOverride != nullptr ? *projectOverride : parsedProject);
    fs::path jsonPath = dest / "project.json";
    std::ofstream jsonFile(jsonPath, std::ios::binary);
    if (!jsonFile.is_open()) {
        error = "Failed to write project.json into " + jsonPath.string();
        return false;
    }
    jsonFile.write(json.data(), json.size());
    jsonFile.close();

    return true;
}

bool ProjectLoader::extractFile(const std::string& archivePath, std::vector<uint8_t>& outData, std::string& error) const {
    if (!isOpen()) {
        error = "Container not open";
        return false;
    }

    namespace fs = std::filesystem;
    fs::path filePath = fs::path(openArchivePath) / archivePath;
    std::ifstream ifs(filePath, std::ios::binary | std::ios::ate);
    if (!ifs.is_open()) {
        error = "Failed to open file in container: " + filePath.string();
        return false;
    }
    std::streamsize size = ifs.tellg();
    ifs.seekg(0, std::ios::beg);
    outData.resize(static_cast<size_t>(size));
    if (size > 0 && ifs.read(reinterpret_cast<char*>(outData.data()), size)) {
        return true;
    }
    error = "Failed to read file in container: " + filePath.string();
    return false;
}

struct ProjectLoader::StreamCursor::Impl {
    FILE* containerFile = nullptr;

    ~Impl() {
        if (containerFile != nullptr)
            std::fclose(containerFile);
    }
};

ProjectLoader::StreamCursor::StreamCursor() = default;
ProjectLoader::StreamCursor::~StreamCursor() = default;
ProjectLoader::StreamCursor::StreamCursor(StreamCursor&&) noexcept = default;
ProjectLoader::StreamCursor& ProjectLoader::StreamCursor::operator=(StreamCursor&&) noexcept = default;

bool ProjectLoader::StreamCursor::isValid() const {
    return impl != nullptr && impl->containerFile != nullptr;
}

size_t ProjectLoader::StreamCursor::read(void* buf, size_t bufSize) {
    if (!isValid())
        return 0;
    return std::fread(buf, 1, bufSize, impl->containerFile);
}

size_t ProjectLoader::StreamCursor::skip(size_t bytesToSkip) {
    if (!isValid())
        return 0;
    long current = std::ftell(impl->containerFile);
    std::fseek(impl->containerFile, static_cast<long>(bytesToSkip), SEEK_CUR);
    long after = std::ftell(impl->containerFile);
    return static_cast<size_t>(after - current);
}

int64_t ProjectLoader::StreamCursor::tell() const {
    if (!isValid() || impl->containerFile == nullptr)
        return -1;
    const long pos = std::ftell(impl->containerFile);
    return pos < 0 ? -1 : static_cast<int64_t>(pos);
}

bool ProjectLoader::StreamCursor::seekAbsolute(int64_t offset) {
    if (!isValid() || impl->containerFile == nullptr || offset < 0)
        return false;
    return std::fseek(impl->containerFile, static_cast<long>(offset), SEEK_SET) == 0;
}

ProjectLoader::StreamCursor ProjectLoader::openStream(const std::string& archivePath, std::string& error) const {
    StreamCursor cursor;

    if (!isOpen()) {
        error = "Container not open";
        return cursor;
    }

    namespace fs = std::filesystem;
    fs::path filePath = fs::path(openArchivePath) / archivePath;
    FILE* f = openSequentialStream(filePath.string());
    if (f == nullptr) {
        error = "File not found in container: " + filePath.string();
        return cursor;
    }
#if defined(__APPLE__) && !defined(_WIN32)
    // Keep stems out of the unified buffer cache, and ask for read-ahead.
    //
    // A set is gigabytes of audio that is read once, forward, and never
    // wanted again -- caching it evicts everything else and pushes the VM
    // system into compressing and paging, which is felt as a stall in the
    // render callback rather than as a slow read. F_RDAHEAD is the other half:
    // this access pattern is purely sequential, which is exactly what the
    // hint is for.
    //
    // Best-effort: both are advisory, and a failure here only costs speed.
    if (const int fd = fileno(f); fd >= 0) {
        (void)fcntl(fd, F_NOCACHE, 1);
        (void)fcntl(fd, F_RDAHEAD, 1);
    }
#endif
    auto cursorImpl = std::make_unique<StreamCursor::Impl>();
    cursorImpl->containerFile = f;
    cursor.impl = std::move(cursorImpl);
    return cursor;
}

bool ProjectLoader::reopenArchiveKeepProject(const std::string& path, std::string& error) {
    namespace fs = std::filesystem;
    if (!fs::is_directory(path)) {
        error = "Failed to open project container: " + path;
        return false;
    }
    impl->isContainerDir = true;
    openArchivePath = path;
    return true;
}

bool ProjectLoader::open(const std::string& path, std::string& error) {
    close();

    namespace fs = std::filesystem;
    if (!fs::is_directory(path)) {
        error = "Failed to open project container: " + path;
        return false;
    }

    impl->isContainerDir = true;
    openArchivePath = path;
    return reparseProject(error);
}

bool ProjectLoader::saveAutosave(std::string& error) const {
    if (openArchivePath.empty() || !impl->isContainerDir)
        return false;
    namespace fs = std::filesystem;
    fs::path autoDir = fs::path(openArchivePath) / "Autosave";
    std::error_code ec;
    fs::create_directories(autoDir, ec);

    std::string json = serializeProjectJson(parsedProject);
    fs::path autoJson = autoDir / "project.json";
    std::ofstream ofs(autoJson, std::ios::binary);
    if (!ofs.is_open()) {
        error = "Failed to write autosave project.json";
        return false;
    }
    ofs.write(json.data(), json.size());
    ofs.close();

    const auto now = std::chrono::system_clock::now();
    const auto in_time_t = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << std::put_time(std::localtime(&in_time_t), "%Y-%m-%d %H:%M:%S");
    std::ofstream infoFile(autoDir / "info.txt");
    if (infoFile.is_open()) {
        infoFile << ss.str();
    }

    return true;
}

bool ProjectLoader::hasAutosave(std::string& outTimestamp) const {
    if (openArchivePath.empty())
        return false;
    namespace fs = std::filesystem;
    fs::path autoJson = fs::path(openArchivePath) / "Autosave" / "project.json";
    std::error_code ec;
    if (!fs::exists(autoJson, ec))
        return false;

    fs::path mainJson = fs::path(openArchivePath) / "project.json";
    if (fs::exists(mainJson, ec)) {
        auto autoTime = fs::last_write_time(autoJson, ec);
        auto mainTime = fs::last_write_time(mainJson, ec);
        if (autoTime <= mainTime)
            return false;
    }

    fs::path infoFile = fs::path(openArchivePath) / "Autosave" / "info.txt";
    if (fs::exists(infoFile, ec)) {
        std::ifstream ifs(infoFile);
        if (ifs.is_open()) {
            std::getline(ifs, outTimestamp);
        }
    }
    if (outTimestamp.empty())
        outTimestamp = "Recent Auto-Save";
    return true;
}

bool ProjectLoader::loadAutosave(std::string& error) {
    if (openArchivePath.empty()) {
        error = "No open project to load autosave from";
        return false;
    }
    namespace fs = std::filesystem;
    fs::path autoJson = fs::path(openArchivePath) / "Autosave" / "project.json";
    std::ifstream ifs(autoJson, std::ios::binary | std::ios::ate);
    if (!ifs.is_open()) {
        error = "Autosave project.json not found";
        return false;
    }
    const std::streamsize size = ifs.tellg();
    ifs.seekg(0, std::ios::beg);
    std::string json(static_cast<size_t>(size), '\0');
    ifs.read(json.data(), size);
    ifs.close();

    Project proj;
    if (!parseProjectJson(json, proj, error))
        return false;
    parsedProject = std::move(proj);
    return true;
}

void ProjectLoader::clearAutosave() {
    if (openArchivePath.empty())
        return;
    namespace fs = std::filesystem;
    std::error_code ec;
    fs::remove_all(fs::path(openArchivePath) / "Autosave", ec);
}

bool ProjectLoader::saveBackup(std::string& error) const {
    if (openArchivePath.empty()) {
        error = "No open project archive path";
        return false;
    }
    namespace fs = std::filesystem;
    fs::path backupDir = fs::path(openArchivePath) / "Backups";
    std::error_code ec;
    fs::create_directories(backupDir, ec);
    if (ec) {
        error = "Failed to create Backups directory: " + ec.message();
        return false;
    }

    const auto now = std::chrono::system_clock::now();
    const auto in_time_t = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << "project_" << std::put_time(std::localtime(&in_time_t), "%Y%m%d_%H%M%S") << ".json";

    fs::path mainJson = fs::path(openArchivePath) / "project.json";
    if (fs::exists(mainJson, ec)) {
        fs::copy_file(mainJson, backupDir / ss.str(), fs::copy_options::overwrite_existing, ec);
        if (ec) {
            error = "Failed to copy project.json to backup: " + ec.message();
            return false;
        }
    } else {
        std::string json = serializeProjectJson(parsedProject);
        std::ofstream ofs(backupDir / ss.str(), std::ios::binary);
        if (ofs.is_open()) {
            ofs.write(json.data(), json.size());
        } else {
            error = "Failed to write backup project.json";
            return false;
        }
    }
    return true;
}

bool ProjectLoader::reparseProject(std::string& error) {
    std::vector<uint8_t> jsonBytes;
    if (!extractFile("project.json", jsonBytes, error))
        return false;

    const std::string_view json(
        reinterpret_cast<const char*>(jsonBytes.data()), jsonBytes.size());

    Project proj;
    if (peekProjectFormatVersion(json) < kCurrentFormatVersion) {
        error = "Outdated project format version. Please run 'pnpm migrate <path>' to convert it to the current schema.";
        return false;
    }
    if (!parseProjectJson(json, proj, error))
        return false;

    if (proj.tracks.empty()) {
        const std::vector<std::string> defaultTrackNames = {
            "Drums", "Percussion", "Loops", "Bass", "Guitars", "Synths", "Keys",
            "Vocals", "Backing Vocals", "SFX", "Guide"
        };
        int idCounter = 1;
        for (const auto& tname : defaultTrackNames) {
            TrackDef t;
            t.id = "audio::track:" + std::to_string(idCounter++);
            t.name = tname;
            t.output.type = OutputType::Main;
            proj.tracks.push_back(std::move(t));
        }
    }

    parsedProject = std::move(proj);
    return true;
}

} // namespace resostage
