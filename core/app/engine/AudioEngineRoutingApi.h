// Public routing / live-mix / bus-track accessor API for AudioEngine.
// Included only from AudioEngine.h inside `class AudioEngine { public: ... }`.
// Implementation: AudioEngineRouting.cpp.

    // Aux-send matrix API (message thread). Takes an explicit songIndex --
    // NOT tied to whichever song happens to be staged/playing -- so editing
    // a song in the Builder can never corrupt a *different*, currently
    // staged song's live mix, and never silently no-ops just because the
    // edited song isn't the one currently playing. Only pushes a live
    // routing update (audible immediately) when songIndex == currentSongIndex();
    // otherwise it's a pure Project-data edit that takes effect next time
    // that song is staged.
    void setTrackSend(size_t songIndex, size_t trackIndex, size_t sendIndex, const TrackSendDef& send);

    void addTrackSend(size_t songIndex, size_t trackIndex, const TrackSendDef& send);

    void removeTrackSend(size_t songIndex, size_t trackIndex, size_t sendIndex);

    size_t busCount() const { return busses.size(); }

    const std::string& busIdAt(size_t index) const { return busses[index].id; }

    const std::string& busNameAt(size_t index) const;

    // Physical routing info for a runtime bus (project or a global Direct Out
    // bus) so the web UI / mixer can render each bus's hardware destination.
    int busStartChannelAt(size_t index) const;

    int busChannelCountAt(size_t index) const;

    // True when the bus at `index` is a fabricated global Direct Out bus (not
    // an authorable project bus) -- such busses are hidden from the editable
    // bus rail and never persist to the project file.
    bool busIsDirectAt(size_t index) const;

    // Rebuild the global Direct Output busses from the current device's active
    // output channels and republish routing. Message thread. Called on load and
    // whenever the user changes the output device / active channels in Settings.
    void rebuildDirectOutBusses();

    // True when the Direct Output lane at `index` has a live physical output.
    // Project busses always report true; a missing direct-out lane is false.
    bool busAvailableAt(size_t index) const;

    // Current STAGED song's track accessors (message thread). Empty if no
    // song staged. Index is relative to the staged song's track list --
    // for read-only display of the live/playing song (Mixer, web state),
    // NOT for editing arbitrary songs (use trackDefInSong() for that).
    size_t trackCount() const { return trackIdByIndex.size(); }

    const std::string& trackIdAt(size_t index) const { return trackIdByIndex[index]; }

    const TrackDef* trackDefAt(size_t index) const;

    TrackDef* trackDefAt(size_t index);

    // Project-data lookup for a specific song, independent of what's
    // currently staged/playing. Use this from the Builder, which edits
    // arbitrary songs regardless of playback state.
    const TrackDef* trackDefInSong(size_t songIndex, size_t trackIndex) const;

    TrackDef* trackDefInSong(size_t songIndex, size_t trackIndex);

    // Live mix controls: mutate Project fields for the given song and, only
    // if that song is the one currently staged, atomically republish a
    // routing snapshot so the change is audible immediately. Safe to call
    // for any song at any time -- editing a non-staged song only updates
    // Project data (see setTrackSend() doc above for the full rationale).
    void setTrackGainDb(size_t songIndex, size_t trackIndex, double gainDb);

    void setTrackPan(size_t songIndex, size_t trackIndex, double pan);

    void setTrackMute(size_t songIndex, size_t trackIndex, bool mute);

    void setTrackSolo(size_t songIndex, size_t trackIndex, bool solo);

    void setTrackMono(size_t songIndex, size_t trackIndex, bool mono);

    void setTrackBusId(size_t songIndex, size_t trackIndex, const std::string& busId);

    void setBusGainDb(size_t busIndex, double gainDb);

    // Balance pan on bus → physical outs (-1..+1). Master + aux/sends.
    void setBusPan(size_t busIndex, double pan);

    void setBusMute(size_t busIndex, bool mute);

    void setBusSolo(size_t busIndex, bool solo);

    // Soloing the metronome joins the same solo group as track solo -- every
    // regular track goes silent exactly as if one of them had solo engaged
    // (see publishRoutingSnapshot()'s anyTrackSolo). Project-global, like
    // click gain/pan.
    void setClickSolo(bool solo);

    void setBusOutputChannel(size_t busIndex, int startChannel);

    void updateRegionWindow(const Region& r);

    // Full rebuild of routing from the current Project state (after Builder edits).
    void republishRouting();

    void refreshClickState();

    // Rebuild global bus list after Builder adds/removes busses (message thread).
    void rebuildBussesFromProject();

    // Push current song BPM + Song Position Pointer to MIDI clock followers.
    // Call after song hop / seek / live bpm edit while transport is live.
    // sendContinue=true also emits 0xFB (seek/resume); false is tempo+SPP only
    // (gapless hop -- clock already running).
    void syncMidiTransportToCurrentSong(bool sendContinue = false);
