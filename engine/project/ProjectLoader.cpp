#include "ProjectLoader.h"
#include "ProjectJson.h"

#include "miniz.h"
#include "simdjson.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>

namespace resostage {

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

bool parseRegion(const simdjson::dom::element& regEl, Region& reg, std::string& error) {
    std::string_view idView, trackIdView;
    if (regEl["id"].get(idView) || regEl["trackId"].get(trackIdView)) {
        error = "Region entry missing required 'id' or 'trackId'";
        return false;
    }
    reg.id = std::string(idView);
    reg.trackId = std::string(trackIdView);

    std::string_view fileView;
    if (!regEl["file"].get(fileView))
        reg.file = std::string(fileView);

    (void)regEl["startSeconds"].get(reg.startSeconds);
    (void)regEl["sourceOffsetSeconds"].get(reg.sourceOffsetSeconds);
    (void)regEl["durationSeconds"].get(reg.durationSeconds);
    (void)regEl["gainDb"].get(reg.gainDb);
    (void)regEl["fadeInSeconds"].get(reg.fadeInSeconds);
    (void)regEl["fadeOutSeconds"].get(reg.fadeOutSeconds);
    (void)regEl["fadeInCurve"].get(reg.fadeInCurve);
    (void)regEl["fadeOutCurve"].get(reg.fadeOutCurve);
    (void)regEl["loop"].get(reg.loop);

    return true;
}

bool parseTrack(const simdjson::dom::element& trackEl, TrackDef& track, std::string& error) {
    std::string_view idView, nameView;
    if (trackEl["id"].get(idView) || trackEl["name"].get(nameView)) {
        error = "Track entry missing required 'id' or 'name'";
        return false;
    }
    track.id = std::string(idView);
    track.name = std::string(nameView);

    std::string_view busView;
    if (!trackEl["bus"].get(busView))
        track.busId = std::string(busView);
    else
        track.busId = "main";

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

    bool mono = false;
    (void)trackEl["mono"].get(mono);
    track.mono = mono;

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

bool parseLightFixtureKind(std::string_view s, LightFixture::Kind& kind) {
    if (s == "resoLightBar") kind = LightFixture::Kind::ResoLightBar;
    else if (s == "dmxGeneric") kind = LightFixture::Kind::DmxGeneric;
    else return false;
    return true;
}

bool parseLightFixture(const simdjson::dom::element& fxEl, LightFixture& fx, std::string& error) {
    std::string_view idView, nameView;
    if (fxEl["id"].get(idView) || fxEl["name"].get(nameView)) {
        error = "Light fixture entry missing required 'id' or 'name'";
        return false;
    }
    fx.id = std::string(idView);
    fx.name = std::string(nameView);

    std::string_view kindView;
    if (!fxEl["kind"].get(kindView))
        (void)parseLightFixtureKind(kindView, fx.kind); // unknown kind -- keep default

    int64_t tmp = 0;
    if (!fxEl["gridColumn"].get(tmp)) fx.gridColumn = static_cast<int>(tmp);
    if (!fxEl["gridRow"].get(tmp)) fx.gridRow = static_cast<int>(tmp);
    if (!fxEl["ledCount"].get(tmp)) fx.ledCount = static_cast<int>(tmp);
    (void)fxEl["addressable"].get(fx.addressable);
    (void)fxEl["posX"].get(fx.posX);
    (void)fxEl["posY"].get(fx.posY);
    (void)fxEl["posZ"].get(fx.posZ);
    (void)fxEl["rotationYDeg"].get(fx.rotationYDeg);
    (void)fxEl["mountedHorizontally"].get(fx.mountedHorizontally);
    if (!fxEl["dmxUniverse"].get(tmp)) fx.dmxUniverse = static_cast<int>(tmp);
    if (!fxEl["dmxStartChannel"].get(tmp)) fx.dmxStartChannel = static_cast<int>(tmp);
    if (!fxEl["dmxChannelCount"].get(tmp)) fx.dmxChannelCount = static_cast<int>(tmp);

    return true;
}

bool parseLightingKind(std::string_view s, LightingKind& kind) {
    if (s == "resoLight") kind = LightingKind::ResoLight;
    else if (s == "dmxGeneric") kind = LightingKind::DmxGeneric;
    else if (s == "none") kind = LightingKind::None;
    else return false;
    return true;
}

void parseLightingConfig(const simdjson::dom::element& liEl, LightingConfig& cfg) {
    (void)liEl["enabled"].get(cfg.enabled);
    std::string_view kindView;
    if (!liEl["kind"].get(kindView))
        (void)parseLightingKind(kindView, cfg.kind);
    int64_t tmp = 0;
    if (!liEl["resoLightColumns"].get(tmp)) cfg.resoLightColumns = static_cast<int>(tmp);
    if (!liEl["resoLightRows"].get(tmp)) cfg.resoLightRows = static_cast<int>(tmp);

    simdjson::dom::array fxArr;
    if (!liEl["fixtures"].get(fxArr)) {
        for (simdjson::dom::element fxEl : fxArr) {
            LightFixture fx;
            std::string fxError;
            if (parseLightFixture(fxEl, fx, fxError))
                cfg.fixtures.push_back(std::move(fx));
        }
    }
}

bool parseLightTrack(const simdjson::dom::element& ltEl, LightTrack& lt, std::string& error) {
    std::string_view idView, nameView;
    if (ltEl["id"].get(idView) || ltEl["name"].get(nameView)) {
        error = "Light track entry missing required 'id' or 'name'";
        return false;
    }
    lt.id = std::string(idView);
    lt.name = std::string(nameView);

    simdjson::dom::array fxIdsArr;
    if (!ltEl["fixtureIds"].get(fxIdsArr)) {
        for (simdjson::dom::element idEl : fxIdsArr) {
            std::string_view v;
            if (!idEl.get(v))
                lt.fixtureIds.push_back(std::string(v));
        }
    }
    return true;
}

bool parseLightCue(const simdjson::dom::element& lcEl, LightCue& lc, std::string& error) {
    std::string_view idView, trackIdView;
    if (lcEl["id"].get(idView) || lcEl["trackId"].get(trackIdView)) {
        error = "Light cue entry missing required 'id' or 'trackId'";
        return false;
    }
    lc.id = std::string(idView);
    lc.trackId = std::string(trackIdView);

    (void)lcEl["startSeconds"].get(lc.startSeconds);
    (void)lcEl["durationSeconds"].get(lc.durationSeconds);
    int64_t tmp = 0;
    if (!lcEl["colorR"].get(tmp)) lc.colorR = static_cast<uint8_t>(tmp);
    if (!lcEl["colorG"].get(tmp)) lc.colorG = static_cast<uint8_t>(tmp);
    if (!lcEl["colorB"].get(tmp)) lc.colorB = static_cast<uint8_t>(tmp);
    (void)lcEl["intensity"].get(lc.intensity);
    (void)lcEl["fadeInSeconds"].get(lc.fadeInSeconds);
    (void)lcEl["fadeOutSeconds"].get(lc.fadeOutSeconds);
    std::string_view labelView;
    if (!lcEl["label"].get(labelView))
        lc.label = std::string(labelView);

    return true;
}

bool parseSong(const simdjson::dom::element& songEl, SongDef& song, std::string& error, Project& project) {
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

    simdjson::dom::array regionsArr;
    if (!songEl["regions"].get(regionsArr)) {
        for (simdjson::dom::element regEl : regionsArr) {
            Region reg;
            if (!parseRegion(regEl, reg, error))
                return false;
            if (!reg.file.empty()) {
                song.regions.push_back(std::move(reg));
            }
        }
    } else {
        // Fallback / legacy format: song contained "tracks" array
        simdjson::dom::array tracksArr;
        if (!songEl["tracks"].get(tracksArr)) {
            int regCounter = 1;
            for (simdjson::dom::element trackEl : tracksArr) {
                TrackDef legacyTrack;
                if (parseTrack(trackEl, legacyTrack, error)) {
                    bool exists = false;
                    for (const auto& existing : project.tracks) {
                        if (existing.id == legacyTrack.id) { exists = true; break; }
                    }
                    if (!exists) {
                        project.tracks.push_back(legacyTrack);
                    }
                    std::string_view trkFileView;
                    if (!trackEl["file"].get(trkFileView) && !trkFileView.empty()) {
                        Region reg;
                        reg.id = "reg_" + song.id + "_" + std::to_string(regCounter++);
                        reg.trackId = legacyTrack.id;
                        reg.file = std::string(trkFileView);
                        (void)trackEl["trimStartSeconds"].get(reg.sourceOffsetSeconds);
                        double trimEnd = 0.0;
                        (void)trackEl["trimEndSeconds"].get(trimEnd);
                        if (trimEnd > reg.sourceOffsetSeconds) {
                            reg.durationSeconds = trimEnd - reg.sourceOffsetSeconds;
                        }
                        reg.gainDb = legacyTrack.gainDb;
                        song.regions.push_back(std::move(reg));
                    }
                }
            }
        }
    }

    (void)songEl["builtInClickEnabled"].get(song.builtInClickEnabled);
    std::string_view clickBusView;
    if (!songEl["builtInClickBusId"].get(clickBusView))
        song.builtInClickBusId = std::string(clickBusView);
    (void)songEl["builtInClickGainDb"].get(song.builtInClickGainDb);

    simdjson::dom::array clickSendsArr;
    if (!songEl["builtInClickSends"].get(clickSendsArr)) {
        for (simdjson::dom::element csEl : clickSendsArr) {
            TrackSendDef cs;
            std::string_view busView;
            if (csEl["bus"].get(busView))
                continue;
            cs.busId = std::string(busView);
            (void)csEl["gainDb"].get(cs.gainDb);
            (void)csEl["preFader"].get(cs.preFader);
            bool enabled = true;
            (void)csEl["enabled"].get(enabled);
            cs.enabled = enabled;
            song.builtInClickSends.push_back(std::move(cs));
        }
    }

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

    // Optional -- absent in projects saved before lighting existed.
    simdjson::dom::array lightCuesArr;
    if (!songEl["lightCues"].get(lightCuesArr)) {
        for (simdjson::dom::element lcEl : lightCuesArr) {
            LightCue cue;
            std::string cueError;
            if (parseLightCue(lcEl, cue, cueError))
                song.lightCues.push_back(std::move(cue));
        }
    }

    return true;
}

} // namespace

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
    std::streamsize size = ifs.tellg();
    ifs.seekg(0, std::ios::beg);
    std::vector<uint8_t> jsonBytes(static_cast<size_t>(size));
    ifs.read(reinterpret_cast<char*>(jsonBytes.data()), size);
    ifs.close();

