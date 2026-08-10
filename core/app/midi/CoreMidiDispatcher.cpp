#include "CoreMidiDispatcher.h"


#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach_time.h>

#include <chrono>

namespace resostage {

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

void buildMidiBytes(const MidiCommand& cmd, Byte (&buffer)[3], ByteCount& totalBytes) {
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

} // namespace

CoreMidiDispatcher::CoreMidiDispatcher() {
    MIDIClientCreate(CFSTR("ResoStage MIDI"), nullptr, nullptr, &client);
    if (client != 0)
        MIDIOutputPortCreate(client, CFSTR("ResoStage Output"), &outputPort);
}

CoreMidiDispatcher::~CoreMidiDispatcher() {
    stop();
    closeDestination();
    disableVirtualSource();
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

bool CoreMidiDispatcher::enableVirtualSource(std::string& error) {
    if (virtualSource.load(std::memory_order_relaxed) != 0)
        return true; // already enabled

    if (client == 0) {
        error = "CoreMIDI client not initialized";
        return false;
    }

    MIDIEndpointRef source = 0;
    const OSStatus status = MIDISourceCreate(client, CFSTR("ResoStage Sync"), &source);
    if (status != noErr) {
        error = "Failed to create virtual MIDI source (OSStatus " + std::to_string(status) + ")";
        return false;
    }
    virtualSource.store(source, std::memory_order_release);
    return true;
}

void CoreMidiDispatcher::disableVirtualSource() {
    const MIDIEndpointRef source = virtualSource.exchange(0, std::memory_order_acq_rel);
    if (source != 0)
        MIDIEndpointDispose(source);
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
    const MIDIEndpointRef virtualSrc = virtualSource.load(std::memory_order_acquire);
    const bool hasRealDestination = destination != 0 && outputPort != 0;
    if (!hasRealDestination && virtualSrc == 0)
        return;

    // MIDIReceived (the virtual-source path below) delivers synchronously
    // the instant it's called -- unlike MIDISend, it has no future-timestamp
    // delivery; CoreMIDI itself schedules a MIDISend's future MIDITimeStamp
    // for real destinations. pumpClock() submits clock ticks up to 200ms
    // ahead of their nominal time (fine for MIDISend), so pushing a
    // future-dated tick straight through MIDIReceived here would land the
    // whole lookahead window as one instantaneous burst instead of evenly
    // spaced ticks -- which breaks a DAW's clock-derived tempo detection
    // even though one-shot messages (Start/Continue/SPP, already "now") land
    // fine. Defer future-dated ones instead; drainPendingVirtualCommands()
    // (called every worker loop iteration, ~2ms) delivers each once its
    // target time actually arrives.
    const uint64_t now = nowNanos();
    const bool deferToVirtual = virtualSrc != 0 && cmd.targetHostTimeNanos > now;
    if (deferToVirtual) {
        // Clock ticks are generated in chronological order. Keep this as a
        // deadline queue so the worker can sleep precisely until the first
        // tick instead of polling every few milliseconds.
        pendingVirtualCommands.push_back(cmd);
        if (!hasRealDestination)
            return;
    }

    Byte buffer[3];
    ByteCount totalBytes = 0;
    buildMidiBytes(cmd, buffer, totalBytes);

    MIDIPacketList packetList;
    MIDIPacket* packet = MIDIPacketListInit(&packetList);
    packet = MIDIPacketListAdd(&packetList, sizeof(packetList), packet, nanosToMachTicks(cmd.targetHostTimeNanos), totalBytes, buffer);
    if (packet == nullptr)
        return;

    if (hasRealDestination)
        MIDISend(outputPort, destination, &packetList);
    if (virtualSrc != 0 && !deferToVirtual)
        MIDIReceived(virtualSrc, &packetList);
}

void CoreMidiDispatcher::drainPendingVirtualCommands() {
    if (pendingVirtualCommands.empty())
        return;

    const MIDIEndpointRef virtualSrc = virtualSource.load(std::memory_order_acquire);
    if (virtualSrc == 0) {
        // Disabled since these were queued -- drop rather than deliver to a
        // disposed endpoint.
        pendingVirtualCommands.clear();
        return;
    }

    const uint64_t now = nowNanos();
    while (!pendingVirtualCommands.empty() && pendingVirtualCommands.front().targetHostTimeNanos <= now) {
        const MidiCommand cmd = pendingVirtualCommands.front();
        pendingVirtualCommands.pop_front();

        Byte buffer[3];
        ByteCount totalBytes = 0;
        buildMidiBytes(cmd, buffer, totalBytes);

        MIDIPacketList packetList;
        MIDIPacket* packet = MIDIPacketListInit(&packetList);
        packet = MIDIPacketListAdd(&packetList, sizeof(packetList), packet, nanosToMachTicks(cmd.targetHostTimeNanos), totalBytes, buffer);
        if (packet != nullptr)
            MIDIReceived(virtualSrc, &packetList);
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
    // Not joined to the audio workgroup -- see streamingIoThreadStart(). This
    // thread's whole job is calling into CoreMIDI, which blocks; a workgroup
    // member that blocks is charged against the audio thread's deadline.

    while (running.load(std::memory_order_acquire)) {
        MidiCommand cmd;
        while (queue.try_dequeue(cmd)) {
            // The 200 ms virtual-source queue must not leak clock ticks after
            // Stop. A physical destination has already received its
            // timestamped packets, but MIDIReceived has not.
            if (cmd.kind == MidiCommandKind::Stop)
                pendingVirtualCommands.clear();
            sendCommand(cmd);
        }

        pumpClock();
        drainPendingVirtualCommands();

        const uint64_t nextVirtualDeadline = nextPendingVirtualDeadlineNanos();
        if (nextVirtualDeadline != 0) {
            // MIDIReceived does not schedule future timestamps itself. The
            // prior 2 ms polling loop meant each 24-PPQN tick could arrive
            // up to a couple of milliseconds late; a DAW estimating tempo
            // from adjacent clock intervals then visibly swung around the
            // actual BPM. mach_wait_until uses the same host-time clock as
            // the MIDI timestamps and wakes at this exact tick deadline.
            mach_wait_until(nanosToMachTicks(nextVirtualDeadline));
        } else {
            // No virtual clock is pending: retain responsive queue servicing
            // for regular MIDI output and transport commands.
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }

}

} // namespace resostage
