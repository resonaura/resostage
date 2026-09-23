# Native remote control

ResoStage's primary remote topology is one desktop application controlling a
Core process on another computer. A browser remains a supported fallback, but
the desktop path adds a direct UDP receive lane and native LAN diagnostics.

## Transport split

| Traffic | Transport | Reason |
| --- | --- | --- |
| Transport and mixer commands, project edits, settings | HTTP/TCP `2899` | Delivery and ordering are mandatory. |
| Live playhead, meters, mixer flags, health, lighting preview | UDP, controller-selected port | Latest state wins; avoiding head-of-line blocking is more important than retransmission. |
| Node discovery | UDP `28991` | Periodic LAN announcement. |

The controller binds an ephemeral UDP port and renews its subscription every
three seconds. Core expires subscribers after fifteen seconds. This avoids the
old fixed-`2898` collision and permits multiple OS user sessions without
silently stealing each other's telemetry socket. Windows installers still add
the legacy `2898` firewall rule for compatibility; a restrictive firewall must
also allow inbound UDP for the desktop application's dynamically selected
port, or allow the ResoStage executable itself.

Telemetry frames have a magic value, protocol version, and wrapping 32-bit
sequence number. Electron validates these before crossing renderer IPC. It
drops duplicates and reordered packets, estimates missing packets from sequence
gaps, and starts a new sequence epoch after 1.5 seconds of silence (Core restart
or host switch). The React decoder repeats the sequence guard as defense in
depth. A remote session is not shown as connected until Core answers an HTTP
probe; afterward the global connection indicator follows the UDP watchdog as
well as the command channel.

## Connect

1. Start ResoStage Core on the playback computer with LAN discovery enabled.
2. Allow ResoStage through the playback computer's firewall for TCP `2899` and
   UDP `28991`.
3. In the controller application open **Settings → Remote**.
4. Select the discovered node, or enter its IPv4 address and backend port.
5. Confirm that **UDP telemetry** changes from `waiting` to `live`. Loss and
   out-of-order counts should normally remain at zero on wired Ethernet.

Remote commands intentionally remain on HTTP. Sending them as unreliable UDP
would make a dropped Stop, Save, mute, or routing edit indistinguishable from a
successful operation. "All telemetry over UDP" refers to continuously sampled
state; it does not weaken transactional control operations.

## Verification

Run the automated local suites first:

```bash
pnpm --dir electron test
pnpm --dir electron typecheck
pnpm --dir ui test
pnpm --dir ui exec tsc -b --pretty false
ctest --test-dir core/build --output-on-failure
```

For a two-machine test, start Core on the playback node, connect from the
desktop controller, and verify all of the following:

- Play, pause, stop-to-start, seek, song selection, mute, solo, fader, pan,
  routing, and project edits affect the playback node only.
- The controller's local audio device remains uninvolved.
- Pulling the network cable changes telemetry to `stale` within 1.5 seconds;
  reconnecting recovers without restarting either application.
- Rapid fader movement does not build a command backlog; continuous controls
  coalesce to the latest in-flight value.
- Remote Settings reports the playback node's source IP and increasing packet
  count. Reordered packets never move the playhead backward.

With Core running on the playback node, exercise the real command and datagram
paths from the controller machine:

```bash
REMOTE_HOST=192.168.5.115 REMOTE_PORT=2899 pnpm test:remote
```

The test performs a non-destructive command/state round-trip, subscribes an
ephemeral local UDP socket, validates protocol-v8 frame headers and sequence
ordering for three seconds, and reports loss plus average/p95 packet interval.
It does not replace the in-app cable-loss/recovery check above.

If TCP still times out after adding the port rule on Windows, inspect Defender
Firewall for an older explicit **Block** rule tied to that exact executable.
Windows gives an explicit program block priority over a later port allow rule.

## Offline render in remote mode

Render jobs execute on the active Core, including when it is remote. The
finished paths shown in the dialog are therefore paths on the playback
machine. Files are written to an `Exports` directory next to the open project
package. A job can capture Main, any set of tracks/buses, and Click from one
offline graph pass; it does not repeatedly solo and rerender stems. The render
runs on a background worker against an immutable project snapshot; it neither
stops transport nor enters the real-time callback. Source audio is decoded
through bounded seek caches instead of loading the whole set into RAM.

Cancelling is cooperative at the next render block and removes every partial
WAV belonging to the job. `Leave tail` is bounded by both a quiet detector and
the configured maximum tail time, so a non-decaying future processor cannot
make a remote render run forever.

`Wrap` performs a discarded priming pass followed by the recorded pass, keeping
state across the range boundary. Normalized jobs use a temporary float spool
on the playback machine; completed files appear atomically only after final
conversion, dither, and WAV finalization.
