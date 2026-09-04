# ResoStage

Real-time live performance workstation combining a sample-accurate digital audio engine, multi-protocol stage lighting generator, and 3D stage visualizer.

The system runs on macOS, Windows, and Linux. It targets touring bands, live electronic performers, and stage technicians who need zero-dropout multitrack playback synchronized with automated lighting fixtures.

---

## Technical Architecture

### Real-Time Audio Engine (C++20 / JUCE 9)

Audio processing runs on a dedicated high-priority thread isolated from the operating system UI scheduler. The audio callback operates under a strict zero-heap-allocation policy: all buffers, mix graphs, and voice states are pre-allocated during project initialization.

- **Sample-Accurate Resampling**: Pitch-shifting and time-stretching run through a precomputed 64-point Kaiser-windowed Sinc interpolator. This eliminates harmonic aliasing while keeping CPU overhead below 2% per voice at 96 kHz.
- **Lock-Free Concurrency**: Audio threads communicate with background workers using single-producer single-consumer (SPSC) lock-free ring buffers and atomic state flags. Mutex locks and system calls never enter the rendering path.
- **Disk I/O Pressure Management**: Multitrack audio streams pull from background ring buffers monitored by an adaptive I/O pressure policy. If disk read stalls occur on slow external drives, the engine expands read-ahead windows before starvation can hit the DAC.
- **Thread Scheduling**: The engine requests real-time OS privileges on startup (`AudioUnit` high-priority workgroups on macOS, `THREAD_PRIORITY_TIME_CRITICAL` on Windows, and `SCHED_FIFO` via RTKit on Linux).

### Process Supervision & Crash Isolation (Kaishaku)

Live performance software cannot drop audio if a graphic render stalls or an Electron window crashes. ResoStage isolates the interface from the audio core using a native supervisor daemon named `kaishaku`.

- The supervisor runs as an independent OS process linked to the audio engine and UI shell through local IPC heartbeat channels.
- If the graphical interface terminates unexpectedly, the audio engine continues playback without interruption.
- `kaishaku` restarts the interface process and repopulates the active project state within 300 milliseconds.

### Stage Lighting & Hardware Protocols

The lighting subsystem generates and transmits fixture control data at a steady 60 Hz refresh rate, synchronized to audio transport ticks and musical tempo maps.

- **DMX-512**: Serial output via FTDI / USB-DMX interfaces with hardware break timing control.
- **Art-Net & sACN (E1.31)**: Multicast and unicast UDP packet transmission across multiple universes, supporting moving heads, strobes, and LED bars.
- **Resolight ESP32 Protocol**: Custom binary UDP protocol communicating directly with networked ESP32 microcontrollers running custom firmware (`resolight/firmware`). It drives long addressable WS2812B and SK6812 LED strips with per-pixel gamma correction.

### 3D Stage Visualizer & Interface

The frontend runs inside Electron using React 19 and Three.js.

- **Real-Time WebGL Rendering**: Renders full 3D stage setups, truss structures, moving head fixtures, and volumetric light cones.
- **Synchronized Playback**: The 3D viewport updates at 60 frames per second using state broadcasts from the C++ core over local WebSocket connections.
- **Touch & Hardware Control**: Supports bi-directional MIDI control surfaces with motorized fader feedback and touch-friendly live operation layouts.

---

## Building and Testing

### Prerequisites

- C++20 compliant compiler (Clang 16+, GCC 13+, or MSVC 2022)
- CMake 3.25+
- Node.js 20+ and pnpm 10+
- Ninja build system

### Core Audio Engine

```bash
# Configure CMake
cmake -B core/build -S core -G Ninja -DCMAKE_BUILD_TYPE=Release

# Compile binaries
cmake --build core/build --config Release

# Run automated tests
ctest --test-dir core/build --output-on-failure
```

### Interface & Full Application

```bash
# Install dependencies
pnpm install

# Start development environment (core engine + UI)
pnpm dev

# Package production application
pnpm build:app
```

---

## Status & License

Proprietary private codebase. Internal development only.
