#include "ProjectLoader.h"
#include "ProjectJson.h"

#include "miniz.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <string_view>

namespace resostage {

struct ProjectLoader::Impl {
    mz_zip_archive zip{};
    bool zipOpen = false;
    bool isContainerDir = false;

    ~Impl() {
        if (zipOpen)
            mz_zip_reader_end(&zip);
    }
};

ProjectLoader::ProjectLoader() : impl(std::make_unique<Impl>()) {}
ProjectLoader::~ProjectLoader() = default;

void ProjectLoader::close() {
    if (impl->zipOpen) {
        mz_zip_reader_end(&impl->zip);
        impl->zipOpen = false;
    }
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
    // One default stereo FOH bus so the Builder/Mixer aren't staring at an
    // empty routing matrix -- the user can rename/reassign/add more freely.
    BusDef mainBus;
    mainBus.id = "main";
    mainBus.name = "Main";
    mainBus.channels = 2;
    mainBus.output.startChannel = 0;
    parsedProject.busses.push_back(std::move(mainBus));

    // Seed global project-level tracks (NO songs created, songs array remains empty)

    const std::vector<std::string> defaultTrackNames = {
        "Drums", "Percussion", "Loops", "Bass", "Guitars", "Synths", "Keys", "Vocals", "Backing Vocals", "SFX", "Guide"
    };
    int idCounter = 1;
    for (const auto& tname : defaultTrackNames) {
        TrackDef t;
        t.id = "trk_" + std::to_string(idCounter++);
        t.name = tname;
        t.busId = "main";
        parsedProject.tracks.push_back(std::move(t));
    }
}

bool ProjectLoader::isOpen() const {

    return impl != nullptr && (impl->isContainerDir || impl->zipOpen);
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

    // Package Container Bundle Directory Format (.rsnraset/)
    fs::create_directories(dest / "Audio", ec);
    fs::create_directories(dest / "Peaks", ec);
    fs::create_directories(dest / "Autosave", ec);
    fs::create_directories(dest / "Backups", ec);

    // If copying from an existing container directory, copy existing audio and peak files
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
    } else if (impl->zipOpen) {
        // Unpack legacy ZIP entries directly into destination package container
        const mz_uint numFiles = mz_zip_reader_get_num_files(const_cast<mz_zip_archive*>(&impl->zip));
        for (mz_uint i = 0; i < numFiles; ++i) {
            mz_zip_archive_file_stat st;
            if (!mz_zip_reader_file_stat(const_cast<mz_zip_archive*>(&impl->zip), i, &st))
                continue;
            if (st.m_is_directory || std::strcmp(st.m_filename, "project.json") == 0)
                continue;
            fs::path targetFile = dest / st.m_filename;
            fs::create_directories(targetFile.parent_path(), ec);
            mz_zip_reader_extract_to_file(const_cast<mz_zip_archive*>(&impl->zip), i, targetFile.string().c_str(), 0);
        }
    }

    // Write extra files (e.g. newly imported WAVs or generated peak .rpk files).
    // Fail hard on a short/failed write: a 0-byte "Audio/foo.wav" later surfaces
    // as "Truncated RIFF header" on selectSong and leaves the project looking
    // like "No song selected" with no useful recovery path.
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
        // Defence-in-depth against silent disk-full truncation.
        const auto written = fs::file_size(extraDest, ec);
        if (ec || written != ex.data.size()) {
            error = "Size mismatch writing " + extraDest.string()
                    + " (expected " + std::to_string(ex.data.size())
                    + ", got " + std::to_string(static_cast<uint64_t>(written)) + ")";
            fs::remove(extraDest, ec);
            return false;
        }
    }

    // Write project.json
    const std::string json = serializeProjectJson(projectOverride != nullptr ? *projectOverride : parsedProject);
    fs::path jsonPath = dest / "project.json";
    std::ofstream jsonFile(jsonPath, std::ios::binary);
    if (!jsonFile.is_open()) {
        error = "Failed to write project.json into " + jsonPath.string();
        return false;
    }
    jsonFile.write(json.data(), json.size());
    jsonFile.close();

    // Deliberately do NOT mutate openArchivePath / isContainerDir here.
    // Async save writes to a temp package while streaming still holds live
    // FILE* cursors into the open project; rewriting openArchivePath to the
    // temp path used to redirect any new openStream() at a half-written tree
    // and race the IO thread. Callers that want the destination as the live
    // archive must close()+open() (or reopenArchiveKeepProject) themselves.
    return true;
}

bool ProjectLoader::extractFile(const std::string& archivePath, std::vector<uint8_t>& outData, std::string& error) const {
    if (!isOpen()) {
        error = "Archive or container not open";
        return false;
    }

    if (impl->isContainerDir) {
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
    } else if (impl->zipOpen) {
        size_t size = 0;
        void* data = mz_zip_reader_extract_file_to_heap(&impl->zip, archivePath.c_str(), &size, 0);
        if (data == nullptr) {
            error = "Failed to extract '" + archivePath + "' from archive";
            return false;
        }
        outData.assign(static_cast<uint8_t*>(data), static_cast<uint8_t*>(data) + size);
        mz_free(data);
        return true;
    }

    error = "No open project container";
    return false;
}

struct ProjectLoader::StreamCursor::Impl {
    mz_zip_reader_extract_iter_state* zipState = nullptr;
    FILE* containerFile = nullptr;

