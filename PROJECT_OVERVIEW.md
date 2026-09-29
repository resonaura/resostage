# ResoStage: Product and Project Overview

**Purpose of this document:** Give a technically informed reader a clear, honest picture of what ResoStage is, what it is trying to become, how it is built, where it may stand out, what is already implemented, and what still needs proof or development. This is a project overview, not a market study, legal opinion, or promise of future features.

**Status reference:** This document reflects repository documentation available on 2026-09-29. Implementation changes over time. For feature status, the source code, tests, release notes, and the most specific current status documents take precedence over this overview.

---

## 1. In one paragraph

ResoStage is an open-source, cross-platform workstation for live music and stage operation. Its central idea is to bring several tasks that are often split across separate applications into one locally operated system: multitrack playback and mixing, MIDI and timeline control, audio routing and recording, lighting cues and network lighting protocols, stage visualization, and remote control from another computer on the venue network. A native C++/JUCE Core owns playback and show state; an Electron and React application provides the operator interface. The project is designed to work locally without requiring a cloud service. The author’s current direction is to keep the performance-critical local product free and open source, while exploring optional hosted services for features whose value and ongoing cost come from internet infrastructure. That direction is a product intention; ResoCloud is a roadmap concept, not a currently available service.

## 2. What problem is ResoStage trying to solve?

A live show can depend on a collection of loosely connected tools: a multitrack player or DAW for backing tracks, a mixer or routing interface for stems, MIDI utilities for cues, a separate lighting application or console, and a phone or tablet for remote adjustments. Each tool can be capable on its own, but the operator still has to prepare, connect, synchronize, and troubleshoot the whole chain.

ResoStage aims to reduce that fragmentation for performers and small production teams who need software playback and show control to work together. In its intended workflow, the same project can contain audio or MIDI material, transport and arrangement information, mix routing, and lighting-related content. The operator can adjust the local show from the main application and, in supported remote setups, control a Core running on a separate playback computer.

This does not mean ResoStage replaces every professional DAW, theatre cue system, lighting console, or dedicated playback product. Those products may have years of workflow refinement, broad hardware support, mature ecosystems, or features outside ResoStage’s scope. The practical opportunity is narrower and more specific: offer a cohesive, inspectable, locally usable tool for people who want audio and show-control tasks to live closer together.

## 3. Intended users and situations

The project materials describe ResoStage for live performers, touring bands, live electronic musicians, and stage technicians. Plausible use cases include:

- A band plays prepared stems while retaining per-track level, pan, bus, and physical-output control.
- A performer uses MIDI and plug-in instruments alongside arranged playback.
- A small production coordinates playback with lighting cues and previews the stage layout in 3D.
- A playback computer stays near the audio hardware while a controller computer operates the show over a local network.
- A user prepares a project, renders files, or edits arrangements without requiring a remote service.

These are target scenarios, not evidence that every workflow has been validated with a broad range of users or hardware. The README explicitly calls for community testing with physical lighting rigs. A careful public description should say who the software is for and invite testing, rather than imply that every venue, interface, fixture, or touring workflow is already certified.

## 4. Product shape: three cooperating layers

The repository’s engineering guide describes a three-layer application:

### Core

`core/` contains authoritative application and show state. It owns audio-device integration, the playback engine, project data, transport, mixing, streaming, MIDI and event work, lighting, HTTP control, and telemetry production. Core is the show authority: the UI observes and commands it but is not required to be the transport clock.

### Electron shell

`electron/` owns the desktop window, native operating-system integration, process orchestration, remote discovery and connection handling, HTTP command proxying, and UDP telemetry reception. It exposes a limited preload API to the renderer.

### React interface

`ui/` contains the editing and monitoring experience. It presents project state, transport, mixer, timeline, settings, and visual feedback. The UI is deliberately not the real-time authority. The design goal is that a stalled or disconnected renderer should not become the component responsible for keeping audio or lighting time.

