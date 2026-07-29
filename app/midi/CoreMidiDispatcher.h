#pragma once

#include <CoreMIDI/CoreMIDI.h>
#include <readerwriterqueue.h>

#include <atomic>
#include <cstdint>
#include <deque>
#include <string>
#include <thread>
#include <vector>

namespace resoset {

enum class MidiCommandKind : uint8_t {
    NoteOn,
    NoteOff,
    ControlChange,
    ProgramChange,
    ClockTick,           // 0xF8 realtime message, no data bytes
    Start,               // 0xFA realtime message, no data bytes
    Continue,            // 0xFB realtime message, no data bytes
    Stop,                // 0xFC realtime message, no data bytes
    SongPositionPointer, // 0xF2, 2 data bytes (14-bit MIDI-beat count, LSB/MSB)
};

struct MidiCommand {
    MidiCommandKind kind = MidiCommandKind::NoteOn;
    uint8_t channel = 0; // 0-15
    uint8_t data1 = 0;   // note number or CC number
    uint8_t data2 = 0;   // velocity or CC value (unused for ProgramChange/ClockTick)
    // Absolute target send time, same nanosecond domain as
    // SystemMonotonicClock/MasterClock (converted to mach ticks internally --
    // CoreMIDI's MIDITimeStamp is raw mach_absolute_time() ticks, not nanoseconds).
    uint64_t targetHostTimeNanos = 0;
};

// Dedicated MIDI thread: receives commands via a lock-free SPSC queue from
// the audio/event-scanning thread, and submits them to CoreMIDI using its
// native timestamped packet API (MIDISend with an explicit future
// MIDITimeStamp) rather than JUCE's sleep-based MidiOutput thread. CoreMIDI
// itself performs the precise scheduled delivery from the timestamp; this
// thread's job is just to submit packets with enough lead time, off the
// audio thread. Actual CoreMIDI calls never happen on the audio thread.
class CoreMidiDispatcher {
public:
    CoreMidiDispatcher();
    ~CoreMidiDispatcher();

    CoreMidiDispatcher(const CoreMidiDispatcher&) = delete;
    CoreMidiDispatcher& operator=(const CoreMidiDispatcher&) = delete;

    std::vector<std::string> availableDestinationNames() const;

    // Opens a CoreMIDI destination by name; pass an empty string to use the
    // first available destination. Returns false + fills `error` on failure.
    bool openDestination(const std::string& destinationName, std::string& error);
    void closeDestination();
    bool hasDestination() const { return destination != 0; }

    // Creates a virtual CoreMIDI *source* named "ResoStage Sync" -- this is
    // the "fake device" a DAW picks as its MIDI In to test clock/transport
    // sync without any hardware or IAC bus setup. Distinct code path from
    // openDestination()/MIDISend above: CoreMIDI sources and destinations
    // are different endpoint kinds, so this is delivered via MIDIReceived,
    // mirrored alongside the real destination send in sendCommand() --
    // no other dispatcher/clock logic changes because of it.
    bool enableVirtualSource(std::string& error);
    void disableVirtualSource();
    bool hasVirtualSource() const { return virtualSource.load(std::memory_order_relaxed) != 0; }

    // Starts the dedicated worker thread that drains the command queue and
    // services MIDI Beat Clock generation.
    void start();
    void stop();

    // Lock-free: safe to call from the audio thread or an event-scanning
    // thread. Never blocks, never allocates (bounded pre-allocated queue).
    // Returns false if the queue is momentarily full (command dropped).
    bool enqueue(const MidiCommand& cmd);

    // 24 PPQN MIDI Beat Clock, phase-locked to originHostTimeNanos (typically
    // the moment playback started, i.e. MasterClock's start anchor). Also
    // emits MIDI Start (0xFA) and resets the tick index/phase -- only call
    // this for an actual transport start from fully stopped, never for a
    // song-to-song gapless transition or a resume from pause (use
    // continueClock() for those).
    void startClock(double bpm, uint64_t originHostTimeNanos);
    // Resumes a previously-stopped clock (e.g. after pause, or after a seek)
    // WITHOUT resetting the tick index/phase, and emits MIDI Continue (0xFB).
    void continueClock(double bpm);
    // Stops the clock and emits MIDI Stop (0xFC). Do not call this for a
    // gapless song-to-song transition -- the clock should keep ticking
    // continuously through those; use setClockBpm() instead.
    void stopClock();
    // Live in-place tempo change: no MIDI message of its own (it's a rate
    // change, not a transport event), no phase discontinuity for the next
    // unsent tick. Use this for a gapless song transition to a different bpm.
    void setClockBpm(double bpm);
    // Song Position Pointer (0xF2): tells followers the absolute position, in
    // MIDI-beats (sixteenth notes) since Start, ahead of a Continue after a
    // seek/relocate. 14-bit value (masked internally) -- see the call site in
    // AudioEngine::seekToSeconds() for the real-world ~68-minute ceiling this
    // implies at typical tempos.
    void sendSongPositionPointer(uint16_t midiBeats);

private:
    void workerThreadLoop();
    void sendCommand(const MidiCommand& cmd);
    void pumpClock();
    void drainPendingVirtualCommands();
    uint64_t nextPendingVirtualDeadlineNanos() const;

    MIDIClientRef client = 0;
    MIDIPortRef outputPort = 0;
    MIDIEndpointRef destination = 0;
    // Read on the worker thread (sendCommand), written from the message
    // thread (enable/disableVirtualSource) -- MIDIEndpointRef is just a
    // UInt32, so a plain atomic is enough, no mutex needed.
    std::atomic<MIDIEndpointRef> virtualSource{0};
    // Future-dated commands (clock ticks) waiting for their nominal time to
    // arrive before being handed to MIDIReceived -- see sendCommand()'s doc
    // comment for why the virtual-source path can't just submit ahead of
    // time the way MIDISend does. Worker-thread-owned only (pushed in
    // sendCommand, drained in drainPendingVirtualCommands, both only ever
    // called from workerThreadLoop), so no locking needed.
    std::deque<MidiCommand> pendingVirtualCommands;

    moodycamel::ReaderWriterQueue<MidiCommand> queue{1024};
    std::thread worker;
    std::atomic<bool> running{false};

    std::atomic<bool> clockActive{false};
    std::atomic<double> clockBpm{120.0};
    std::atomic<uint64_t> clockOriginHostTimeNanos{0};
    uint64_t clockNextTickIndex = 0; // worker-thread-owned only

    // Set by continueClock()/setClockBpm() (any thread), consumed only by
    // pumpClock() on the worker thread (which owns clockNextTickIndex) --
    // this indirection is what lets those two calls retime the clock without
    // directly touching the worker-owned tick index from another thread.
    std::atomic<bool> pendingContinueReanchor{false};
    std::atomic<bool> pendingTempoReanchor{false};
    double lastAnchoredBpm = 120.0; // worker-thread-owned only
};

} // namespace resoset
