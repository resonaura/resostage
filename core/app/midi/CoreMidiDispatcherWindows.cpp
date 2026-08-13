#include "CoreMidiDispatcher.h"

// Windows (WinMM) implementation of CoreMidiDispatcher.
//
// The macOS file (CoreMidiDispatcher.cpp) hands timestamped packets to
// CoreMIDI, which delivers them precisely from the MIDITimeStamp. WinMM has
// no hardware timestamping -- midiOutShortMsg sends the instant it is called
// -- so this implementation reproduces the same behaviour with a software
// scheduler: the worker thread keeps a deadline-ordered queue of
// future-dated commands and hands each to midiOutShortMsg only when its
// target time actually arrives. This is exactly the "own high-precision
// timer + lock-free queue" fallback the research called for on platforms
// without hardware MIDI scheduling.
//
// The virtual "ResoStage Sync" MIDI source exists on macOS only (CoreMIDI
// virtual endpoints). WinMM has no virtual-device equivalent, so
// enableVirtualSource() reports it unsupported and hasVirtualSource() stays
// false -- the rest of the dispatcher (real destinations + clock) is
// unaffected.

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mmsystem.h>
#pragma comment(lib, "winmm.lib")

#include <algorithm>
#include <chrono>
#include <cstdint>

namespace resostage {

namespace {

uint64_t nowNanos() {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count());
}

void buildMidiBytes(const MidiCommand& cmd, BYTE (&buffer)[3], int& totalBytes) {
    uint8_t statusByte = 0;
    int numDataBytes = 2;
    switch (cmd.kind) {
        case MidiCommandKind::NoteOn: statusByte = static_cast<uint8_t>(0x90 | (cmd.channel & 0x0F)); break;
        case MidiCommandKind::NoteOff: statusByte = static_cast<uint8_t>(0x80 | (cmd.channel & 0x0F)); break;
        case MidiCommandKind::ControlChange: statusByte = static_cast<uint8_t>(0xB0 | (cmd.channel & 0x0F)); break;
        case MidiCommandKind::ProgramChange: statusByte = static_cast<uint8_t>(0xC0 | (cmd.channel & 0x0F)); numDataBytes = 1; break;
        case MidiCommandKind::ClockTick: statusByte = 0xF8; numDataBytes = 0; break;
        case MidiCommandKind::Start: statusByte = 0xFA; numDataBytes = 0; break;
        case MidiCommandKind::Continue: statusByte = 0xFB; numDataBytes = 0; break;
        case MidiCommandKind::Stop: statusByte = 0xFC; numDataBytes = 0; break;
        case MidiCommandKind::SongPositionPointer: statusByte = 0xF2; numDataBytes = 2; break;
    }

    buffer[0] = statusByte;
    totalBytes = 1;
    if (numDataBytes >= 1) {
        buffer[1] = cmd.data1;
        totalBytes = 2;
    }
    if (numDataBytes >= 2) {
        buffer[2] = cmd.data2;
        totalBytes = 3;
    }
}

// Packages a 1-3 byte MIDI message into the 32-bit DWORD WinMM expects:
// byte0 | byte1<<8 | byte2<<16. Real-time system messages (0xF8..0xFF) are
// sent on their own.
DWORD winmmMsg(const uint8_t* bytes, int len) {
    DWORD msg = 0;
    if (len >= 1) msg |= static_cast<DWORD>(bytes[0]);
    if (len >= 2) msg |= static_cast<DWORD>(bytes[1]) << 8;
    if (len >= 3) msg |= static_cast<DWORD>(bytes[2]) << 16;
    return msg;
}

} // namespace

CoreMidiDispatcher::CoreMidiDispatcher() = default;

CoreMidiDispatcher::~CoreMidiDispatcher() {
    stop();
    closeDestination();
    disableVirtualSource();
}

