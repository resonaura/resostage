#pragma once

#include <CoreMIDI/CoreMIDI.h>
#include <readerwriterqueue.h>

#include <atomic>
#include <cstdint>
#include <string>
#include <thread>
#include <vector>

namespace resoset {

enum class MidiCommandKind : uint8_t {
    NoteOn,
    NoteOff,
    ControlChange,
    ProgramChange,
    ClockTick, // 0xF8 realtime message, no data bytes
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

    // Starts the dedicated worker thread that drains the command queue and
    // services MIDI Beat Clock generation.
    void start();
    void stop();

    // Lock-free: safe to call from the audio thread or an event-scanning
    // thread. Never blocks, never allocates (bounded pre-allocated queue).
    // Returns false if the queue is momentarily full (command dropped).
    bool enqueue(const MidiCommand& cmd);

    // 24 PPQN MIDI Beat Clock, phase-locked to originHostTimeNanos (typically
    // the moment playback started, i.e. MasterClock's start anchor).
    void startClock(double bpm, uint64_t originHostTimeNanos);
    void stopClock();
    void setClockBpm(double bpm);

private:
    void workerThreadLoop();
    void sendCommand(const MidiCommand& cmd);
    void pumpClock();

    MIDIClientRef client = 0;
    MIDIPortRef outputPort = 0;
    MIDIEndpointRef destination = 0;

    moodycamel::ReaderWriterQueue<MidiCommand> queue{1024};
    std::thread worker;
    std::atomic<bool> running{false};

    std::atomic<bool> clockActive{false};
    std::atomic<double> clockBpm{120.0};
    std::atomic<uint64_t> clockOriginHostTimeNanos{0};
    uint64_t clockNextTickIndex = 0; // worker-thread-owned only
};

} // namespace resoset