The normal local deployment is Electron connected to a local Core process. In remote mode, the controller runs on one computer while Core and the audio hardware remain on the playback computer. The architecture therefore separates a **control surface** from the **machine that owns the performance**.

## 5. What the product includes

The following is a functional map drawn from the repository’s architecture guide and feature documents. It is not a claim that every feature has the same degree of polish, hardware validation, or release maturity.

### 5.1 Audio playback, recording, mixing, and routing

ResoStage has a native multitrack audio engine with project transport, audio regions, streaming workers, mixing, routing, meters, and physical output lanes. Audio is prepared outside the device callback and delivered through bounded ring buffers. The mixer graph is compiled into an immutable representation that can be rendered in a forward pass. Track streams are pulled once per callback and can then feed multiple routes.

The project model covers audio, instrument, MIDI, external MIDI, lighting, folder, and bus-timeline concepts. The user-facing system includes track and mixer controls, buses and sends, physical output assignment, record arming and input monitoring, and arrangement editing. Audio recording uses a callback-to-worker path: the real-time side writes bounded planar frames, while an asynchronous worker finalizes files and project regions. Offline rendering uses the production graph and renderer against a project snapshot rather than stopping live transport or entering the device callback.

The design includes fades, looping, speed and pitch treatments, automation, metering, and plug-in processing. Per-track pan-law choices are persisted and shared by live/offline mixing. Plug-in parameter lanes can be selected from the plug-in's exposed parameter list and edited with a point curve. Automation is still narrower than a mature DAW: general-purpose strip/fader/pan automation editing and a full arrangement automation mode remain unfinished.

### 5.2 MIDI and instruments

The project supports MIDI regions and instrument tracks, scheduled MIDI events, plug-in instruments, MIDI capture, focused-track audition, and MIDI editing. Core handles event timing; the UI receives published state rather than reading callback-owned counters directly.

Some MIDI 2.0 work is present, but the repository’s `docs/MIDI2_REMAINING_WORK.md` is explicit about the boundaries. MIDI Clip File (`.midi2`) support and project persistence for a subset of MIDI 2.0 data do not mean that the full application has end-to-end MIDI 2.0 hardware and plug-in support. Live MIDI I/O is currently MIDI 1.0; native UMP endpoint handling and several expressive MIDI 2.0 paths remain future work. Claims should name the actual supported formats and paths rather than simply say “full MIDI 2.0 support.”

### 5.3 Lighting and visual feedback

The lighting system is designed to resolve cues and effects on a worker and send output through supported stage-lighting routes. Repository documentation covers DMX-512, Art-Net, and sACN (ANSI E1.31), and the README seeks validation with physical fixtures, interfaces, and network nodes. The project also contains a 3D stage visualizer intended to help an operator inspect fixture positions and lighting states.

The combination of playback, lighting control, and a visual stage view is one of the clearest product-level distinctions to investigate. Its practical value depends on the fixtures, interfaces, network configuration, and operator workflow actually working together. Physical validation matters: standards support and a virtual preview alone do not establish interoperability with every real rig.

The repository includes `resolight/firmware/` for ESP32/ESP8266-based addressable LED control. This points to an extensible connection between show software and small custom lighting hardware, while also creating another hardware and support surface to validate.

### 5.4 Remote control

The documented native remote mode separates command delivery from live telemetry:

- Commands and edits use HTTP/TCP, where delivery and ordering matter.
- Frequently sampled state such as playhead, meters, health, and lighting preview uses UDP, where fresh state is more useful than retrying stale frames.
- LAN discovery announces available Core nodes.

The controller subscribes to a Core-selected UDP destination and renews that subscription. Electron validates packet source, protocol header, length, and sequence ordering before data reaches the renderer. The remote-control document includes a two-machine verification procedure and describes offline rendering on the active Core, including when that Core is remote.