std::vector<std::string> CoreMidiDispatcher::availableDestinationNames() const {
    std::vector<std::string> names;
    const UINT count = midiOutGetNumDevs();
    names.reserve(count);
    for (UINT i = 0; i < count; ++i) {
        MIDIOUTCAPS caps{};
        if (midiOutGetDevCaps(i, &caps, sizeof(caps)) == MMSYSERR_NOERROR) {
            // Wide-char device name -> UTF-8.
            const int len = WideCharToMultiByte(CP_UTF8, 0, caps.szPname, -1, nullptr, 0, nullptr, nullptr);
            std::string name;
            if (len > 0) {
                name.resize(static_cast<size_t>(len) - 1);
                WideCharToMultiByte(CP_UTF8, 0, caps.szPname, -1, name.data(), len, nullptr, nullptr);
            }
            names.push_back(name);
        }
    }
    return names;
}

bool CoreMidiDispatcher::openDestination(const std::string& destinationName, std::string& error) {
    closeDestination();

    const UINT count = midiOutGetNumDevs();
    if (count == 0) {
        error = "No Windows MIDI output devices available";
        return false;
    }

    UINT deviceId = 0;
    bool found = false;
    if (destinationName.empty()) {
        deviceId = 0;
        found = true;
    } else {
        for (UINT i = 0; i < count; ++i) {
            MIDIOUTCAPS caps{};
            if (midiOutGetDevCaps(i, &caps, sizeof(caps)) != MMSYSERR_NOERROR)
                continue;
            const int len = WideCharToMultiByte(CP_UTF8, 0, caps.szPname, -1, nullptr, 0, nullptr, nullptr);
            std::string name;
            if (len > 0) {
                name.resize(static_cast<size_t>(len) - 1);
                WideCharToMultiByte(CP_UTF8, 0, caps.szPname, -1, name.data(), len, nullptr, nullptr);
            }
            if (name == destinationName) {
                deviceId = i;
                found = true;
                break;
            }
        }
    }

    if (!found) {
        error = "Windows MIDI output device not found: " + destinationName;
        return false;
    }

    HMIDIOUT handle = nullptr;
    const MMRESULT res = midiOutOpen(&handle, deviceId, 0, 0, CALLBACK_NULL);
    if (res != MMSYSERR_NOERROR) {
        error = "Failed to open Windows MIDI output device (MMRESULT " + std::to_string(res) + ")";
        return false;
    }
    client = 0;       // unused on Windows
    outputPort = 0;   // unused on Windows
    destination = reinterpret_cast<MidiEndpointRef>(handle);
    return true;
}

void CoreMidiDispatcher::closeDestination() {
    if (destination != 0) {
        midiOutClose(reinterpret_cast<HMIDIOUT>(destination));
        destination = 0;
    }
}

bool CoreMidiDispatcher::enableVirtualSource(std::string& error) {
    // WinMM has no virtual MIDI endpoint. Report unsupported rather than
    // pretending: the rest of the app (real destination + clock) still works.
    error = "Virtual MIDI source is not supported on Windows";
    return false;
}

void CoreMidiDispatcher::disableVirtualSource() {
    virtualSource.store(0, std::memory_order_release);
}

void CoreMidiDispatcher::start() {
    if (running.exchange(true, std::memory_order_acq_rel))
        return;
    worker = std::thread([this] { workerThreadLoop(); });
}

void CoreMidiDispatcher::stop() {
    if (!running.exchange(false, std::memory_order_acq_rel))
        return;
    if (worker.joinable())
        worker.join();
}

bool CoreMidiDispatcher::enqueue(const MidiCommand& cmd) {
    return queue.try_enqueue(cmd);
}

