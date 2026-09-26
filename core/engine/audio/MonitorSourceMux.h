#pragma once

#include <cstdint>
#include <string>
#include <algorithm>

namespace resostage {

/**
 * Transport phase relevant to audio input monitoring and auto-punch.
 */
enum class TransportMonitorPhase : uint8_t {
    Stopped,
    Playback,
    PrePunch,
    PunchRecording,
    PostPunch
};

/**
 * Monitoring backend mode to prevent double/comb-filtered monitor paths
 * when hardware direct monitoring is enabled on the audio interface.
 */
enum class MonitorBackend : uint8_t {
    Software,
    HardwareDirect,
    Disabled
};

/**
 * Effective audio source driving the track strip's DSP insert chain and mixer fader.
 */
enum class MonitorSource : uint8_t {
    Silence,
    Timeline,
    Input,
    TimelinePlusInput
};

/**
 * Prepared monitoring policy for a track.
 */
struct TrackMonitorPolicy {
    std::string trackId;
    bool recordArmed = false;
    bool inputMonitoring = false;
    bool autoInputMonitoring = true;
    MonitorBackend backend = MonitorBackend::Software;
    MonitorSource effectiveSource = MonitorSource::Silence;
    bool captureInput = false;
};

/**
 * Resolves the effective monitor source according to Apple Logic Pro X normative semantics.
 *
 * Truth Table:
 * | R   | I   | AutoInput | Stopped | Pre-Punch (Playing) | Punch (Recording) | Post-Punch (Playing) |
 * |-----|-----|-----------|---------|---------------------|-------------------|----------------------|
 * | off | off | either    | Silence | Timeline            | Timeline          | Timeline             |
 * | off | on  | either    | Input   | Input               | Input             | Input                |
 * | on  | off | on        | Input   | Timeline            | Input             | Timeline             |
 * | on  | off | off       | Input   | TimelinePlusInput   | Input             | TimelinePlusInput    |
 * | on  | on  | either    | Input   | Input               | Input             | Input                |
 */
[[nodiscard]] constexpr MonitorSource computeEffectiveMonitorSource(
    TransportMonitorPhase phase,
    bool recordArmed,
    bool inputMonitoring,
    bool autoInputMonitoring = true,
    MonitorBackend backend = MonitorBackend::Software) noexcept
{
    if (backend != MonitorBackend::Software) {
        if (phase == TransportMonitorPhase::Stopped)
            return MonitorSource::Silence;
        return MonitorSource::Timeline;
    }

    if (phase == TransportMonitorPhase::Stopped) {
        if (recordArmed || inputMonitoring)
            return MonitorSource::Input;
        return MonitorSource::Silence;
    }

    // Input Monitoring [I] explicitly overrides AIM and record state:
    // "forces live input monitoring"
    if (inputMonitoring) {
        return MonitorSource::Input;
    }

    if (!recordArmed) {
        return MonitorSource::Timeline;
    }

    // Track is Record-Armed [R]: source depends on punch/recording phase
    if (phase == TransportMonitorPhase::PunchRecording) {
        return MonitorSource::Input;
    }

    // PrePunch, PostPunch, or standard Playback
    if (autoInputMonitoring) {
        return MonitorSource::Timeline;
    }

    // Rehearsal mode: Auto Input Monitoring disabled, hear both old take and live input
    return MonitorSource::TimelinePlusInput;
}

/**
 * Resolves the coarse transport monitor phase for an audio block.
 */
[[nodiscard]] constexpr TransportMonitorPhase resolveTransportMonitorPhase(
    bool isPlaying,
    bool isRecording,
    bool autoPunchEnabled,
    int64_t blockStartSample,
    int64_t blockEndSample,
    int64_t punchStartSample,
    int64_t punchEndSample) noexcept
{
    if (!isPlaying)
        return TransportMonitorPhase::Stopped;
    if (!isRecording)
        return TransportMonitorPhase::Playback;
    if (!autoPunchEnabled)
        return TransportMonitorPhase::PunchRecording;

    if (blockEndSample <= punchStartSample)
        return TransportMonitorPhase::PrePunch;
    if (blockStartSample >= punchEndSample)
        return TransportMonitorPhase::PostPunch;

    return TransportMonitorPhase::PunchRecording;
}

/**
 * Sub-block descriptor for sample-accurate punch-in and punch-out transitions.
 */
struct PunchSubBlock {
    int offset = 0;
    int length = 0;
    TransportMonitorPhase phase = TransportMonitorPhase::Playback;
};

/**
 * Partitions a block that straddles a punch-in or punch-out boundary into up to 2 sub-blocks.
 */
inline void partitionPunchBlock(
    int64_t blockStartSample,
    int numSamples,
    bool isPlaying,
    bool isRecording,
    bool autoPunchEnabled,
    int64_t punchStartSample,
    int64_t punchEndSample,
    PunchSubBlock subBlocks[2],
    int& subBlockCount) noexcept
{
    if (!isPlaying) {
        subBlocks[0] = {0, numSamples, TransportMonitorPhase::Stopped};
        subBlockCount = 1;
        return;
    }
    if (!isRecording || !autoPunchEnabled) {
        subBlocks[0] = {0, numSamples, isRecording ? TransportMonitorPhase::PunchRecording : TransportMonitorPhase::Playback};
        subBlockCount = 1;
        return;
    }

    const int64_t blockEndSample = blockStartSample + numSamples;

    // Straddles punch-in
    if (punchStartSample > blockStartSample && punchStartSample < blockEndSample) {
        const int split = static_cast<int>(punchStartSample - blockStartSample);
        subBlocks[0] = {0, split, TransportMonitorPhase::PrePunch};
        subBlocks[1] = {split, numSamples - split, TransportMonitorPhase::PunchRecording};
        subBlockCount = 2;
        return;
    }

    // Straddles punch-out
    if (punchEndSample > blockStartSample && punchEndSample < blockEndSample) {
        const int split = static_cast<int>(punchEndSample - blockStartSample);
        subBlocks[0] = {0, split, TransportMonitorPhase::PunchRecording};
        subBlocks[1] = {split, numSamples - split, TransportMonitorPhase::PostPunch};
        subBlockCount = 2;
        return;
    }

    // Wholly before punch
    if (blockEndSample <= punchStartSample) {
        subBlocks[0] = {0, numSamples, TransportMonitorPhase::PrePunch};
        subBlockCount = 1;
        return;
    }

    // Wholly after punch
    if (blockStartSample >= punchEndSample) {
        subBlocks[0] = {0, numSamples, TransportMonitorPhase::PostPunch};
        subBlockCount = 1;
        return;
    }

    // Wholly inside punch
    subBlocks[0] = {0, numSamples, TransportMonitorPhase::PunchRecording};
    subBlockCount = 1;
}

} // namespace resostage