This is more concrete than a generic claim of “cloud control”: it is a documented local-network controller/playback topology. It does not imply that secure internet access, global NAT traversal, hosted relay, or remote collaboration between cities is already shipped.

### 5.5 ResoLink and multi-Core synchronization

`docs/architecture/RESOLINK_PROTOCOL.md` describes a more ambitious Core-to-Core session protocol for synchronized machines, redundant playback, and possibly remote instrument execution. That document marks the work `IN_PROGRESS` and describes protocol direction and design. It should be presented as research or roadmap, not as a finished capability of the current product. Do not conflate ResoLink with the implemented Electron-to-Core remote control path.

### 5.6 Plug-ins

ResoStage includes plug-in scanning and live AU/VST3 hosting workflows. Both discovery and live DSP run outside Core: the scanner helper owns enumeration, and a separate helper process owns each non-empty live serial plug-in chain. A native fault or hang therefore takes down that chain rather than unwinding through Core or unrelated chains. A bounded shared-memory protocol transports audio, MIDI, parameters, and transport state; a watchdog can make one automatic restart attempt. This is process isolation, not a reduced-permission security sandbox, and a plug-in may still affect resources available to the current user.

Offline render deliberately owns a separate in-process processor bank so it can give plug-ins non-realtime render context. A native offline plug-in crash is not contained by the live-host boundary. Exact behavior, protocol limits, and recovery scope are documented in `docs/PLUGIN_FAILURE_CONTAINMENT.md`.

## 6. Why the engineering approach is relevant to live use

The most important engineering choice is ownership: the audio engine, not the React interface, owns sample-time playback and authoritative state. A concert system should not depend on a browser animation loop to advance the musical clock.

The callback is designed around bounded work:

- File and network I/O happen outside the callback.
- Streaming workers fill fixed-capacity audio rings ahead of playback.
- Mix graphs and much of the per-track working memory are prepared before use.
- Immutable snapshots let a callback observe a coherent graph for a block.
- Event and lighting work communicate through bounded queues.
- Telemetry is sampled and latest-wins rather than a high-frequency full-state JSON broadcast.
- If routing state cannot be safely acquired, the callback does not wait on the routing mutex; it services the device with silence and records the failure mode.

That last detail is important to describe accurately. `AGENTS.md` explicitly says not to call the callback academically 100% lock-free: it uses atomic shared-pointer snapshot acquisition and a non-waiting `try_lock` on the routing mutex. The operational design target is **bounded and non-waiting**, with a safe failure mode when restaging conflicts with a callback. This is a meaningful real-time design, but it is not the same claim as “no locks exist anywhere in the callback” or “dropouts are impossible.”

The repository also keeps failure counters and timing measurements for callback load, stream starvation, silent blocks, and network telemetry. That observability is useful because live reliability is not a slogan; it is something that needs to be measured on relevant hardware and under realistic show loads.

## 7. What performance evidence exists—and what it does not prove

`docs/performance/DAW_BASELINE.md` records a benchmark dated 2026-09-24 on an Apple M1, macOS Darwin 24.x, at 48 kHz, using a `RelWithDebInfo` build. The document reports measurements for a synthetic/canonical graph with eight audio tracks, two aux sends, a main bus, and physical output lanes, plus a limited plug-in-dispatch scenario. It reports zero callback heap allocations in that test setup and 404 native tests passing at that commit, together with UI and Electron test results.

These results are useful engineering evidence for the tested code and workload. They are not a guarantee of “zero dropouts” in all projects, on all machines, or with arbitrary plug-ins. A renderer microbenchmark is not the same as an end-to-end hardware test with a specific audio interface, real files, MIDI, lighting traffic, and vendor plug-ins. The benchmark records a specific commit and machine; it should be updated and expanded before being used as a broad marketing guarantee.

Good next evidence for a live product would include repeatable full-application workloads, exact hardware and driver details, long-duration runs, real audio and lighting equipment, failure injection, and a public explanation of what each test does and does not cover. The product can be technically ambitious while describing its current evidence modestly.