void CoreMidiDispatcher::startClock(double bpm, uint64_t originHostTimeNanos) {
    clockBpm.store(bpm, std::memory_order_relaxed);
    clockOriginHostTimeNanos.store(originHostTimeNanos, std::memory_order_relaxed);
    clockNextTickIndex = 0; // safe: every call site calls this only after a stopClock()
    pendingContinueReanchor.store(false, std::memory_order_relaxed);
    pendingTempoReanchor.store(false, std::memory_order_relaxed);
    lastAnchoredBpm = bpm;
    clockActive.store(true, std::memory_order_release);

    MidiCommand cmd;
    cmd.kind = MidiCommandKind::Start;
    cmd.targetHostTimeNanos = originHostTimeNanos;
    enqueue(cmd);
}

void CoreMidiDispatcher::continueClock(double bpm) {
    clockBpm.store(bpm, std::memory_order_relaxed);
    pendingContinueReanchor.store(true, std::memory_order_relaxed);
    clockActive.store(true, std::memory_order_release);

    MidiCommand cmd;
    cmd.kind = MidiCommandKind::Continue;
    cmd.targetHostTimeNanos = nowNanos();
    enqueue(cmd);
}

void CoreMidiDispatcher::stopClock() {
    clockActive.store(false, std::memory_order_release);

    MidiCommand cmd;
    cmd.kind = MidiCommandKind::Stop;
    cmd.targetHostTimeNanos = nowNanos();
    enqueue(cmd);
}

void CoreMidiDispatcher::setClockBpm(double bpm) {
    clockBpm.store(bpm, std::memory_order_relaxed);
    pendingTempoReanchor.store(true, std::memory_order_relaxed);
}

void CoreMidiDispatcher::sendSongPositionPointer(uint16_t midiBeats) {
    midiBeats &= 0x3FFF; // 14-bit value -- see the header doc comment for the wraparound ceiling

    MidiCommand cmd;
    cmd.kind = MidiCommandKind::SongPositionPointer;
    cmd.data1 = static_cast<uint8_t>(midiBeats & 0x7F);
    cmd.data2 = static_cast<uint8_t>((midiBeats >> 7) & 0x7F);
    cmd.targetHostTimeNanos = nowNanos();
    enqueue(cmd);
}

void CoreMidiDispatcher::sendCommand(const MidiCommand& cmd) {
    const MidiEndpointRef dest = destination;
    if (dest == 0)
        return;

    // Software scheduling: midiOutShortMsg cannot future-date. Anything whose
    // time has not arrived yet waits in the deadline queue; only due commands
    // are handed to the hardware now.
    const uint64_t now = nowNanos();
    if (cmd.targetHostTimeNanos > now) {
        pendingVirtualCommands.push_back(cmd);
        return;
    }

    BYTE buffer[3];
    int totalBytes = 0;
    buildMidiBytes(cmd, buffer, totalBytes);
    midiOutShortMsg(reinterpret_cast<HMIDIOUT>(dest), winmmMsg(buffer, totalBytes));
}

void CoreMidiDispatcher::drainPendingVirtualCommands() {
    if (pendingVirtualCommands.empty())
        return;

    const MidiEndpointRef dest = destination;
    if (dest == 0) {
        pendingVirtualCommands.clear();
        return;
    }

    const uint64_t now = nowNanos();
    while (!pendingVirtualCommands.empty() && pendingVirtualCommands.front().targetHostTimeNanos <= now) {
        const MidiCommand cmd = pendingVirtualCommands.front();
        pendingVirtualCommands.pop_front();

        BYTE buffer[3];
        int totalBytes = 0;
        buildMidiBytes(cmd, buffer, totalBytes);
        midiOutShortMsg(reinterpret_cast<HMIDIOUT>(dest), winmmMsg(buffer, totalBytes));
    }
}

uint64_t CoreMidiDispatcher::nextPendingVirtualDeadlineNanos() const {
    return pendingVirtualCommands.empty() ? 0 : pendingVirtualCommands.front().targetHostTimeNanos;
}

