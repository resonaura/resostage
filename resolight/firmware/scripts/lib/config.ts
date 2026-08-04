// Load + validate resolight/firmware/config.yaml (user-local, gitignored).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type BoardEnv = "esp32" | "esp8266";

export type LedType =
  | "ws2812b"
  | "ws2811"
  | "ws2813"
  | "ws2815"
  | "sk6812"
  | "sk6812rgbw"
  | "apa102"
  | "apa102hd";

export type ColorOrder = "rgb" | "rbg" | "grb" | "gbr" | "brg" | "bgr";

export interface FirmwareConfig {
  board: BoardEnv;
  wifi: { ssid: string; password: string };
  leds: {
    type: LedType;
    order: ColorOrder;
    pin: number;
    clockPin: number | null;
    count: number;
    brightness: number;
  };
}

/** FastLED chip + whether it needs a clock pin. */
export const LED_TYPES: Record<
  LedType,
  { chip: string; needsClock: boolean; label: string }
> = {
  ws2812b: { chip: "WS2812B", needsClock: false, label: "WS2812B (NeoPixel)" },
  ws2811: { chip: "WS2811", needsClock: false, label: "WS2811" },
  ws2813: { chip: "WS2813", needsClock: false, label: "WS2813" },
  ws2815: { chip: "WS2815", needsClock: false, label: "WS2815" },
  sk6812: { chip: "SK6812", needsClock: false, label: "SK6812 RGB" },
  sk6812rgbw: {
    chip: "SK6812",
    needsClock: false,
    label: "SK6812 RGBW (W folded into RGB)",
  },
  apa102: { chip: "APA102", needsClock: true, label: "APA102 (DotStar)" },
  apa102hd: { chip: "APA102HD", needsClock: true, label: "APA102HD" },
};

export const COLOR_ORDERS: Record<ColorOrder, string> = {
  rgb: "RGB",
  rbg: "RBG",
  grb: "GRB",
  gbr: "GBR",
  brg: "BRG",
  bgr: "BGR",
};

const LED_TYPE_SET = new Set(Object.keys(LED_TYPES));
const ORDER_SET = new Set(Object.keys(COLOR_ORDERS));

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function loadConfig(firmwareRoot: string): FirmwareConfig {
  const configPath = path.join(firmwareRoot, "config.yaml");
  const examplePath = path.join(firmwareRoot, "config.example.yaml");

  if (!existsSync(configPath)) {
    throw new Error(
      `Missing ${configPath}\n` +
        `  cp ${path.relative(process.cwd(), examplePath)} ${path.relative(process.cwd(), configPath)}\n` +
        `  # then edit wifi + leds for your board`,
    );
  }

  const raw = parseYaml(readFileSync(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  if (!raw || typeof raw !== "object") {
    throw new Error("config.yaml: root must be a mapping");
  }

  const boardRaw = asString(raw.board, "esp32").toLowerCase();
  if (boardRaw !== "esp32" && boardRaw !== "esp8266") {
    throw new Error(
      `config.yaml: board must be "esp32" or "esp8266" (got ${boardRaw})`,
    );
  }

  const wifi = (raw.wifi ?? {}) as Record<string, unknown>;
  const leds = (raw.leds ?? {}) as Record<string, unknown>;

  const typeRaw = asString(leds.type, "ws2812b").toLowerCase() as LedType;
  if (!LED_TYPE_SET.has(typeRaw)) {
    throw new Error(
      `config.yaml: leds.type "${typeRaw}" unknown. One of: ${[...LED_TYPE_SET].join(", ")}`,
    );
  }

  const orderRaw = asString(leds.order, "grb").toLowerCase() as ColorOrder;
  if (!ORDER_SET.has(orderRaw)) {
    throw new Error(
      `config.yaml: leds.order "${orderRaw}" unknown. One of: ${[...ORDER_SET].join(", ")}`,
    );
  }

  const meta = LED_TYPES[typeRaw];
  let clockPin: number | null = null;
  if (meta.needsClock) {
    if (leds.clockPin === undefined || leds.clockPin === null) {
      throw new Error(
        `config.yaml: leds.type "${typeRaw}" needs leds.clockPin (SPI clock GPIO)`,
      );
    }
    clockPin = asInt(leds.clockPin, 18, 0, 48);
  }

  const count = asInt(leds.count, 120, 1, 4096);
  if (boardRaw === "esp8266" && count > 400) {
    console.warn(
      `warning: leds.count=${count} is high for ESP8266 RAM; prefer ≤300 if you see brownouts`,
    );
  }

  return {
    board: boardRaw,
    wifi: {
      ssid: asString(wifi.ssid, ""),
      password: asString(wifi.password, ""),
    },
    leds: {
      type: typeRaw,
      order: orderRaw,
      pin: asInt(leds.pin, 5, 0, 48),
      clockPin,
      count,
      brightness: asInt(leds.brightness, 255, 0, 255),
    },
  };
}

/** Escape a string into a C string literal body. */
export function cStringLiteral(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}
