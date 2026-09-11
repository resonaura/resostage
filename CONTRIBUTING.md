# Contributing to ResoStage

Thank you for your interest in contributing to ResoStage! We welcome bug fixes, real-world stage hardware compatibility testing, and real-time performance optimizations.

---

## 1. Project Governance & Technical Authority

ResoStage is developed under a **Project Lead / Benevolent Dictator** governance model. The Project Lead (**Andrii Vynohradov**) retains sole, unilateral authority over:
- Project vision, technical roadmap, and architecture
- Core audio DSP, zero-allocation real-time safety invariants, and IPC contracts
- Release scheduling, packaging, and distribution
- Accepting, rejecting, requesting changes to, or refactoring any contribution

Contributors are valued community members who volunteer their knowledge and passion. However, contributing to ResoStage does **not** create a partnership, employment, joint venture, or co-ownership relationship. The Project Lead retains sole governance and ownership of the project.

---

## 2. Mandatory Contributor License Agreement (CLA)

To ensure that ResoStage remains permanently free and open source for musicians while allowing the Project Lead to legally defend the project, maintain enterprise dual-licensing, and develop future managed cloud services ("ResoCloud"), **all contributors must accept the [ResoStage Contributor License Agreement](CLA.md) before any Pull Request can be merged.**

### Key Points of the CLA:
- **You Keep Your Copyright:** You retain copyright ownership of your original contribution.
- **Universal License to the Project Lead:** You grant the Project Lead an irrevocable, perpetual, royalty-free license to use, modify, sublicense, and relicense your contribution under both open-source (GPLv3 / AGPLv3) and proprietary commercial licenses.
- **Strictly Voluntary (No Equity / No Revenue Claims):** Contributions are made freely. Contributors acquire no claim to profits, subscription fees, equity, or commercial revenues from the project, custom enterprise builds, or future cloud services.
- **Moral Rights Waiver / Non-Assertion:** Ensures white-label enterprise builds and automated packaging can operate without legal friction.

### How to Sign:
When you open a Pull Request on GitHub, our automated **CLA Assistant bot** will comment with a link to review and electronically accept the CLA in one click. You only need to do this once.

---

## 3. Real-Time Audio Constraints (Zero Allocation)

ResoStage is built for live concert reliability. Code touching the real-time audio thread (`processBlock` and audio callbacks) must adhere strictly to the following invariants:
- **No Heap Allocation:** Zero `new`, `malloc`, `std::vector::push_back`, or string formatting on the audio thread.
- **Lock-Free Concurrency:** Never acquire a `std::mutex`, system lock, or call OS synchronization primitives in the audio path. Use pre-allocated ring buffers (`moodycamel::ReaderWriterQueue`) and atomic flags.
- **Deterministic Latency:** Avoid system calls, disk I/O, or file operations in the audio thread.

---

## 4. Hardware Testing Feedback

We especially value feedback from real live touring environments:
- **Audio Interfaces:** Testing multi-channel output configurations (RME, Focusrite, MOTU, Universal Audio, Behringer) across macOS, Windows (ASIO), and Linux (ALSA/JACK).
- **Stage Lighting Hardware:** Testing DMX-512 USB dongles (FTDI / Enttec), sACN (ANSI E1.31) universes, and Art-Net nodes with physical moving heads and dimmers.
- Please open a GitHub Issue with your rig details, packet captures, or latency telemetry!

---

## 5. Brand & Identity Policy
"ResoStage", "ResoCloud", and the ResoStage logo are brand identifiers and trademarks of Andrii Vynohradov. If you distribute a fork or derivative work, you are required to rebrand and remove all official branding and logos. See [TRADEMARK.md](TRADEMARK.md) for details.