void CoreMidiDispatcher::pumpClock() {
    if (!clockActive.load(std::memory_order_acquire))
        return;

    const double bpm = clockBpm.load(std::memory_order_relaxed);
    if (bpm <= 0.0)
        return;
    // 24 PPQN: one tick every (60s / bpm / 24) seconds.
    const double tickIntervalNanos = (60.0 / bpm / 24.0) * 1.0e9;

    // Reanchor origin in response to continueClock()/setClockBpm(), without
    // touching clockNextTickIndex (this thread owns it exclusively, so no
    // race with the atomic flags set from other threads). Only affects ticks
    // not yet submitted -- ticks already inside the lookahead window keep
    // playing at the tempo they were scheduled with.
    if (pendingContinueReanchor.exchange(false, std::memory_order_acq_rel)) {
        // Resume promptly "now", keeping the tick INDEX (phase-since-Start) unchanged.
        const uint64_t newOrigin = nowNanos() - static_cast<uint64_t>(static_cast<double>(clockNextTickIndex) * tickIntervalNanos);
        clockOriginHostTimeNanos.store(newOrigin, std::memory_order_relaxed);
    } else if (pendingTempoReanchor.exchange(false, std::memory_order_acq_rel)) {
        // Preserve the absolute time of the next unsent tick; only the
        // interval to subsequent ticks changes -- no jump for that next tick.
        const double oldInterval = (60.0 / lastAnchoredBpm / 24.0) * 1.0e9;
        const uint64_t oldOrigin = clockOriginHostTimeNanos.load(std::memory_order_relaxed);
        const uint64_t nextTickTime = oldOrigin + static_cast<uint64_t>(static_cast<double>(clockNextTickIndex) * oldInterval);
        const uint64_t newOrigin = nextTickTime - static_cast<uint64_t>(static_cast<double>(clockNextTickIndex) * tickIntervalNanos);
        clockOriginHostTimeNanos.store(newOrigin, std::memory_order_relaxed);
    }
    lastAnchoredBpm = bpm;

    const uint64_t origin = clockOriginHostTimeNanos.load(std::memory_order_relaxed);

    // Schedule ticks that fall within a 200ms lookahead window. On Windows
    // this just enqueues them into the deadline queue ahead of time; the
    // worker delivers each when due.
    const uint64_t lookaheadNanos = 200'000'000ull;
    const uint64_t horizon = nowNanos() + lookaheadNanos;

    while (true) {
        const uint64_t tickTimeNanos = origin + static_cast<uint64_t>(static_cast<double>(clockNextTickIndex) * tickIntervalNanos);
        if (tickTimeNanos > horizon)
            break;

        MidiCommand cmd;
        cmd.kind = MidiCommandKind::ClockTick;
        cmd.targetHostTimeNanos = tickTimeNanos;
        sendCommand(cmd);
        ++clockNextTickIndex;
    }
}

void CoreMidiDispatcher::workerThreadLoop() {
    while (running.load(std::memory_order_acquire)) {
        MidiCommand cmd;
        while (queue.try_dequeue(cmd)) {
            // The deadline queue must not leak clock ticks after Stop.
            if (cmd.kind == MidiCommandKind::Stop)
                pendingVirtualCommands.clear();
            sendCommand(cmd);
        }

        pumpClock();
        drainPendingVirtualCommands();

        const uint64_t nextVirtualDeadline = nextPendingVirtualDeadlineNanos();
        if (nextVirtualDeadline != 0) {
            // Sleep precisely until the next due MIDI command. Steady_clock
            // and targetHostTimeNanos share the same epoch (both derived from
            // steady_clock in this file), so the delta is exact.
            const uint64_t now = nowNanos();
            const uint64_t wait = nextVirtualDeadline > now ? nextVirtualDeadline - now : 0;
            const auto waitMicros = static_cast<std::chrono::microseconds>(
                std::min<uint64_t>(wait / 1000, 10'000'000ull));
            std::this_thread::sleep_for(waitMicros);
        } else {
            // No due command pending: retain responsive queue servicing for
            // regular MIDI output and transport commands.
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }
}

} // namespace resostage

#endif // _WIN32