## 8. The product distinction: a rare combination, not an unsupported “only” claim

ResoStage’s strongest positioning is likely the way it brings together several functions in one open-source, local-first project:

1. A native multitrack playback and mixing core.
2. Arrangement, MIDI, recording, and instrument workflows.
3. Lighting cue resolution and DMX/network lighting protocols.
4. A 3D view of the stage and fixtures.
5. A controller/playback split that can operate across two computers on a local network.
6. A development model in which the project can be inspected and built from source.

Any one of these areas has established products and mature alternatives. The possible distinction is the integrated combination and the product philosophy around local operation. That is a reasonable hypothesis to research and demonstrate. It is not yet grounds to say ResoStage is the first, only, best, or uniquely capable system in the market. Theatre show-control products, DAWs with external control, playback tools with MIDI or lighting integrations, and custom production systems may overlap in important ways.

The useful comparison question is therefore not “Does any competitor have any of these features?” It is: “For a clearly defined live workflow, what does ResoStage let an operator prepare and run from one project that would otherwise require multiple tools—and what trade-offs does that create?” A future market comparison should evaluate concrete tasks, supported hardware, maturity, platform availability, pricing, and operational reliability from current primary sources.

## 9. Why keep the local product free and open source?

The project’s stated philosophy is that a show should not stop working because the venue has no internet, an account cannot be reached, or a subscription has lapsed. README describes the core performance system and local remote control as free and open source and says show operation should not require internet access, online activation, or a subscription.

That is both a user promise and a product design principle. It has practical value for live environments where connectivity is uncertain and the show must remain under the operator’s control. Open source also lets users inspect how the software works, report issues with evidence, build it themselves, and potentially contribute fixes or hardware knowledge.

The most credible explanation is not that every part of ResoStage has no cost to maintain. Development, packaging, support, testing, and compatibility work all take time. Rather, the product can make a deliberate boundary:

- Keep local playback, mixing, show operation, and project access usable without paid accounts or hosted infrastructure.
- Charge only for optional services that create recurring infrastructure costs or provide ongoing hosted value.
- Keep cloud services out of the critical path for a local performance.
- Make the business model understandable before users entrust the product with show files or projects.

This is a direction that should be confirmed by the project owner and implemented consistently. A public promise such as “local shows remain free and work without internet” should be made only if the project is prepared to treat it as a durable commitment.

## 10. ResoCloud and possible sustainability

The README describes ResoCloud as a future, optional hosted tier. Examples include cloud session backups, distributed access management, global NAT traversal or relay infrastructure, and collaboration or rehearsal connections across cities. These ideas are not documented as an existing service. They have different technical and cost profiles, and each needs product validation before being bundled into a subscription.

The strategic logic is straightforward: local software and open-source development can build trust and reach; a hosted service can earn revenue where customers want the convenience of managed storage, identity, relay, or collaboration and where the operator must pay continuing server and bandwidth bills. The cloud service should add a convenience or capability that genuinely depends on managed infrastructure, rather than withhold a local feature to force an upgrade.

Reasonable candidates to investigate—not promises—include:

- Encrypted or otherwise carefully protected project backup and version history.
- Team membership, invitations, and access administration.
- Managed relay/NAT traversal for remote sessions that cannot use a direct connection.
- Rehearsal streaming or synchronized collaboration where bandwidth and relay capacity have real operating costs.
- Hosted project sharing and review workflows.

Before choosing a business model, the author would need to estimate storage, egress bandwidth, relay time, support cost, security and privacy obligations, and the number of active teams required for a service to be sustainable. Pricing should follow a clear cost or value unit—such as storage, team size, or relay usage—rather than an arbitrary paywall around core show playback.

Self-hosted options are mentioned in the README as a design direction, but any specific backend compatibility should be treated as a future capability unless it is implemented and documented. Users should be able to understand where project data lives, how to export it, what the service can access, and what happens if the service is discontinued.

