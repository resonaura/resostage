<img src="https://raw.githubusercontent.com/resonaura/resostage/main/icons/app.png" width="64" alt="ResoStage Icon" />

# ResoStage

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Audio Engine](https://img.shields.io/badge/Native%20Engine-C%2B%2B23%20%7C%20JUCE%209-00599C.svg?logo=cplusplus&logoColor=white)](#technical-architecture)
[![UI](https://img.shields.io/badge/UI-Electron%20%7C%20React%2019-61DAFB.svg?logo=react&logoColor=black)](#technical-architecture)
[![Visualizer](https://img.shields.io/badge/Visualizer-Three.js%20(WebGL)-049EF4.svg?logo=three.js&logoColor=white)](#technical-architecture)
[![Stage Lighting](https://img.shields.io/badge/Stage%20Lighting-DMX--512%20%7C%20sACN%20%7C%20Art--Net-FF8C00.svg)](#stage-lighting--hardware-protocols)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#installation--getting-started)
[![Stage Testing](https://img.shields.io/badge/Stage%20Testing-Public%20Beta-orange.svg)](#-public-beta-physical-dmx--sacn--art-net-hardware-testing)

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor%20on%20GitHub-EA4AAA?logo=github-sponsors&logoColor=white)](https://github.com/sponsors/resonaura)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/resonaura)

Deterministic real-time live performance workstation combining a sample-accurate digital audio engine, multi-protocol stage lighting automation, and 3D stage visualizer.

Built **by a musician for musicians** — designed for touring bands, live electronic performers, and stage technicians who need predictable multitrack playback synchronized with automated lighting fixtures. Reliability depends on the machine, devices, project, and plug-ins; published tests describe specific workloads, not a universal no-dropout guarantee.

<p align="center">
  <img src="https://raw.githubusercontent.com/resonaura/resostage/main/media/resostage-player.png" width="850" alt="ResoStage Live Performance Workstation" />
</p>

---

## Overview

**ResoStage** is a cross-platform live performance workstation combining multitrack playback, editing, mixing, MIDI, and lighting workflows in one locally operated project.

A live rig can otherwise require separate playback, routing, MIDI, lighting, and remote-control tools. ResoStage brings these responsibilities together while keeping the native playback authority separate from the graphical interface.

ResoStage bridges this divide with a unified architecture:

- A **native C++23 / JUCE 9 Core** with prepared buffers and bounded, non-waiting audio work.
- A **separate Electron controller**, so renderer scheduling is not the audio clock, and per-chain helpers that contain live AU/VST3 crashes.
- A **real-time 60 Hz lighting automation engine** outputting synchronized DMX-512, Art-Net, sACN (ANSI E1.31), and direct ESP32 addressable LED strip packets.
- An **interactive 3D stage visualizer** powered by Three.js and WebGL.
- A **local Wi-Fi remote control** interface allowing musicians and FOH engineers to monitor and adjust mixes from phones or tablets on the same venue network.

---

> [!IMPORTANT]
> ### 📢 Public Beta: Physical DMX / sACN / Art-Net Hardware Testing
> The stage lighting subsystem is implemented according to ANSI E1.31 (sACN), Art-Net, and DMX-512 specifications, and is actively seeking community validation on real stage hardware.
>
> If you have physical moving heads, LED bars, USB-DMX interfaces (FTDI / Enttec), or Art-Net/sACN Ethernet nodes, please test ResoStage in your rehearsal space or concert venue! Feedback, packet captures, and issue reports from real physical rigs are warmly welcomed via [GitHub Issues](https://github.com/resonaura/resostage/issues).

---

## Key Highlights

- **Prepared Audio Path**: Core prepares graph, strip, MIDI, and streaming storage outside the callback. Routine allocation, disk I/O, and blocking waits are prohibited on that path.
- **Sample-Based Playback**: Audio and mathematical click use the same hardware sample position. Source resampling and region pitch treatment are prepared/rendered by the native engine.
- **Bounded Concurrency**: Fixed-capacity SPSC/MPMC queues, immutable snapshots, atomics, and bounded `SeqLock` reads connect workers. Routing uses a non-waiting `try_lock`; contention emits a measured silent block rather than waiting for a deadline.
- **Isolated Live Plug-ins**: AU/VST3 serial chains execute in independent helper processes with bounded audio/MIDI IPC and watchdog recovery. Offline vendor code remains in-process; this is not an OS security sandbox.
- **Bounded Streaming**: Workers refill prepared rings and selectively retain source windows. Starvation is reported and becomes silence; no read-ahead policy can guarantee recovery from arbitrary storage stalls.
- **Hardware Lighting Control**: Outputs synchronized 60 Hz fixture control packets across DMX-512, Art-Net, and sACN (ANSI E1.31) over UDP, plus a custom binary protocol driving networked ESP32 microcontrollers with per-pixel gamma correction.
- **Interactive 3D Stage Visualizer**: Real-time 60 FPS WebGL scene powered by Three.js, rendering stage trusses, moving head fixture orientations, and volumetric light cones.
- **Offline-First Operation**: Local playback does not require a cloud service. Local/LAN telemetry provides meters and health diagnostics; it is distinct from analytics sent to an external service.

---

## User Interface Tour

### 1. Live Player & Transport
Dedicated performance screen featuring large, high-visibility timecode and bar/beat counters, song setlist management, transport controls, visual click track, system telemetry (CPU, RAM, buffer underrun counter), dual VU bus meters, and a real-time 3D stage preview.

<p align="center">
  <img src="https://raw.githubusercontent.com/resonaura/resostage/main/media/resostage-player.png" width="850" alt="ResoStage Live Player" />
</p>

### 2. Multitrack Live Mixing Console
Console designed for rapid soundcheck balance adjustments. Features per-stem
faders, physical output channel assignment (e.g. outputs 1/2 for PA, 3/4 for
in-ear monitors, 7/8 for click), send buses, and peak/RMS metering. Current strip
telemetry uses sample peaks, not a certified inter-sample true-peak meter.

<p align="center">
  <img src="https://raw.githubusercontent.com/resonaura/resostage/main/media/resostage-mixer.png" width="850" alt="ResoStage Live Mixer" />
</p>

### 3. Multitrack Waveform & Section Editor
Timeline editor providing waveform views for all stems (Drums, Percussion, Loops, Bass, Guitars, Synths, Keys, Vocals), song sections (Intro, Verse, Chorus), markers, regions, and audio reference tracks.

<p align="center">
  <img src="https://raw.githubusercontent.com/resonaura/resostage/main/media/resostage-editor.png" width="850" alt="ResoStage Timeline Editor" />
</p>

### 4. Stage Lighting & Cue Automation Sequencer
Timeline automation for lighting fixtures synchronized to audio transport ticks. Group fixtures into Left, Right, or Stage-wide arrays, draw decay slopes and color pulses, adjust fade in/out parameters, and preview lighting moves live in the 3D stage inspector.

<p align="center">
  <img src="https://raw.githubusercontent.com/resonaura/resostage/main/media/resostage-lighting.png" width="850" alt="ResoStage Lighting Sequencer" />
</p>

### 5. Audio Engine, Driver & Routing Configuration
Hardware driver configuration uses the JUCE audio backends available in the build, including CoreAudio on macOS and ASIO/WASAPI on Windows. Linux backend availability depends on build dependencies and the host. Sample rates, buffer sizes, and input/output channels are selected from the active driver's capabilities, not a guaranteed fixed range.

<p align="center">
  <img src="https://raw.githubusercontent.com/resonaura/resostage/main/media/resostage-settings.png" width="850" alt="ResoStage Audio Settings" />
</p>

### 6. Calibrated Stage Appearance Themes
High-contrast color palettes specifically measured and tuned for legibility in dark venues, outdoor daylight, and under bright stage lighting rigs (*Default, Sunset, Forest, Purple Haze, Pinky Pie, Sky, Blue Foundation, Mono*).

<p align="center">
  <img src="https://raw.githubusercontent.com/resonaura/resostage/main/media/resostage-themes.png" width="850" alt="ResoStage Stage Themes" />
</p>

### Native Remote Control and Offline Render

The desktop application can control a Core running on another machine from
**Settings → Remote**. Commands and project edits use reliable HTTP requests;
the latency-sensitive playhead, meters, mixer flags, health data, and lighting
preview use a compact sequenced UDP datagram stream. The Remote page reports
the actual source address, receive port, estimated loss, reordered packets,
and jitter instead of treating an HTTP connection as proof that telemetry is
healthy. See [docs/REMOTE_CONTROL.md](docs/REMOTE_CONTROL.md) for ports,
firewall rules, the wire contract, and a two-machine verification checklist.

**Render…** in the Project toolbar performs a background offline audio render
without stopping the live audio device. It can render the entire set or one
song, and can select Main, an individual track, an aux bus, or the metronome.
Output options include 44.1–192 kHz, 16/24-bit PCM or 32-bit float, and a
configurable tail. Renders use the same `MixGraph` and `MixRenderer` as live
playback, so faders, pan, mute/solo, sends, bus routing, fades, loops, speed,
and pitch treatment follow the live mix rather than a parallel approximation.
The bundled media worker also supports AIFF, FLAC, MP3, AAC, ALAC, Opus,
Vorbis, and WMA export. Audio/video import prepares project-local audio and
retains imported video originals; video playback is not implemented yet.
See [docs/FFMPEG.md](docs/FFMPEG.md) for codec, packaging, and validation limits.

---

## Technical Architecture

```text
Electron + React -- HTTP commands --> Core (project/transport authority)
                 <-- UDP telemetry --   |-- audio device and mixing graph
                                         |-- streaming, MIDI, lighting workers
                                         |-- per-chain live plug-in hosts
                                         |-- plug-in scanner (on request)
                                         `-- media converter (import/export)
```

### Real-Time Audio Engine (C++23 / JUCE 9)

The audio device callback advances playback from hardware sample positions.
The message thread publishes immutable routing/state and workers prepare
streams. The callback never waits for files, commands, or plug-in children.
Atomic shared-pointer acquisition and a non-waiting routing `try_lock` are part
of the implementation; the guarantee is bounded/non-waiting, not academically
lock-free. Scheduling boosts are best-effort and platform-specific.
See [AGENTS.md](AGENTS.md) for ownership and real-time invariants and
[the dated performance baseline](docs/performance/DAW_BASELINE.md) for measured
workloads.

### Process Isolation and Helpers

Core and the desktop interface are separate processes. The scanner isolates
vendor enumeration; each non-empty live plug-in chain has its own DSP/editor
host. `Kaishaku` is a small execution helper used to terminate requested PIDs,
not a heartbeat supervisor or a 300-ms UI recovery service. Explicit application
shutdown can still stop Core; process separation is not a promise that every UI
exit preserves playback. See [plug-in containment](docs/PLUGIN_FAILURE_CONTAINMENT.md).

### Stage Lighting & Hardware Protocols
The lighting worker resolves fixture control at a nominal 60 Hz from the
transport/tempo map. Physical delivery rates depend on the output protocol and
hardware; DMX universe refresh limits are not a universal 60-Hz promise.

- **DMX-512**: Serial output via FTDI / USB-DMX interfaces with hardware break timing control.
- **Art-Net & sACN (ANSI E1.31)**: Multicast and unicast UDP packet transmission across multiple universes, supporting moving heads, strobes, and LED bars.
- **Resolight ESP32 Protocol**: Custom binary UDP protocol communicating directly with networked ESP32 microcontrollers running custom firmware (`resolight/firmware`). It drives addressable WS2812B and SK6812 LED strips with per-pixel gamma correction.

### 3D Stage Visualizer & Interface
The frontend runs inside Electron using React 19 and Three.js.

- **Real-Time WebGL Rendering**: Renders full 3D stage setups, truss structures, moving head fixtures, and volumetric light cones.
- **Synchronized Playback**: Native Electron receives sampled UDP telemetry;
  HTTP/WebSocket structural state remains available for lower-rate updates and
  browser control. Rendering speed depends on the machine and scene.
- **Touch & Hardware Control**: MIDI learn and selectable input/output endpoints
  support performance controls. Dedicated motorized-fader feedback profiles
  are not certified by this document.

---

## Installation & Getting Started

### macOS Installation & Gatekeeper Note

ResoStage is an independent open-source project distributed directly to musicians and engineers without an Apple Developer ID certificate ($99/year). Because the application binaries are not notarized by Apple, macOS Gatekeeper may present a warning dialog on first launch (*"ResoStage is damaged and can't be opened"* or *"Cannot open because developer cannot be verified"*).

To remove the macOS quarantine attribute:

#### Option 1: Terminal Command (Instant)
Run the following command in Terminal after copying `ResoStage.app` to your Applications folder:
```bash
xattr -cr /Applications/ResoStage.app
```

#### Option 2: Finder Right-Click
1. In Finder, open `/Applications` and locate `ResoStage.app`.
2. **Right-click (or Control-click)** the app icon and select **Open**.
3. In the confirmation prompt, click **Open Anyway**. macOS will remember this exception permanently.

#### Homebrew (macOS)
```bash
brew tap resonaura/tap
brew install --cask resostage
```

---

## Building from Source

### Prerequisites

- C++23-capable compiler compatible with the pinned native dependencies
- CMake 3.28+
- Node.js 20+ and the pinned pnpm 10 major (`packageManager` in `package.json`)
- Ninja build system

Initial full assembly downloads pinned media runtimes; macOS Apple Silicon
uses build-time Homebrew FFmpeg and relocates its complete non-system library
closure. The installed application does not require Homebrew or a system
FFmpeg. See [media packaging](docs/FFMPEG.md) for per-architecture profiles.

For local macOS microphone consent across rebuilds, create the repository-private
self-signed identity without an Apple account:

```bash
pnpm codesign:setup-local
```

Development otherwise warns and falls back to ad-hoc signing, whose microphone
consent may not persist after rebuilding. Release packaging requires a usable
named distribution identity; local self-signing is not Gatekeeper/notarization.

### 1. Build Native Audio Engine

```bash
# Configure CMake
cmake -B core/build -S core -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo

# Compile binaries
cmake --build core/build --config RelWithDebInfo

# Run automated tests
ctest --test-dir core/build --output-on-failure
```

### 2. Build Frontend & Desktop Application

```bash
# Install dependencies
pnpm install

# Start development environment (core engine + web UI)
pnpm dev

# Assemble the full desktop application without launching
pnpm rebuild

# Build Core only (not the full shipping application)
pnpm app

# Rebuild and produce installer packages
pnpm publish:rebuild
```

---

## 🤝 Contributing & Community Collaboration

ResoStage is built with a deep commitment to open-source software and the live music community. Whether you are a touring musician, an audio DSP engineer, a lighting designer, or a frontend developer — your contributions, real-world venue feedback, and battle-testing are warmly welcomed!

### Areas Where You Can Help

- **Physical Lighting Rigs & Fixture Profiles**:
  Test your physical DMX-512 fixtures, USB-DMX interfaces (Enttec, FTDI), Art-Net, or sACN nodes during soundchecks and rehearsals. Submit PRs with verified fixture JSON profiles, timing reports, or Wireshark packet captures.
- **Real-Time DSP & Audio Engine**:
  Contributions to the C++23 / JUCE 9 Core are welcome. Changes on the audio path
  must preserve bounded work and avoid routine allocation, I/O, and blocking
  waits. Choose SPSC or MPMC queues according to producer ownership; see
  [AGENTS.md](AGENTS.md), rather than assuming every handoff has one producer.
- **Hardware Controller & MIDI Surface Profiles**:
  Add mappings for motorized fader surfaces, MIDI pedalboards, and pad controllers.
- **UI Ergonomics & 3D Stage Visualizer**:
  Enhance the React 19 / Electron frontend, optimize Three.js WebGL rendering, or contribute new high-contrast stage color themes.
- **Translations & Documentation**:
  Help document stage setups, write guides for popular audio interfaces, or translate documentation for local live music communities.

### Collaboration Workflow

1. **Fork the repository** on GitHub.
2. **Create a feature branch** (`git checkout -b feature/amazing-feature`).
3. **Run local tests** to ensure no regressions:
   ```bash
   ctest --test-dir core/build --output-on-failure
   pnpm test
   ```
4. **Commit your changes** with clear commit messages following Conventional Commits.
5. **Sign the CLA**: When you open a Pull Request, our automated CLA Assistant bot will prompt you to review and electronically accept the [ResoStage Contributor License Agreement (CLA)](CLA.md).
6. **Open a Pull Request** explaining what was changed, why, and how it was tested (especially if tested on physical audio or lighting hardware). See [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines.

> [!NOTE]
> All community contributions are incorporated under the **[ResoStage Contributor License Agreement (CLA)](CLA.md)**. The source code is licensed under **[GNU General Public License v3.0 or later (GPLv3+)](LICENSE)**.

---

## 📄 License, Governance & Open Source Philosophy

ResoStage's source code is licensed under the **[GNU General Public License v3.0 or later (GPLv3+)](LICENSE)** with trademark reservations under Section 7(e).

When built with the JUCE 9 framework (distributed under AGPLv3), the resulting combined binary is distributed under the terms of the **GNU Affero General Public License v3.0 (AGPLv3)**.

### 🎵 The Live Stage Guarantee
- **100% Free & Open Source for the Stage**: The core audio engine, multitrack playback, local mixing console, DMX/Art-Net/sACN lighting engine, 3D visualizer, and local Wi-Fi remote control are completely free and open source.
- **No Subscriptions, No Telemetry, No Online Activation**: A concert tool must be rock-solid offline. ResoStage will never require an internet connection on stage.
- **GPLv3 / JUCE Ecosystem**: ResoStage honors the open-source spirit of the audio DSP developer community while protecting against closed-source proprietary commercial forks.

### 🛡️ Brand & Identity Protection
"ResoStage", "ResoCloud", and the ResoStage logo are brand identifiers and trademarks of Andrii Vynohradov. While the source code is open source, branding rights are NOT granted by the open-source license. Any forks or derivative distributions must be renamed and cannot use the official ResoStage name or logos. See **[TRADEMARK.md](TRADEMARK.md)** for details.

### 🌐 Cloud & Multi-City Collaboration Roadmap
Stage-floor and local venue operation will always remain 100% free and open source.

In the future, extended remote collaboration features requiring dedicated managed server infrastructure (such as global NAT traversal / TURN relay clusters for streaming rehearsals between different cities, cloud session backups, and distributed access management) will be introduced as an optional hosted cloud service tier ("ResoCloud"). The desktop client will remain open source and modular, supporting self-hosted endpoints (WebDAV, FTP, custom servers).

### 🏛️ Commercial Dual-Licensing & Enterprise Custom Builds
Enterprise customers (touring companies, audio hardware manufacturers, and stage lighting integrators) requiring customized, white-label, or embedded proprietary builds without copyleft obligations can obtain a commercial license. Inquiries: [andrii.vynohradov@gmail.com](mailto:andrii.vynohradov@gmail.com).

---

## Author & Support

Created and maintained by **Andrii Vynohradov ([@resonaura](https://github.com/resonaura))**.

- **Personal Portfolio**: [vynohradov.ca](https://vynohradov.ca) • [rsnra.link](https://rsnra.link)
- **LinkedIn**: [linkedin.com/in/resonaura](https://linkedin.com/in/resonaura)
- **Email**: [andrii.vynohradov@gmail.com](mailto:andrii.vynohradov@gmail.com)

If you find ResoStage useful for your concerts, rehearsals, or live rigs, consider supporting ongoing development:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor%20on%20GitHub-EA4AAA?logo=github-sponsors&logoColor=white)](https://github.com/sponsors/resonaura)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/resonaura)
