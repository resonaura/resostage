# ResoStage DAW Architecture: Performance Baseline

This document records the empirical baseline measurements of ResoStage before expanding into the full DAW architecture. Every subsequent performance-sensitive change must measure before and after on equivalent workloads.

## Test Environment

- **Date**: 2026-09-24
- **Operating System**: macOS Darwin 24.x (macOS Sonoma/Sequoia)
- **Machine**: Apple M1 (8 cores, 4 performance + 4 efficiency)
- **Total Physical Memory**: 8 GB (8,589,934,592 bytes)
- **Audio Device**: CoreAudio virtual / hardware endpoint
- **Sample Rate**: 48,000 Hz
- **Build Type**: `RelWithDebInfo` (`-O2 -g`)
- **Git Commit**: `5ef04ee35370351ed2dc71fe10f458b2e4ca9dc8`

---

## 1. MixRenderer Callback Execution Timing

Test setup: Canonical live graph with 8 audio tracks, 2 aux sends, 1 main output bus, and physical output lanes. All tracks routed to main and sends, all sends routed to main. Measured over 1,000 blocks per trial.

| Block Size (frames) | Hardware Deadline | Average Callback Time | % of Audio Deadline | Status |
|:---|:---|:---|:---|:---|
| **64** | 1,333.33 µs | 1.10 µs | **0.083%** | PASS (< 5%) |
| **128** | 2,666.67 µs | 2.97 µs | **0.112%** | PASS (< 5%) |
| **256** | 5,333.33 µs | 4.24 µs | **0.080%** | PASS (< 5%) |
| **512** | 10,666.67 µs | 8.07 µs | **0.076%** | PASS (< 5%) |
| **1024** | 21,333.33 µs | 16.61 µs | **0.078%** | PASS (< 5%) |

---

## 2. Insert Plug-in Chain Overhead

Test setup: 8 audio tracks each hosting an active plug-in processor node (measuring stack-allocated buffer setup, parameter interpolation, and block dispatch). Block size = 256 frames.

| Configuration | Block Size | Hardware Deadline | Average Callback Time | % of Audio Deadline |
|:---|:---|:---|:---|:---|
| **8 Active Inserts** | 256 frames | 5,333.33 µs | **3.65 µs** | **0.068%** |

---

## 3. Real-Time DSP Throughput

Continuous evaluation of 1,024,000 samples in single-threaded audio processing:

| DSP Component | Measured Time (1M samples) | Throughput | Allocation Count |
|:---|:---|:---|:---|
| **`AutomationEnvelope::evaluateBlock`** | 7.74 ms | **132.36 MSamples/sec** | **0** (stack memory only) |
| **`EnvelopeFollower::process`** | 4.48 ms | **228.69 MSamples/sec** | **0** (stack memory only) |

---

## 4. Real-Time Invariants Compliance

- **Audio Callback Allocations**: Strictly 0 heap allocations during `audioDeviceIOCallbackWithContext`.
- **Audio Callback Locking**: Bounded non-waiting `try_lock` on `routingMutex`; zero blocking mutex acquisitions.
- **Audio Callback File/Network I/O**: Strictly 0 disk or socket operations in callback.
- **Test Suite Status**: 404/404 unit/stress/performance tests passed (148,012 assertions).
- **UI Test Suite Status**: 29/29 files passed (265 tests passed).
- **Electron Shell Test Suite Status**: 2/2 files passed (25 tests passed).