## 11. The developer and the wider portfolio

The repository identifies **Andrii Vynohradov**, publishing as **Resonaura**, as creator and maintainer. ResoStage can serve two purposes at once: it can be a useful product for performers, and it can be a public, inspectable body of engineering work. Its architecture touches real-time C++, audio DSP, concurrency, networking, user-interface design, hardware protocols, project serialization, packaging, and technical documentation.

That makes the project a credible way to demonstrate engineering judgment—especially when the presentation includes working builds, code, clear limitations, real hardware reports, and reproducible benchmarks. The strongest portfolio signal will come from showing difficult decisions and their evidence: how the callback stays bounded, how stale worker results are rejected, how command delivery differs from telemetry, what happens when audio data is late, and which failures remain unsolved.

The author also wants the project to help people discover other affordable, high-quality software he creates. That can be a coherent independent-developer strategy if ResoStage earns trust on its own merits. Useful practices include:

- Make ResoStage genuinely useful without requiring customers to buy another product.
- Keep related-product recommendations occasional, clearly labeled, and relevant to the user’s task.
- Publish short demonstrations, engineering notes, changelogs, and practical setup guides.
- Show the product doing real work, including inconvenient edge cases and current limits.
- Let users support development through transparent channels such as sponsorship or donations, without implying that donations buy reliability guarantees.

The project’s README already links to GitHub Sponsors and Buy Me a Coffee. That is a simple voluntary support path. The document set does not establish a catalogue of other commercial products, so this overview does not invent one. Any product cross-promotion should refer only to products that actually exist and should explain their relationship to ResoStage plainly.

## 12. Open-source governance, licensing, and trust

The repository states that the source is licensed under GPLv3 or later and that combined binaries built with JUCE 9 are distributed under AGPLv3 terms. The exact obligations for any particular distribution, plugin, or hosted deployment are legal questions; this overview is not legal advice. The applicable license files and third-party dependencies should be reviewed before making simple claims such as “every part is GPL” or “cloud code must be AGPL.”

The project also requires contributors to accept a CLA. The CLA lets contributors retain copyright while granting the project lead broad, irrevocable rights to use, modify, sublicense, and relicense contributions, including for proprietary enterprise/OEM products and cloud services. The CLA expressly says contributors have no right to revenue from those uses. This gives the maintainer flexibility to pursue commercial licensing and hosted products, but it is materially broader than a simple permission to merge work into a GPL-only project.

The project reserves the ResoStage and ResoCloud names and logos as marks. That can help users identify official releases, while also meaning that the right to modify code and the right to distribute under the official brand are separate matters.

These policies can coexist with an open-source product, but they should be described plainly. Some contributors may welcome a single maintainer’s ability to coordinate licensing; others may be reluctant to sign a broad CLA or may question how community contributions support privately monetized services. The honest response is to show the terms before contribution, explain why they exist, and avoid implying that contributors share revenue or control unless the governance model says so.

## 13. Current maturity and known limits

ResoStage is an ambitious product with a substantial implementation and documentation base. It is also in active development, with important parts still being validated or expanded. The most relevant caveats visible in the Markdown materials are:

