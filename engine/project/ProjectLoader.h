#pragma once

#include "ProjectSchema.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace resoset {

// Reads a .rsnraset container (ZIP: project.json + /Audio/*.wav) and parses its
// metadata. WAV *format* decoding is done by WavStreamDecoder (also portable,
// JUCE-free) fed from a StreamCursor obtained here -- so audio never has to be
// either fully decompressed or fully decoded to RAM up front.
class ProjectLoader {
public:
    // Incremental, forward-only decompression of one archive entry, backed by
    // miniz's coroutine-style extraction iterator (mz_zip_reader_extract_iter_*).
    // Nothing is materialized in RAM beyond the requested read size.
    //
    // IMPORTANT: all StreamCursors obtained from the same ProjectLoader share
    // one underlying zip file handle. They (and extractFile()) must only ever
    // be driven from a single thread at a time -- see StreamingEngine, which
    // owns exactly one background I/O thread for this reason.
    class StreamCursor {
    public:
        StreamCursor();
        ~StreamCursor();
        StreamCursor(StreamCursor&&) noexcept;
        StreamCursor& operator=(StreamCursor&&) noexcept;
        StreamCursor(const StreamCursor&) = delete;
        StreamCursor& operator=(const StreamCursor&) = delete;

        bool isValid() const;

        // Reads up to bufSize bytes of decompressed data. Returns bytes actually
        // read; 0 means end-of-stream (or the cursor is invalid/exhausted).
        size_t read(void* buf, size_t bufSize);

        // Discards (decompresses but throws away) up to bytesToSkip bytes.
        // Used for catch-up: fast-forwarding the source past audio that should
        // have played during a stall longer than the ring-buffer lookahead.
        // Returns bytes actually skipped (less than requested at end-of-stream).
        size_t skip(size_t bytesToSkip);

        // Directory-container only: current byte offset of the underlying FILE*
        // (-1 if unavailable / ZIP iter). Used to cache the WAV 'data' payload
        // start for O(1) soft-rewind without re-parsing the header.
        int64_t tell() const;
        // Directory-container only: absolute seek. Returns false for ZIP.
        bool seekAbsolute(int64_t offset);

    private:
        friend class ProjectLoader;
        struct Impl;
        std::unique_ptr<Impl> impl;
    };

    ProjectLoader();
    ~ProjectLoader();

    ProjectLoader(const ProjectLoader&) = delete;
    ProjectLoader& operator=(const ProjectLoader&) = delete;

    // Opens the .rsnraset (ZIP) file and parses project.json. Returns false and
    // fills `error` on failure (bad zip, missing project.json, malformed JSON).
    bool open(const std::string& path, std::string& error);
    bool reopenArchiveKeepProject(const std::string& path, std::string& error);
    // Re-parses project.json from the already-open archive into parsedProject.
    // Use after archive contents changed (e.g. import wrote new project.json).
    bool reparseProject(std::string& error);
    void close();

    // Resets to a fresh, empty, unsaved Project -- not backed by any archive
    // on disk. Lets the app start in an immediately-editable state (add
    // songs/tracks/busses via the Builder) rather than forcing the user to
    // load an existing .rsnraset before they can do anything. saveAs() /
    // saveAsWithExtras() both work from this state (there's simply nothing
    // to copy from a source archive); archivePath() stays empty until the
    // first successful save.
    void newProject(const std::string& name);

    const Project& project() const { return parsedProject; }
    // Mutable access for the Builder / Mixer UI. Audio I/O never holds a
    // reference across threads -- callers mutate on the message thread and
    // then ask AudioEngine to republish a routing snapshot.
    Project& project() { return parsedProject; }

    // Path of the currently open archive (empty if none).
    const std::string& archivePath() const { return openArchivePath; }
    bool isOpen() const;

    // Writes the in-memory Project as project.json into a new .rsnraset at
    // `path`, copying every non-project.json entry from the currently open
    // archive (audio stems etc.). Pure write: does NOT change which archive
    // this loader considers open (openArchivePath stays put). Callers that
    // want to switch the live archive must close()+open() themselves.
    //
    // Directory containers: safe to call while StreamCursors are live (copy
    // is filesystem-level; open FILE* keep reading their inodes).
    // Legacy ZIP: extract races the shared mz_zip handle — stop streaming
    // first, or only use from a thread that already owns exclusive access.
    // Prefer AudioEngine::saveProjectAsync() for the full orchestration.
    bool saveAs(const std::string& path, std::string& error) const;

    // Like saveAs, but also injects/replaces archive entries (e.g. a newly
    // imported WAV). Entries in `extraFiles` whose name collides with an
    // existing zip member replace that member.
    //
    // `projectOverride`, if non-null, is serialized into project.json INSTEAD
    // of the live project() -- lets a caller doing slow disk I/O on a
    // background thread work from a private snapshot without touching the
    // shared message-thread project().
    struct ExtraFile {
        std::string archivePath; // e.g. "Audio/kick.wav"
        std::vector<uint8_t> data;
    };
    bool saveAsWithExtras(const std::string& path,
                          const std::vector<ExtraFile>& extraFiles,
                          std::string& error,
                          const Project* projectOverride = nullptr) const;

    // Extracts a file (e.g. "Audio/song1_synths1.wav") from the currently open
    // archive into an in-memory buffer. Returns false if the archive isn't open
    // or the entry doesn't exist. Use for small metadata files; for audio stems
    // prefer openStream() so the whole file isn't materialized in RAM.
    bool extractFile(const std::string& archivePath, std::vector<uint8_t>& outData, std::string& error) const;

    // Opens a streaming cursor for `archivePath`. Returns an invalid cursor
    // (isValid()==false) on failure.
    StreamCursor openStream(const std::string& archivePath, std::string& error) const;

    // Package Container & Autosave API
    bool isDirectoryContainer() const;
    bool saveAutosave(std::string& error) const;
    bool hasAutosave(std::string& outTimestamp) const;
    bool loadAutosave(std::string& error);
    void clearAutosave();
    bool saveBackup(std::string& error) const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
    Project parsedProject;
    std::string openArchivePath;
};

} // namespace resoset
