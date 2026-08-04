# ResoLight firmware (ESP32 / ESP8266)

Stage lighting boards for ResoStage. One C++ source; chip + strip come from a
**local YAML config** processed by a TypeScript ESM CLI before PlatformIO runs.

Wire format is shared verbatim with the desktop app:

- `resolight/firmware/shared/ResoLightProtocol.h` ↔ `core/app/light/LightHardwareServer.cpp`
- Fixed WS port `7862` (protocol constant — not user-configurable)

## Quick start

```bash
# From repo root
cp resolight/firmware/config.example.yaml resolight/firmware/config.yaml
# edit wifi.ssid / wifi.password / leds.*

pnpm install
pnpm --dir resolight/firmware list-strips   # see supported strip chips
pnpm --dir resolight/firmware build         # generate BoardConfig.h + compile
pnpm --dir resolight/firmware flash         # upload to connected board
```

`config.yaml` is **gitignored**. Only `config.example.yaml` is committed.

## Config (`config.yaml`)

```yaml
board: esp32 # or esp8266

wifi:
  ssid: "StageLAN"
  password: "secret"

leds:
  type: ws2812b # see `pnpm --dir resolight/firmware list-strips`
  order: grb # almost all WS2812B reels
  pin: 5
  # clockPin: 18      # only for apa102 / apa102hd
  count: 120 # exact LED count — buffer is sized to this, no MAX_PIXELS
  brightness: 255
```

`pnpm --dir resolight/firmware build` / `flash` always regenerate
`src/generated/BoardConfig.h` from `config.yaml` first — no separate gen
command. Do not edit that header by hand.

## Architecture

```
ResoStage (laptop)  --WS binary client :7862-->  each ESP (WS server)
                ^-- UDP discovery :42424 --  boards every 2s
```

In the app, default is **preview only**. Bind a fixture IP in
Settings → Light → fixture → Hardware Link (or click a discovered board).
Port is always the protocol default — no UI for it.

## Scripts

| Command                           | What                             |
| --------------------------------- | -------------------------------- |
| `pnpm --dir resolight/firmware build`       | auto-gen BoardConfig.h + compile |
| `pnpm --dir resolight/firmware flash`       | auto-gen + compile + upload      |
| `pnpm --dir resolight/firmware monitor`     | serial                           |
| `pnpm --dir resolight/firmware list-strips` | strip chip list                  |

Requires [PlatformIO Core](https://docs.platformio.org/en/latest/core/installation.html).
