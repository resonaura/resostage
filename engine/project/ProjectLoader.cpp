#include "ProjectLoader.h"

#include "miniz.h"
#include "simdjson.h"

#include <cstring>

namespace resoset {

namespace {

PlaybackMode parsePlaybackMode(std::string_view s) {
    if (s == "autoplayNext")
        return PlaybackMode::AutoplayNext;
    return PlaybackMode::WaitForTrigger;
}

// Parses a bus (or track) definition field-by-field, tolerating missing
// optional fields by leaving the struct's default value in place.
bool parseBus(const simdjson::dom::element& busEl, BusDef& bus, std::string& error) {
    std::string_view idView, nameView;
    if (busEl["id"].get(idView) || busEl["name"].get(nameView)) {
        error = "Bus entry missing required 'id' or 'name'";
        return false;
    }
    bus.id = std::string(idView);
    bus.name = std::string(nameView);

    int64_t channels = 2;
    (void)busEl["channels"].get(channels);
    bus.channels = static_cast<int>(channels);

    int64_t startChannel = 0;
    simdjson::dom::element outputEl;
    if (!busEl["output"].get(outputEl))
        (void)outputEl["startChannel"].get(startChannel);
    bus.output.startChannel = static_cast<int>(startChannel);

    double gainDb = 0.0;
    (void)busEl["gainDb"].get(gainDb);
    bus.gainDb = gainDb;

    return true;
}

bool parseTrack(const simdjson::dom::element& trackEl, TrackDef& track, std::string& error) {
    std::string_view idView, nameView, fileView, busView;
    if (trackEl["id"].get(idView) || trackEl["name"].get(nameView) ||
        trackEl["file"].get(fileView) || trackEl["bus"].get(busView)) {
        error = "Track entry missing required 'id', 'name', 'file', or 'bus'";
        return false;
    }
    track.id = std::string(idView);
    track.name = std::string(nameView);
    track.file = std::string(fileView);
    track.busId = std::string(busView);

    double gainDb = 0.0;
    (void)trackEl["gainDb"].get(gainDb);
    track.gainDb = gainDb;

    double pan = 0.0;
    (void)trackEl["pan"].get(pan);
    track.pan = pan;

    bool mute = false;
    (void)trackEl["mute"].get(mute);
    track.mute = mute;

    return true;
}

bool parseSong(const simdjson::dom::element& songEl, SongDef& song, std::string& error) {
    std::string_view idView, nameView;
    if (songEl["id"].get(idView) || songEl["name"].get(nameView)) {
        error = "Song entry missing required 'id' or 'name'";
        return false;
    }
    song.id = std::string(idView);
    song.name = std::string(nameView);

    double bpm = 120.0;
    (void)songEl["bpm"].get(bpm);
    song.bpm = bpm;

    simdjson::dom::element tsEl;
    if (!songEl["timeSignature"].get(tsEl)) {
        int64_t num = 4, den = 4;
        (void)tsEl["numerator"].get(num);
        (void)tsEl["denominator"].get(den);
        song.timeSignature.numerator = static_cast<int>(num);
        song.timeSignature.denominator = static_cast<int>(den);
    }

    std::string_view modeStr;
    if (!songEl["playbackMode"].get(modeStr))
        song.playbackMode = parsePlaybackMode(modeStr);

    simdjson::dom::array tracksArr;
    if (!songEl["tracks"].get(tracksArr)) {
        for (simdjson::dom::element trackEl : tracksArr) {
            TrackDef track;
            if (!parseTrack(trackEl, track, error))
                return false;
            song.tracks.push_back(std::move(track));
        }
    }

    return true;
}

} // namespace

struct ProjectLoader::Impl {
    mz_zip_archive zip{};
    bool zipOpen = false;

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
    parsedProject = Project{};
}

bool ProjectLoader::extractFile(const std::string& archivePath, std::vector<uint8_t>& outData, std::string& error) const {
    if (!impl->zipOpen) {
        error = "Archive not open";
        return false;
    }
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

bool ProjectLoader::open(const std::string& path, std::string& error) {
    close();

    std::memset(&impl->zip, 0, sizeof(impl->zip));
    if (!mz_zip_reader_init_file(&impl->zip, path.c_str(), 0)) {
        error = "Failed to open archive: " + path;
        return false;
    }
    impl->zipOpen = true;

    std::vector<uint8_t> jsonBytes;
    if (!extractFile("project.json", jsonBytes, error))
        return false;

    simdjson::dom::parser parser;
    simdjson::dom::element doc;
    simdjson::error_code parseError =
        parser.parse(reinterpret_cast<const char*>(jsonBytes.data()), jsonBytes.size()).get(doc);
    if (parseError) {
        error = std::string("project.json parse error: ") + simdjson::error_message(parseError);
        return false;
    }

    Project proj;

    int64_t formatVersion = 1;
    (void)doc["formatVersion"].get(formatVersion);
    proj.formatVersion = static_cast<int>(formatVersion);

    std::string_view nameView;
    if (!doc["name"].get(nameView))
        proj.name = std::string(nameView);

    double sampleRate = 48000.0;
    (void)doc["sampleRate"].get(sampleRate);
    proj.sampleRate = sampleRate;

    simdjson::dom::array bussesArr;
    if (!doc["busses"].get(bussesArr)) {
        for (simdjson::dom::element busEl : bussesArr) {
            BusDef bus;
            if (!parseBus(busEl, bus, error))
                return false;
            proj.busses.push_back(std::move(bus));
        }
    }

    simdjson::dom::array songsArr;
    if (!doc["songs"].get(songsArr)) {
        for (simdjson::dom::element songEl : songsArr) {
            SongDef song;
            if (!parseSong(songEl, song, error))
                return false;
            proj.songs.push_back(std::move(song));
        }
    }

    parsedProject = std::move(proj);
    return true;
}

} // namespace resoset