- **Real-world hardware validation:** Lighting support is actively seeking community validation on physical equipment. Compatibility claims should name the tested interfaces, fixtures, and network conditions.
- **Performance claims:** The baseline is specific to one M1 test system, one build, and defined workloads. It is not a universal no-dropout guarantee.
- **Callback terminology:** The callback is designed to be bounded and non-waiting but does use `try_lock`; describing it as completely lock-free would conflict with `AGENTS.md`.
- **Plug-ins:** Live plug-ins run in per-chain helper processes, but those helpers are not OS sandboxes. Offline plug-in rendering remains in-process and can still fail with the renderer.
- **Automation:** Plug-in parameter lanes and MIDI-region CC/channel pitch bend are editable and dispatched at block granularity. General strip automation editing and per-note MIDI 2.0 glide are not implemented.
- **ResoLink:** Core-to-Core synchronization and distributed execution are marked in progress, separate from the documented native remote-control mode.
- **MIDI 2.0:** Some file and project support is implemented; end-to-end UMP hardware and plug-in support is not complete.
- **DAW expansion:** The unified track/channel-strip architecture and several broad DAW subsystems have design documents marked `IN_PROGRESS`.
- **Cloud:** ResoCloud is a future direction, not a currently available service.
- **README consistency:** The README includes strong claims about a `kaishaku` supervisor, recovery timing, zero-dropout operation, and lock-free behavior. The current engineering guide describes the normal application as Electron plus Core and explicitly narrows the audio callback guarantee. Those strong claims should be reconciled with the shipped architecture and direct verification before being repeated externally.

This list is not a dismissal of the project. A technically ambitious early-stage system is expected to have boundaries and unfinished work. Naming them gives users, collaborators, and potential partners a more useful basis for trust than presenting every roadmap objective as complete.

## 14. How to describe ResoStage accurately

### A concise description

> ResoStage is an open-source live performance workstation that brings multitrack playback, mixing, MIDI, lighting control, stage visualization, and local remote operation into one project. Its native Core owns performance state, while the desktop interface acts as a controller and editor. Local show operation is designed to work without a cloud dependency; hosted collaboration and backup services are a possible future business direction.

### A fuller, still cautious description

> ResoStage is being built for performers and small production teams who want their playback and show-control tools to work together. It combines a native audio and event engine with an editable desktop interface, lighting workflows, and a documented two-computer remote-control mode. The project is open source and offline-first by design. Its most interesting potential distinction is the combination of these workflows in a single local system—not a claim that it replaces every DAW or show controller. ResoStage is under active development, and its hardware compatibility, performance, and remaining roadmap work should be judged by published tests and real-world use.

### Claims that need evidence or careful wording

| Avoid as an unqualified claim | More accurate direction |
| --- | --- |
| “Zero dropouts” or “guaranteed uninterrupted playback” | “Designed for bounded real-time playback; published tests cover specific workloads and hardware.” |
| “Completely lock-free audio engine” | “The callback avoids blocking waits and uses preallocated/bounded communication; routing contention can result in a silent block.” |
| “All plug-in crashes are isolated” | “Plug-in scanning runs in a helper; live plug-ins still execute inside Core.” |
| “Full MIDI 2.0 support” | Name the implemented MIDI Clip File/project features and state that live UMP support is incomplete. |
| “ResoLink is ready for redundant rigs” | “ResoLink is an in-progress Core-to-Core protocol design.” |
| “ResoCloud provides collaboration and backup” | “Optional hosted collaboration and backup are being considered for a future ResoCloud service.” |
| “The only product that combines audio and lighting” | “ResoStage explores an uncommon combination; a sourced market comparison is still needed.” |
| “Every platform and fixture is supported” | List tested operating systems, audio devices, lighting nodes, fixtures, and exact versions. |

## 15. What would make the story stronger?

The product’s best explanation will be supported by real artifacts rather than adjectives. A useful public evidence set would include:

1. A short, unedited demonstration of a complete workflow: load a project, start playback, change a mix, trigger lighting, and operate from a second computer.
2. A simple system diagram showing Core, controller, audio hardware, lighting network, and the local/cloud boundary.
3. A hardware compatibility table with exact OS versions, interfaces, drivers, DMX nodes, fixtures, and test dates.
4. Reproducible performance results with project size, buffer size, sample rate, plug-ins, duration, and failure counters.
5. A clear feature-status page that distinguishes released, implemented but experimental, in progress, and planned capabilities.
6. A transparent data and privacy explanation for both local operation and any future cloud product.
7. A plain-language explanation of the GPL/AGPL, trademark policy, and CLA, reviewed for legal accuracy.
8. A few real user stories showing where the integrated workflow saves setup effort, reduces hardware/software handoffs, or improves operation.