    simdjson::dom::parser parser;
    simdjson::dom::element doc;
    simdjson::error_code parseError =
        parser.parse(reinterpret_cast<const char*>(jsonBytes.data()), jsonBytes.size()).get(doc);
    if (parseError) {
        error = std::string("Autosave parse error: ") + simdjson::error_message(parseError);
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

    double clickGainDb = -6.0;
    const bool hadProjectClickGain = !doc["builtInClickGainDb"].get(clickGainDb);
    if (hadProjectClickGain)
        proj.builtInClickGainDb = clickGainDb;

    double clickPan = 0.0;
    if (!doc["builtInClickPan"].get(clickPan))
        proj.builtInClickPan = std::clamp(clickPan, -1.0, 1.0);

    bool clickSolo = false;
    if (!doc["builtInClickSolo"].get(clickSolo))
        proj.builtInClickSolo = clickSolo;

    simdjson::dom::array bussesArr;
    if (!doc["busses"].get(bussesArr)) {
        for (simdjson::dom::element busEl : bussesArr) {
            BusDef bus;
            if (!parseBus(busEl, bus, error)) return false;
            proj.busses.push_back(std::move(bus));
        }
    }

    simdjson::dom::array tracksArr;
    if (!doc["tracks"].get(tracksArr)) {
        for (simdjson::dom::element trackEl : tracksArr) {
            TrackDef track;
            if (parseTrack(trackEl, track, error))
                proj.tracks.push_back(std::move(track));
        }
    }

    // Optional -- absent in projects saved before lighting existed.
    simdjson::dom::element lightingEl;
    if (!doc["lighting"].get(lightingEl))
        parseLightingConfig(lightingEl, proj.lighting);
    simdjson::dom::array lightTracksArr;
    if (!doc["lightTracks"].get(lightTracksArr)) {
        for (simdjson::dom::element ltEl : lightTracksArr) {
            LightTrack lt;
            std::string ltError;
            if (parseLightTrack(ltEl, lt, ltError))
                proj.lightTracks.push_back(std::move(lt));
        }
    }

    simdjson::dom::array songsArr;
    if (!doc["songs"].get(songsArr)) {
        for (simdjson::dom::element songEl : songsArr) {
            SongDef song;
            if (!parseSong(songEl, song, error, proj)) return false;
            proj.songs.push_back(std::move(song));
        }
    }

    // Migrate legacy per-song click gain → project-global when missing.
    if (!hadProjectClickGain) {
        for (const auto& s : proj.songs) {
            if (s.builtInClickEnabled || s.builtInClickGainDb != -6.0) {
                proj.builtInClickGainDb = s.builtInClickGainDb;
                break;
            }
        }
    }

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
    if (openArchivePath.empty())
        return false;
    namespace fs = std::filesystem;
    fs::path backupDir = fs::path(openArchivePath) / "Backups";
    std::error_code ec;
    fs::create_directories(backupDir, ec);

    const auto now = std::chrono::system_clock::now();
    const auto in_time_t = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << "project_" << std::put_time(std::localtime(&in_time_t), "%Y%m%d_%H%M%S") << ".json";

    fs::path mainJson = fs::path(openArchivePath) / "project.json";
    if (fs::exists(mainJson, ec)) {
        fs::copy_file(mainJson, backupDir / ss.str(), fs::copy_options::overwrite_existing, ec);
    } else {
        std::string json = serializeProjectJson(parsedProject);
        std::ofstream ofs(backupDir / ss.str(), std::ios::binary);
        if (ofs.is_open()) {
            ofs.write(json.data(), json.size());
        }
    }
    return true;
}


bool ProjectLoader::reparseProject(std::string& error) {
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

    double clickGainDb = -6.0;
    const bool hadProjectClickGain = !doc["builtInClickGainDb"].get(clickGainDb);
    if (hadProjectClickGain)
        proj.builtInClickGainDb = clickGainDb;

    double clickPan = 0.0;
    if (!doc["builtInClickPan"].get(clickPan))
        proj.builtInClickPan = std::clamp(clickPan, -1.0, 1.0);

    bool clickSolo = false;
    if (!doc["builtInClickSolo"].get(clickSolo))
        proj.builtInClickSolo = clickSolo;

    simdjson::dom::array bussesArr;
    if (!doc["busses"].get(bussesArr)) {
        for (simdjson::dom::element busEl : bussesArr) {
            BusDef bus;
            if (!parseBus(busEl, bus, error))
                return false;
            proj.busses.push_back(std::move(bus));
        }
    }

    simdjson::dom::array tracksArr;
    if (!doc["tracks"].get(tracksArr)) {
        for (simdjson::dom::element trackEl : tracksArr) {
            TrackDef track;
            if (parseTrack(trackEl, track, error))
                proj.tracks.push_back(std::move(track));
        }
    }

    if (proj.tracks.empty()) {
        const std::vector<std::string> defaultTrackNames = {
            "Drums", "Percussion", "Loops", "Bass", "Guitars", "Synths", "Keys", "Vocals", "Backing Vocals", "SFX", "Guide"
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

    // Optional -- absent in projects saved before lighting existed.
    simdjson::dom::element lightingEl;
    if (!doc["lighting"].get(lightingEl))
        parseLightingConfig(lightingEl, proj.lighting);
    simdjson::dom::array lightTracksArr;
    if (!doc["lightTracks"].get(lightTracksArr)) {
        for (simdjson::dom::element ltEl : lightTracksArr) {
            LightTrack lt;
            std::string ltError;
            if (parseLightTrack(ltEl, lt, ltError))
                proj.lightTracks.push_back(std::move(lt));
        }
    }

    simdjson::dom::array songsArr;
    if (!doc["songs"].get(songsArr)) {
        for (simdjson::dom::element songEl : songsArr) {
            SongDef song;
            if (!parseSong(songEl, song, error, proj))
                return false;
            proj.songs.push_back(std::move(song));
        }
    }

    if (!hadProjectClickGain) {
        for (const auto& s : proj.songs) {
            if (s.builtInClickEnabled || s.builtInClickGainDb != -6.0) {
                proj.builtInClickGainDb = s.builtInClickGainDb;
                break;
            }
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

} // namespace resostage