    ~Impl() {
        if (zipState != nullptr)
            mz_zip_reader_extract_iter_free(zipState);
        if (containerFile != nullptr)
            std::fclose(containerFile);
    }
};

ProjectLoader::StreamCursor::StreamCursor() = default;
ProjectLoader::StreamCursor::~StreamCursor() = default;
ProjectLoader::StreamCursor::StreamCursor(StreamCursor&&) noexcept = default;
ProjectLoader::StreamCursor& ProjectLoader::StreamCursor::operator=(StreamCursor&&) noexcept = default;

bool ProjectLoader::StreamCursor::isValid() const {
    return impl != nullptr && (impl->containerFile != nullptr || impl->zipState != nullptr);
}

size_t ProjectLoader::StreamCursor::read(void* buf, size_t bufSize) {
    if (!isValid())
        return 0;
    if (impl->containerFile != nullptr) {
        return std::fread(buf, 1, bufSize, impl->containerFile);
    }
    if (impl->zipState != nullptr) {
        return mz_zip_reader_extract_iter_read(impl->zipState, buf, bufSize);
    }
    return 0;
}

size_t ProjectLoader::StreamCursor::skip(size_t bytesToSkip) {
    if (!isValid())
        return 0;
    if (impl->containerFile != nullptr) {
        long current = std::ftell(impl->containerFile);
        std::fseek(impl->containerFile, static_cast<long>(bytesToSkip), SEEK_CUR);
        long after = std::ftell(impl->containerFile);
        return static_cast<size_t>(after - current);
    }
    if (impl->zipState != nullptr) {
        uint8_t discard[4096];
        size_t remaining = bytesToSkip;
        while (remaining > 0) {
            const size_t chunk = std::min(remaining, sizeof(discard));
            const size_t got = read(discard, chunk);
            if (got == 0)
                break;
            remaining -= got;
        }
        return bytesToSkip - remaining;
    }
    return 0;
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
        error = "Archive or container not open";
        return cursor;
    }

    if (impl->isContainerDir) {
        namespace fs = std::filesystem;
        fs::path filePath = fs::path(openArchivePath) / archivePath;
        FILE* f = std::fopen(filePath.string().c_str(), "rb");
        if (f == nullptr) {
            error = "File not found in container: " + filePath.string();
            return cursor;
        }
        auto cursorImpl = std::make_unique<StreamCursor::Impl>();
        cursorImpl->containerFile = f;
        cursor.impl = std::move(cursorImpl);
        return cursor;
    }

    if (impl->zipOpen) {
        mz_uint32 fileIndex = 0;
        if (!mz_zip_reader_locate_file_v2(&impl->zip, archivePath.c_str(), nullptr, 0, &fileIndex)) {
            error = "File not found in archive: " + archivePath;
            return cursor;
        }

        auto cursorImpl = std::make_unique<StreamCursor::Impl>();
        cursorImpl->zipState = mz_zip_reader_extract_iter_new(&impl->zip, fileIndex, 0);
        if (cursorImpl->zipState == nullptr) {
            error = "Failed to open streaming extraction for: " + archivePath;
            return cursor;
        }

        cursor.impl = std::move(cursorImpl);
        return cursor;
    }

    error = "No open archive or container";
    return cursor;
}

bool ProjectLoader::reopenArchiveKeepProject(const std::string& path, std::string& error) {
    if (impl->zipOpen) {
        mz_zip_reader_end(&impl->zip);
        impl->zipOpen = false;
    }
    namespace fs = std::filesystem;
    if (fs::is_directory(path)) {
        impl->isContainerDir = true;
        openArchivePath = path;
        return true;
    }
    std::memset(&impl->zip, 0, sizeof(impl->zip));
    if (!mz_zip_reader_init_file(&impl->zip, path.c_str(), 0)) {
        error = "Failed to open archive: " + path;
        return false;
    }
    impl->zipOpen = true;
    openArchivePath = path;
    return true;
}

bool ProjectLoader::open(const std::string& path, std::string& error) {
    close();

    namespace fs = std::filesystem;
    if (fs::is_directory(path)) {
        impl->isContainerDir = true;
        openArchivePath = path;
        return reparseProject(error);
    }

    // Check if it's a legacy ZIP file
    std::memset(&impl->zip, 0, sizeof(impl->zip));
    if (mz_zip_reader_init_file(&impl->zip, path.c_str(), 0)) {
        impl->zipOpen = true;
        openArchivePath = path;
        return reparseProject(error);
    }

    error = "Failed to open package container or archive: " + path;
    return false;
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

    // Write timestamp info file
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
    if (!parseProjectJson(json, proj, error))
        return false;

    // Empty track list: seed defaults (same as a new project) so Builder has
    // something to attach regions to.
    if (proj.tracks.empty()) {
        const std::vector<std::string> defaultTrackNames = {
            "Drums", "Percussion", "Loops", "Bass", "Guitars", "Synths", "Keys",
            "Vocals", "Backing Vocals", "SFX", "Guide"
        };
        int idCounter = 1;
        for (const auto& tname : defaultTrackNames) {
            TrackDef t;
            t.id = "trk_" + std::to_string(idCounter++);
            t.name = tname;
            t.busId = "main";
            proj.tracks.push_back(std::move(t));
        }
    }

    parsedProject = std::move(proj);
    return true;
}

} // namespace resostage
