// Public project I/O / import / dirty-state API for AudioEngine.
// Included only from AudioEngine.h inside `class AudioEngine { public: ... }`.
// Implementation: AudioEngineProject.cpp, AudioEngineImport.cpp.

    // Loads a .rsnraset and its global bus list, and (re)starts the
    // background streaming I/O thread against it. Does not stage any song's
    // tracks yet -- call selectSong() next. Returns false + fills `error` on failure.
    bool loadProject(const std::string& path, std::string& error);

    // Resets to a fresh, empty, unsaved Project (one default "Main" stereo
    // bus, no songs) so the app is immediately editable via the Builder.
    // Immediately backed by an auto-created draft archive in Application
    // Support (see isDraftProject()) so WAV/song-folder imports work right
    // away without forcing a manual Save As first -- only falls back to
    // "no archive at all" if the draft couldn't be created (e.g. disk full).
    void newProject(const std::string& name = "New Project");

    // Saves the live Project (and existing Audio/* stems) into a .rsnraset.
    // Stops playback/streaming, writes the archive, reopens it, and restages
    // the previously selected song when possible. If currently on a draft
    // archive and saving to a different path, PROMOTES the draft (moves the
    // archive to the new location, same as a normal "Save As" would expect --
    // subsequent edits go to the real file, not the invisible draft) rather
    // than leaving the draft as the active archive.
    bool saveProject(const std::string& path, std::string& error);

    // Non-blocking save: heavy archive write runs off the message thread so
    // the UI stays responsive. onComplete(success, error) is always invoked
    // on the message thread. isBusy() is true while a save is in flight.
    // Callers should set a "Saving…" status before calling this.
    void saveProjectAsync(const std::string& path,
                          std::function<void(bool success, std::string error)> onComplete);

    const std::string& projectPath() const { return loader.archivePath(); }

    bool hasAutosave(std::string& outTimestamp) const { return loader.hasAutosave(outTimestamp); }

    bool loadAutosave(std::string& error) { return loader.loadAutosave(error); }

    void clearAutosave() { loader.clearAutosave(); }

    // True until the user does a real Save As: the project is currently

    // backed by an auto-created draft archive in Application Support rather
    // than a location the user chose themselves. UI should treat this as
    // "unsaved" for prompting purposes even though projectPath() is non-empty.
    bool isDraftProject() const { return usingDraftArchive; }

    // Imports a filesystem WAV into the open .rsnraset as Audio/<name>, points
    // the given song's track at it, rewrites the archive, reopens, restages
    // whatever song was playing before (independent of songIndex).
    //
    // Reads the source file and rewrites the archive (both slow disk I/O --
    // real stems run tens to hundreds of MB) on a background thread so the
    // message thread, and with it the whole UI, never blocks on an import.
    // onComplete fires on the message thread. Between calling this and
    // onComplete firing, isBusy() is true and the caller MUST NOT let any
    // other code touch this AudioEngine's project/loader state (BuilderPanel
    // disables further edits and shows a spinner) -- see
    // ProjectLoader::saveAsWithExtras's projectOverride parameter doc for why.
    void importWavForTrackAsync(size_t songIndex, size_t trackIndex, const std::string& filesystemPath,
                                std::function<void(bool success, std::string error)> onComplete);

    // Imports multiple stem WAV files at once in a single background pass into the container package.
    struct BatchItem {
        size_t trackIndex;
        std::string filesystemPath;
    };

    void importSongStemsBatchAsync(size_t songIndex, const std::vector<BatchItem>& items,
                                   std::function<void(bool success, std::string error)> onComplete);

    // Non-recursive scan of `folderPath` for .wav files (sorted by name, for
    // deterministic track order). Also attempts to detect a shared tempo for
    // the folder: first by looking for an embedded cue-point "Tempo: N"
    // label in each WAV (first match wins), falling back to a "120BPM"-style
    // token parsed from the folder name. `outDetectedBpm` stays 0.0 if
    // neither source found anything -- caller should offer a sane default.
    // Read-only: does not touch the project or archive. Fast (only reads
    // WAV headers/small metadata chunks, never full file bodies) -- safe to
    // call synchronously from the message thread, unlike the imports below.
    bool scanFolderForImport(const std::string& folderPath, std::vector<std::string>& outWavPaths,
                             double& outDetectedBpm, std::string& error) const;

    void importSongFromFolderAsync(const std::string& folderPath, const std::string& songName, double bpm,
                                   int tsNumerator, int tsDenominator,
                                   std::function<void(bool success, std::string error)> onComplete);

    // Unsaved changes / dirty state tracking for Logic Pro quit dialog & autosave
    bool hasUnsavedChanges() const { return unsavedChanges.load(std::memory_order_acquire); }

    // While playing, autosave is deferred (disk thrash mid-show) and flushed
    // on stop / next idle markDirty. See flushDeferredAutosave().
    void markDirty();

    void clearDirty() {
        unsavedChanges.store(false, std::memory_order_release);
        autosaveDeferred.store(false, std::memory_order_release);
    }

    void flushDeferredAutosave();

    // True from the moment an async import starts until its onComplete

    // fires. UI should disable further project-editing actions and show a
    // busy/spinner indicator while this is true.
    bool isBusy() const {
        return busyImporting.load(std::memory_order_acquire)
               || busySaving.load(std::memory_order_acquire);
    }
