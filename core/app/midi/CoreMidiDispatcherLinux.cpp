#include "CoreMidiDispatcher.h"

#if defined(__linux__)

#include <alsa/asoundlib.h>
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

void buildMidiBytes(const MidiCommand& cmd, uint8_t (&buffer)[3], int& totalBytes) {
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

CoreMidiDispatcher::CoreMidiDispatcher() = default;

CoreMidiDispatcher::~CoreMidiDispatcher() {
    stop();
    closeDestination();
    disableVirtualSource();
}

std::vector<std::string> CoreMidiDispatcher::availableDestinationNames() const {
    std::vector<std::string> names;
    snd_seq_t* seq = nullptr;
    if (snd_seq_open(&seq, "default", SND_SEQ_OPEN_OUTPUT, 0) < 0) {
        return names;
    }

    snd_seq_client_info_t* cinfo;
    snd_seq_port_info_t* pinfo;
    snd_seq_client_info_alloca(&cinfo);
    snd_seq_port_info_alloca(&pinfo);

    snd_seq_client_info_set_client(cinfo, -1);
    while (snd_seq_query_next_client(seq, cinfo) >= 0) {
        int c = snd_seq_client_info_get_client(cinfo);
        snd_seq_port_info_set_client(pinfo, c);
        snd_seq_port_info_set_port(pinfo, -1);
        while (snd_seq_query_next_port(seq, pinfo) >= 0) {
            unsigned int caps = snd_seq_port_info_get_capability(pinfo);
            if ((caps & (SND_SEQ_PORT_CAP_WRITE | SND_SEQ_PORT_CAP_SUBS_WRITE)) ==
                (SND_SEQ_PORT_CAP_WRITE | SND_SEQ_PORT_CAP_SUBS_WRITE)) {
                names.push_back(std::string(snd_seq_client_info_get_name(cinfo)) + ": " + snd_seq_port_info_get_name(pinfo));
            }
        }
    }
    snd_seq_close(seq);
    return names;
}

bool CoreMidiDispatcher::openDestination(const std::string& destinationName, std::string& error) {
    (void)destinationName;
    closeDestination();
    snd_seq_t* seq = nullptr;
    if (snd_seq_open(&seq, "default", SND_SEQ_OPEN_OUTPUT, 0) < 0) {
        error = "Failed to open ALSA sequencer";
        return false;
    }
    snd_seq_set_client_name(seq, "ResoStage");
    int port = snd_seq_create_simple_port(seq, "Output",
        SND_SEQ_PORT_CAP_READ | SND_SEQ_PORT_CAP_SUBS_READ,
        SND_SEQ_PORT_TYPE_APPLICATION | SND_SEQ_PORT_TYPE_MIDI_GENERIC);
    if (port < 0) {
        snd_seq_close(seq);
        error = "Failed to create ALSA output port";
        return false;
    }

    client = reinterpret_cast<MidiClientRef>(seq);
    outputPort = static_cast<MidiPortRef>(port);
    destination = 1;
    return true;
}

void CoreMidiDispatcher::closeDestination() {
    if (client != 0) {
        auto* seq = reinterpret_cast<snd_seq_t*>(client);
        snd_seq_close(seq);
        client = 0;
        outputPort = 0;
        destination = 0;
    }
}

bool CoreMidiDispatcher::enableVirtualSource(std::string& error) {
    error = "Virtual MIDI source is not supported on Linux";
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
    clockNextTickIndex = 0;
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
    midiBeats &= 0x3FFF;
    MidiCommand cmd;
    cmd.kind = MidiCommandKind::SongPositionPointer;
    cmd.data1 = static_cast<uint8_t>(midiBeats & 0x7F);
    cmd.data2 = static_cast<uint8_t>((midiBeats >> 7) & 0x7F);
    cmd.targetHostTimeNanos = nowNanos();
    enqueue(cmd);
}

void CoreMidiDispatcher::sendCommand(const MidiCommand& cmd) {
    if (destination == 0)
        return;

    const uint64_t now = nowNanos();
    if (cmd.targetHostTimeNanos > now) {
        pendingVirtualCommands.push_back(cmd);
        return;
    }

    if (client != 0) {
        auto* seq = reinterpret_cast<snd_seq_t*>(client);
        snd_seq_event_t ev;
        snd_seq_ev_clear(&ev);
        snd_seq_ev_set_source(&ev, static_cast<int>(outputPort));
        snd_seq_ev_set_subs(&ev);
        snd_seq_ev_set_direct(&ev);

        uint8_t buf[3];
        int totalBytes = 0;
        buildMidiBytes(cmd, buf, totalBytes);

        if (totalBytes > 0) {
            snd_seq_ev_set_fixed(&ev);
            ev.type = SND_SEQ_EVENT_ECHO;
            snd_seq_event_output(seq, &ev);
            snd_seq_drain_output(seq);
        }
    }
}

void CoreMidiDispatcher::drainPendingVirtualCommands() {
    if (pendingVirtualCommands.empty())
        return;

    if (destination == 0) {
        pendingVirtualCommands.clear();
        return;
    }

    const uint64_t now = nowNanos();
    while (!pendingVirtualCommands.empty() && pendingVirtualCommands.front().targetHostTimeNanos <= now) {
        const MidiCommand cmd = pendingVirtualCommands.front();
        pendingVirtualCommands.pop_front();
        sendCommand(cmd);
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
    const double tickIntervalNanos = (60.0 / bpm / 24.0) * 1.0e9;

    if (pendingContinueReanchor.exchange(false, std::memory_order_acq_rel)) {
        const uint64_t newOrigin = nowNanos() - static_cast<uint64_t>(static_cast<double>(clockNextTickIndex) * tickIntervalNanos);
        clockOriginHostTimeNanos.store(newOrigin, std::memory_order_relaxed);
    } else if (pendingTempoReanchor.exchange(false, std::memory_order_acq_rel)) {
        const double oldInterval = (60.0 / lastAnchoredBpm / 24.0) * 1.0e9;
        const uint64_t oldOrigin = clockOriginHostTimeNanos.load(std::memory_order_relaxed);
        const uint64_t nextTickTime = oldOrigin + static_cast<uint64_t>(static_cast<double>(clockNextTickIndex) * oldInterval);
        const uint64_t newOrigin = nextTickTime - static_cast<uint64_t>(static_cast<double>(clockNextTickIndex) * tickIntervalNanos);
        clockOriginHostTimeNanos.store(newOrigin, std::memory_order_relaxed);
    }
    lastAnchoredBpm = bpm;

    const uint64_t origin = clockOriginHostTimeNanos.load(std::memory_order_relaxed);
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
            if (cmd.kind == MidiCommandKind::Stop)
                pendingVirtualCommands.clear();
            sendCommand(cmd);
        }

        pumpClock();
        drainPendingVirtualCommands();

        const uint64_t nextVirtualDeadline = nextPendingVirtualDeadlineNanos();
        if (nextVirtualDeadline != 0) {
            const uint64_t now = nowNanos();
            const uint64_t wait = nextVirtualDeadline > now ? nextVirtualDeadline - now : 0;
            const auto waitMicros = static_cast<std::chrono::microseconds>(
                std::min<uint64_t>(wait / 1000, 10'000'000ull));
            std::this_thread::sleep_for(waitMicros);
        } else {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }
}

} // namespace resostage

#endif // __linux__
