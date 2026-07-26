#include "ProjectLoader.h"
#include "ProjectJson.h"

#include "miniz.h"
#include "simdjson.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>

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

    bool mute = false;
    (void)busEl["mute"].get(mute);
    bus.mute = mute;

    bool solo = false;
    (void)busEl["solo"].get(solo);
    bus.solo = solo;

    bool isAux = false;
    (void)busEl["isAux"].get(isAux);
    bus.isAux = isAux;

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

    bool solo = false;
    (void)trackEl["solo"].get(solo);
    track.solo = solo;

    (void)trackEl["trimStartSeconds"].get(track.trimStartSeconds);
    (void)trackEl["trimEndSeconds"].get(track.trimEndSeconds);

    simdjson::dom::array sendsArr;
    if (!trackEl["sends"].get(sendsArr)) {
        for (simdjson::dom::element sendEl : sendsArr) {
            TrackSendDef send;
            std::string_view busView;
            if (sendEl["bus"].get(busView))
                continue;
            send.busId = std::string(busView);
            (void)sendEl["gainDb"].get(send.gainDb);
            (void)sendEl["preFader"].get(send.preFader);
            bool enabled = true;
            (void)sendEl["enabled"].get(enabled);
            send.enabled = enabled;
            track.sends.push_back(std::move(send));
        }
    }

    return true;
}

bool parseEventType(std::string_view s, EventType& type) {
    if (s == "midiNoteOn") type = EventType::MidiNoteOn;
    else if (s == "midiNoteOff") type = EventType::MidiNoteOff;
    else if (s == "midiCC") type = EventType::MidiCC;
    else if (s == "midiProgramChange") type = EventType::MidiProgramChange;
    else if (s == "http") type = EventType::Http;
    else if (s == "dmx") type = EventType::Dmx;
    else return false;
    return true;
}

