#include "CoreMidiDispatcher.h"

#include "../platform/AudioWorkgroup.h"

#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach_time.h>

#include <chrono>

namespace resoset {

namespace {

std::string cfStringToStd(CFStringRef ref) {
    if (ref == nullptr)
        return {};
    const CFIndex length = CFStringGetLength(ref);
    const CFIndex maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
    std::vector<char> buffer(static_cast<size_t>(maxSize));
    if (CFStringGetCString(ref, buffer.data(), maxSize, kCFStringEncodingUTF8))
        return std::string(buffer.data());
    return {};
}

uint64_t nanosToMachTicks(uint64_t nanos) {
    static const mach_timebase_info_data_t timebase = [] {
        mach_timebase_info_data_t info{};
        mach_timebase_info(&info);
        return info;
    }();
    if (timebase.numer == 0)
        return nanos;
    return static_cast<uint64_t>((static_cast<__uint128_t>(nanos) * timebase.denom) / timebase.numer);
}

uint64_t nowNanos() {
    static const mach_timebase_info_data_t timebase = [] {
        mach_timebase_info_data_t info{};
        mach_timebase_info(&info);
        return info;
    }();
    const uint64_t ticks = mach_absolute_time();
    return static_cast<uint64_t>((static_cast<__uint128_t>(ticks) * timebase.numer) / timebase.denom);
}

} // namespace

CoreMidiDispatcher::CoreMidiDispatcher() {
    MIDIClientCreate(CFSTR("Resoset ResoStage"), nullptr, nullptr, &client);
    if (client != 0)
        MIDIOutputPortCreate(client, CFSTR("Resoset Output"), &outputPort);
}

CoreMidiDispatcher::~CoreMidiDispatcher() {
    stop();
    closeDestination();
    if (outputPort != 0)
        MIDIPortDispose(outputPort);
    if (client != 0)
        MIDIClientDispose(client);
}

std::vector<std::string> CoreMidiDispatcher::availableDestinationNames() const {
    std::vector<std::string> names;
    const ItemCount count = MIDIGetNumberOfDestinations();
    names.reserve(count);
    for (ItemCount i = 0; i < count; ++i) {
        MIDIEndpointRef dest = MIDIGetDestination(i);
        CFStringRef nameRef = nullptr;
        MIDIObjectGetStringProperty(dest, kMIDIPropertyName, &nameRef);
        names.push_back(cfStringToStd(nameRef));
        if (nameRef != nullptr)
            CFRelease(nameRef);
    }
    return names;
}

bool CoreMidiDispatcher::openDestination(const std::string& destinationName, std::string& error) {
    closeDestination();

    const ItemCount count = MIDIGetNumberOfDestinations();
    if (count == 0) {
        error = "No CoreMIDI destinations available";
        return false;
    }

    if (destinationName.empty()) {
        destination = MIDIGetDestination(0);
        return true;
    }

    for (ItemCount i = 0; i < count; ++i) {
        MIDIEndpointRef dest = MIDIGetDestination(i);
        CFStringRef nameRef = nullptr;
        MIDIObjectGetStringProperty(dest, kMIDIPropertyName, &nameRef);
        const std::string name = cfStringToStd(nameRef);
        if (nameRef != nullptr)
            CFRelease(nameRef);
        if (name == destinationName) {
            destination = dest;
            return true;
        }
    }

    error = "CoreMIDI destination not found: " + destinationName;
    return false;
}

void CoreMidiDispatcher::closeDestination() {
    destination = 0;
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
    clockNextTickIndex = 0;
    clockActive.store(true, std::memory_order_release);
}

void CoreMidiDispatcher::stopClock() {
    clockActive.store(false, std::memory_order_release);
}

void CoreMidiDispatcher::setClockBpm(double bpm) {
    clockBpm.store(bpm, std::memory_order_relaxed);
}

void CoreMidiDispatcher::sendCommand(const MidiCommand& cmd) {
    if (destination == 0 || outputPort == 0)
        return;

    uint8_t statusByte = 0;
    int numDataBytes = 2;
    switch (cmd.kind) {
        case MidiCommandKind::NoteOn: statusByte = static_cast<uint8_t>(0x90 | (cmd.channel & 0x0F)); break;
        case MidiCommandKind::NoteOff: statusByte = static_cast<uint8_t>(0x80 | (cmd.channel & 0x0F)); break;
        case MidiCommandKind::ControlChange: statusByte = static_cast<uint8_t>(0xB0 | (cmd.channel & 0x0F)); break;
        case MidiCommandKind::ProgramChange: statusByte = static_cast<uint8_t>(0xC0 | (cmd.channel & 0x0F)); numDataBytes = 1; break;
        case MidiCommandKind::ClockTick: statusByte = 0xF8; numDataBytes = 0; break;
    }

    Byte buffer[3];
    buffer[0] = statusByte;
    ByteCount totalBytes = 1;
    if (numDataBytes >= 1) {
        buffer[1] = cmd.data1;
        totalBytes = 2;
    }
    if (numDataBytes >= 2) {
        buffer[2] = cmd.data2;
        totalBytes = 3;
    }

    MIDIPacketList packetList;
    MIDIPacket* packet = MIDIPacketListInit(&packetList);
    packet = MIDIPacketListAdd(&packetList, sizeof(packetList), packet, nanosToMachTicks(cmd.targetHostTimeNanos), totalBytes, buffer);
    if (packet != nullptr)
        MIDISend(outputPort, destination, &packetList);
}

void CoreMidiDispatcher::pumpClock() {
    if (!clockActive.load(std::memory_order_acquire))
        return;

    const double bpm = clockBpm.load(std::memory_order_relaxed);
    if (bpm <= 0.0)
        return;
    const uint64_t origin = clockOriginHostTimeNanos.load(std::memory_order_relaxed);

    // 24 PPQN: one tick every (60s / bpm / 24) seconds.
    const double tickIntervalNanos = (60.0 / bpm / 24.0) * 1.0e9;

    // Schedule ticks that fall within a 200ms lookahead window, matching the
    // "pre-schedule ahead of time" pattern -- CoreMIDI's own timestamp
    // delivers them precisely; we just need to submit with lead time.
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
    joinCurrentThreadToDefaultOutputWorkgroup();

    while (running.load(std::memory_order_acquire)) {
        MidiCommand cmd;
        while (queue.try_dequeue(cmd))
            sendCommand(cmd);

        pumpClock();

        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }

    // MUST happen before this thread returns/exits -- macOS's pthread TSD
    // cleanup crashes (SIGTRAP in _os_workgroup_tsd_cleanup) on a thread that
    // exits while still joined to an os_workgroup. This thread is joined by
    // stop() (called from ~AudioEngine() on app quit), so this genuinely
    // runs, not just in theory.
    leaveCurrentThreadWorkgroupIfJoined();
}

} // namespace resoset