The evidence should include failures and limits as well as successful demos. For live-performance users, honesty about the test boundary is itself a reliability feature.

## 16. Short answers for someone discovering the project

**What are you building?**  
A live performance workstation that combines playback, mixing, MIDI, lighting control, stage visualization, and remote operation around a native Core.

**Who might use it?**  
Performers and small production teams who need audio playback and show control to cooperate, especially where a local, self-contained setup is valuable.

**What may be distinctive about it?**  
The integrated combination of live audio workflows, lighting, visualization, and a local-network control topology in one open-source project. That is a promising distinction to validate, not proof of being the only product in the market.

**Why open source?**  
The project is intended to keep the local performance tool inspectable and available without an online account or required cloud service. The source license and contributor terms are documented in the repository.

**How could it make money?**  
The stated direction is optional managed services whose value depends on ongoing infrastructure—potentially remote relay, backup, access administration, or collaboration—while keeping local show operation independent. ResoCloud is a roadmap, not a released service.

**What is the author’s broader goal?**  
Build a useful product, demonstrate real engineering work in public, develop an audience around that work, and make it easier for people to discover other well-made, reasonably priced software from the same independent developer.

**What should a newcomer keep in mind?**  
ResoStage is ambitious and already has detailed technical architecture, but it is actively developed. Some strong marketing statements in README need reconciliation with the more precise engineering guide; hardware validation and several roadmap features remain open work.

## 17. Repository references

This overview is based primarily on the following project documents:

- [`README.md`](README.md) — product introduction, feature tour, open-source philosophy, support links, and ResoCloud direction.
- [`AGENTS.md`](AGENTS.md) — current architectural contract, process and thread ownership, real-time behavior, project model, telemetry, rendering, and verification expectations.
- [`docs/REMOTE_CONTROL.md`](docs/REMOTE_CONTROL.md) — native remote topology, command/telemetry split, discovery, and two-machine verification.
- [`docs/performance/DAW_BASELINE.md`](docs/performance/DAW_BASELINE.md) — dated benchmark environment, workloads, and test results.
- [`docs/PLUGIN_HOSTING.md`](docs/PLUGIN_HOSTING.md) — scanner and per-chain live plug-in process boundaries.
- [`docs/PLUGIN_FAILURE_CONTAINMENT.md`](docs/PLUGIN_FAILURE_CONTAINMENT.md) — live-host crash containment, watchdog/restart limits, offline-render risk, and remaining integration verification.
- [`docs/MIDI2_REMAINING_WORK.md`](docs/MIDI2_REMAINING_WORK.md) — implemented MIDI 2.0 file/project scope and incomplete live UMP support.
- [`docs/architecture/RESOLINK_PROTOCOL.md`](docs/architecture/RESOLINK_PROTOCOL.md) — in-progress Core-to-Core synchronization design.
- [`docs/architecture/DAW_TRACK_MODEL.md`](docs/architecture/DAW_TRACK_MODEL.md), [`docs/architecture/AUTOMATION_MODEL.md`](docs/architecture/AUTOMATION_MODEL.md), [`docs/architecture/MIDI_AND_PIANO_ROLL.md`](docs/architecture/MIDI_AND_PIANO_ROLL.md), and [`docs/architecture/PLUGIN_POWER_MANAGEMENT.md`](docs/architecture/PLUGIN_POWER_MANAGEMENT.md) — broader architecture designs and their stated in-progress status.
- [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CLA.md`](CLA.md), and [`TRADEMARK.md`](TRADEMARK.md) — contribution governance, contributor rights, and brand policy.
- [`resolight/firmware/README.md`](resolight/firmware/README.md) — firmware setup and architecture for the ResoLight project.

---

*This document explains the project based on repository materials. It does not independently certify code behavior, market uniqueness, hardware compatibility, legal compliance, or the future business model.*