bool parseEvent(const simdjson::dom::element& evEl, TimelineEvent& ev, std::string& error) {
    std::string_view idView, typeView;
    if (evEl["id"].get(idView) || evEl["type"].get(typeView)) {
        error = "Event entry missing required 'id' or 'type'";
        return false;
    }
    ev.id = std::string(idView);
    if (!parseEventType(typeView, ev.type)) {
        error = "Unknown event type '" + std::string(typeView) + "'";
        return false;
    }

    (void)evEl["timeSeconds"].get(ev.timeSeconds);
    (void)evEl["triggerOnLoad"].get(ev.triggerOnLoad);
    (void)evEl["latencyCompensationMs"].get(ev.latencyCompensationMs);

    int64_t tmp = 0;
    if (!evEl["midiChannel"].get(tmp)) ev.midiChannel = static_cast<int>(tmp);
    if (!evEl["midiNote"].get(tmp)) ev.midiNote = static_cast<int>(tmp);
    if (!evEl["midiVelocity"].get(tmp)) ev.midiVelocity = static_cast<int>(tmp);
    if (!evEl["midiCC"].get(tmp)) ev.midiCC = static_cast<int>(tmp);
    if (!evEl["midiCCValue"].get(tmp)) ev.midiCCValue = static_cast<int>(tmp);
    if (!evEl["midiProgram"].get(tmp)) ev.midiProgram = static_cast<int>(tmp);

    std::string_view sv;
    if (!evEl["httpUrl"].get(sv)) ev.httpUrl = std::string(sv);
    if (!evEl["httpMethod"].get(sv)) ev.httpMethod = std::string(sv);
    if (!evEl["httpBody"].get(sv)) ev.httpBody = std::string(sv);

    if (!evEl["dmxUniverse"].get(tmp)) ev.dmxUniverse = static_cast<int>(tmp);
    simdjson::dom::array dmxArr;
    if (!evEl["dmxData"].get(dmxArr)) {
        for (simdjson::dom::element b : dmxArr) {
            int64_t v = 0;
            if (!b.get(v))
                ev.dmxData.push_back(static_cast<uint8_t>(v));
        }
    }

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

    (void)songEl["builtInClickEnabled"].get(song.builtInClickEnabled);
    std::string_view clickBusView;
    if (!songEl["builtInClickBusId"].get(clickBusView))
        song.builtInClickBusId = std::string(clickBusView);
    (void)songEl["builtInClickGainDb"].get(song.builtInClickGainDb);

    simdjson::dom::array eventsArr;
    if (!songEl["events"].get(eventsArr)) {
        for (simdjson::dom::element evEl : eventsArr) {
            TimelineEvent ev;
            if (!parseEvent(evEl, ev, error))
                return false;
            song.events.push_back(std::move(ev));
        }
    }

    // Optional -- absent in projects saved before section markers existed.
    simdjson::dom::array sectionsArr;
    if (!songEl["sections"].get(sectionsArr)) {
        for (simdjson::dom::element secEl : sectionsArr) {
            std::string_view secIdView, secNameView;
            if (secEl["id"].get(secIdView) || secEl["name"].get(secNameView))
                continue; // malformed entry -- skip rather than fail the whole load
            SongSection section;
            section.id = std::string(secIdView);
            section.name = std::string(secNameView);
            (void)secEl["startSeconds"].get(section.startSeconds);
            int64_t colorIdx = 0;
            if (!secEl["colorIndex"].get(colorIdx))
                section.colorIndex = static_cast<int>(colorIdx);
            song.sections.push_back(std::move(section));
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
    openArchivePath.clear();
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
}

bool ProjectLoader::isOpen() const {
    return impl != nullptr && impl->zipOpen;
}

bool ProjectLoader::saveAs(const std::string& path, std::string& error) const {
    return saveAsWithExtras(path, {}, error);
}

bool ProjectLoader::saveAsWithExtras(const std::string& path,
                                     const std::vector<ExtraFile>& extraFiles,
                                     std::string& error,
                                     const Project* projectOverride) const {
    // No source archive open (e.g. saving a brand-new in-memory project for
    // the first time via newProject()) is a normal, expected state here --
    // there's simply nothing to copy from, so the existing-entries loop
    // below is skipped for that case rather than treated as an error.

    // Write to a temp file next to the destination, then rename -- so a crash
    // mid-write can't leave a truncated .rsnraset as the only copy.
    namespace fs = std::filesystem;
    const fs::path dest(path);
    const fs::path tmp = dest.parent_path() / (dest.filename().string() + ".tmp-writing");

    std::error_code ec;
    fs::remove(tmp, ec);

    mz_zip_archive outZip;
    std::memset(&outZip, 0, sizeof(outZip));
    if (!mz_zip_writer_init_file(&outZip, tmp.string().c_str(), 0)) {
        error = "Failed to create temp archive: " + tmp.string();
        return false;
    }

    const std::string json = serializeProjectJson(projectOverride != nullptr ? *projectOverride : parsedProject);
    if (!mz_zip_writer_add_mem(&outZip, "project.json", json.data(), json.size(), MZ_BEST_SPEED)) {
        mz_zip_writer_end(&outZip);
        fs::remove(tmp, ec);
        error = "Failed to write project.json into archive";
        return false;
    }

    auto isReplaced = [&](const char* name) {
        if (std::strcmp(name, "project.json") == 0)
            return true;
        for (const auto& ex : extraFiles)
            if (ex.archivePath == name)
                return true;
        return false;
    };

    if (impl->zipOpen) {
        const mz_uint numFiles = mz_zip_reader_get_num_files(const_cast<mz_zip_archive*>(&impl->zip));
        for (mz_uint i = 0; i < numFiles; ++i) {
            mz_zip_archive_file_stat st;
            if (!mz_zip_reader_file_stat(const_cast<mz_zip_archive*>(&impl->zip), i, &st))
                continue;
            if (st.m_is_directory)
                continue;
            if (isReplaced(st.m_filename))
                continue;

            // Raw compressed-bytes copy (no decompress+recompress round
            // trip): every save/import used to call extract_to_heap +
            // add_mem here for every *unchanged* entry too, so re-saving a
            // project with N previously-imported songs cost O(all N songs'
            // audio) on every single subsequent import, not just the new
            // file(s) -- the more you'd imported, the slower each next
            // import got. add_from_zip_reader streams the already-deflated
            // bytes straight through instead.
            if (!mz_zip_writer_add_from_zip_reader(&outZip, const_cast<mz_zip_archive*>(&impl->zip), i)) {
                mz_zip_writer_end(&outZip);
                fs::remove(tmp, ec);
                error = std::string("Failed to copy archive entry: ") + st.m_filename;
                return false;
            }
        }
    }

    for (const auto& ex : extraFiles) {
        if (ex.archivePath.empty() || ex.archivePath == "project.json")
            continue;
        // Stored, not deflated: these are WAV audio (near-incompressible
        // high-entropy PCM/float samples -- deflate buys a couple percent at
        // best) and peak-cache blobs. Even MZ_BEST_SPEED still does real
        // match-finding work, which measured ~10x slower than just copying
        // the bytes for real multi-track stem folders (100s of MB), making
        // every import/save feel sluggish for no real size benefit.
        if (!mz_zip_writer_add_mem(&outZip, ex.archivePath.c_str(),
                                   ex.data.data(), ex.data.size(), MZ_NO_COMPRESSION)) {
            mz_zip_writer_end(&outZip);
            fs::remove(tmp, ec);
            error = "Failed to write extra archive entry: " + ex.archivePath;
            return false;
        }
    }

    if (!mz_zip_writer_finalize_archive(&outZip)) {
        mz_zip_writer_end(&outZip);
        fs::remove(tmp, ec);
        error = "Failed to finalize archive";
        return false;
    }
    mz_zip_writer_end(&outZip);

    // If dest exists, replace atomically where the platform allows.
    fs::remove(dest, ec);
    fs::rename(tmp, dest, ec);
    if (ec) {
        // Fallback: copy then remove temp.
        fs::copy_file(tmp, dest, fs::copy_options::overwrite_existing, ec);
        fs::remove(tmp, ec);
        if (ec) {
            error = "Failed to move temp archive into place: " + ec.message();
            return false;
        }
    }
    return true;
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

struct ProjectLoader::StreamCursor::Impl {
    mz_zip_reader_extract_iter_state* state = nullptr;

    ~Impl() {
        if (state != nullptr)
            mz_zip_reader_extract_iter_free(state);
    }
};

ProjectLoader::StreamCursor::StreamCursor() = default;
ProjectLoader::StreamCursor::~StreamCursor() = default;
ProjectLoader::StreamCursor::StreamCursor(StreamCursor&&) noexcept = default;
ProjectLoader::StreamCursor& ProjectLoader::StreamCursor::operator=(StreamCursor&&) noexcept = default;

bool ProjectLoader::StreamCursor::isValid() const {
    return impl != nullptr && impl->state != nullptr;
}

size_t ProjectLoader::StreamCursor::read(void* buf, size_t bufSize) {
    if (!isValid())
        return 0;
    return mz_zip_reader_extract_iter_read(impl->state, buf, bufSize);
}

size_t ProjectLoader::StreamCursor::skip(size_t bytesToSkip) {
    if (!isValid())
        return 0;
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

ProjectLoader::StreamCursor ProjectLoader::openStream(const std::string& archivePath, std::string& error) const {
    StreamCursor cursor;

    if (!impl->zipOpen) {
        error = "Archive not open";
        return cursor;
    }

    mz_uint32 fileIndex = 0;
    if (!mz_zip_reader_locate_file_v2(&impl->zip, archivePath.c_str(), nullptr, 0, &fileIndex)) {
        error = "File not found in archive: " + archivePath;
        return cursor;
    }

    auto cursorImpl = std::make_unique<StreamCursor::Impl>();
    cursorImpl->state = mz_zip_reader_extract_iter_new(&impl->zip, fileIndex, 0);
    if (cursorImpl->state == nullptr) {
        error = "Failed to open streaming extraction for: " + archivePath;
        return cursor;
    }

    cursor.impl = std::move(cursorImpl);
    return cursor;
}

bool ProjectLoader::open(const std::string& path, std::string& error) {
    close();

    std::memset(&impl->zip, 0, sizeof(impl->zip));
    if (!mz_zip_reader_init_file(&impl->zip, path.c_str(), 0)) {
        error = "Failed to open archive: " + path;
        return false;
    }
    impl->zipOpen = true;
    openArchivePath = path;

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

    simdjson::dom::object kbObj;
    if (!doc["keybindings"].get(kbObj)) {
        for (simdjson::dom::key_value_pair field : kbObj) {
            std::string_view value;
            if (!field.value.get(value))
                proj.keybindings[std::string(field.key)] = std::string(value);
        }
    }

    simdjson::dom::array mmArr;
    if (!doc["midiMappings"].get(mmArr)) {
        for (simdjson::dom::element mmEl : mmArr) {
            std::string_view action;
            if (mmEl["action"].get(action))
                continue; // skip malformed entry rather than fail the whole load
            MidiMapping mapping;
            mapping.action = std::string(action);

            int64_t channel = 0;
            (void)mmEl["channel"].get(channel);
            mapping.channel = static_cast<int>(channel);

            std::string_view triggerType;
            if (!mmEl["triggerType"].get(triggerType))
                mapping.triggerType = (triggerType == "controlChange") ? MidiTriggerType::ControlChange : MidiTriggerType::NoteOn;

            int64_t number = 0;
            (void)mmEl["number"].get(number);
            mapping.number = static_cast<int>(number);

            proj.midiMappings.push_back(mapping);
        }
    }

    parsedProject = std::move(proj);
    return true;
}

} // namespace resoset
