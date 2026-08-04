// ResoLight firmware — single translation unit for ESP32 and ESP8266.
//
// Role: WS *server* on resolight::kDefaultBoardPort (fixed protocol port —
// never user-configurable; ResoStage dials the same constant). Streams
// binary LightFrame payloads (shared/ResoLightProtocol.h) and broadcasts a
// UDP discovery beacon so unpaired boards show up in Settings → Light.
//
// Board-specific settings (Wi-Fi, LED pin/count/chip/order) come from
// src/generated/BoardConfig.h, produced by the TypeScript CLI from
// config.yaml before every build/flash. No RESOLIGHT_MAX_PIXELS — the LED
// buffer is exactly leds.count from that config.

#include <Arduino.h>
#include <WiFiUdp.h>

#if defined(RESOLIGHT_ESP32)
#include <WiFi.h>
#include <WebSocketsServer.h>
#elif defined(RESOLIGHT_ESP8266)
#include <ESP8266WiFi.h>
#include <WebSocketsServer.h>
#else
#error "Define RESOLIGHT_ESP32 or RESOLIGHT_ESP8266 (see platformio.ini)"
#endif

#include <FastLED.h>

#include "ResoLightProtocol.h"
#include "generated/BoardConfig.h"

#ifndef RESOLIGHT_STATUS_INTERVAL_MS
#define RESOLIGHT_STATUS_INTERVAL_MS 1000
#endif

// ── Board identity ──────────────────────────────────────────────────────────

#if defined(RESOLIGHT_ESP32)
static constexpr resolight::ChipType kChip = resolight::ChipType::Esp32;
#else
static constexpr resolight::ChipType kChip = resolight::ChipType::Esp8266;
#endif

static uint8_t gMac[6] = {};
static char gBoardName[resolight::kDiscoveryNameSize] = {};

// ── LED buffer: sized exactly to the configured strip ───────────────────────
// Compile-time size from config.yaml → BoardConfig.h. A frame that reports
// more pixels than this is clamped; fewer blacks out the tail. No separate
// "max pixels" knobs, no heap on the frame path.

static CRGB gLeds[RESOLIGHT_LED_COUNT];
static uint8_t gChannelsPerPixel = 3;
static bool gHasFrame = false;
static uint32_t gLastFrameMs = 0;

static uint8_t gStatusScratch[resolight::kStatusFrameSize];
static uint8_t gDiscoverScratch[resolight::kDiscoveryBeaconSize];

// ── Networking ──────────────────────────────────────────────────────────────

// Port + subprotocol are protocol constants (ResoLightProtocol.h), not config.
static WebSocketsServer gWs(resolight::kDefaultBoardPort, "", "resolight");
static WiFiUDP gUdp;
static uint8_t gWsClientNum = 0xFF;
static uint32_t gLastStatusMs = 0;
static uint32_t gLastDiscoverMs = 0;

static void blackoutLeds() {
  fill_solid(gLeds, RESOLIGHT_LED_COUNT, CRGB::Black);
  FastLED.show();
}

static void applyLightFrame(const uint8_t* data, size_t len) {
  resolight::LightFrameHeader hdr{};
  if (!resolight::decodeLightFrameHeader(data, len, hdr))
    return;

  const size_t need =
      resolight::lightFramePayloadSize(hdr.pixelCount, hdr.channelsPerPixel);
  if (len < need)
    return;

  if (hdr.flags & resolight::kFlagBlackout) {
    blackoutLeds();
    gHasFrame = true;
    gLastFrameMs = millis();
    return;
  }

  // Clamp to the physical strip length from config — never write past gLeds.
  const uint16_t pixels = hdr.pixelCount > RESOLIGHT_LED_COUNT
                              ? static_cast<uint16_t>(RESOLIGHT_LED_COUNT)
                              : hdr.pixelCount;
  const uint8_t cpp = hdr.channelsPerPixel;
  if (cpp != 1 && cpp != 3 && cpp != 4)
    return;

  gChannelsPerPixel = cpp;

  const uint8_t* px = data + resolight::kLightFrameHeaderSize;
  for (uint16_t i = 0; i < pixels; ++i) {
    const uint8_t* p = px + static_cast<size_t>(i) * cpp;
    if (cpp == 1) {
      gLeds[i] = CRGB(p[0], p[0], p[0]);
    } else {
      uint8_t r = p[0], g = p[1], b = p[2];
      if (cpp == 4) {
        // RGBW frame → RGB strip (or SK6812 driven as RGB): fold W in.
        const uint8_t w = p[3];
        r = qadd8(r, w);
        g = qadd8(g, w);
        b = qadd8(b, w);
      }
      gLeds[i] = CRGB(r, g, b);
    }
  }
  for (uint16_t i = pixels; i < RESOLIGHT_LED_COUNT; ++i)
    gLeds[i] = CRGB::Black;

  FastLED.show();
  gHasFrame = true;
  gLastFrameMs = millis();
}

static void sendStatus(uint8_t clientNum) {
  const int rssi = WiFi.RSSI();
  const uint32_t uptime = millis() / 1000u;
  const uint32_t heap = ESP.getFreeHeap();
  resolight::encodeStatusFrame(gStatusScratch, kChip, rssi, uptime, heap);
  gWs.sendBIN(clientNum, gStatusScratch, resolight::kStatusFrameSize);
}

static void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
  case WStype_CONNECTED:
    if (gWsClientNum != 0xFF && gWsClientNum != num)
      gWs.disconnect(gWsClientNum);
    gWsClientNum = num;
    sendStatus(num);
    break;
  case WStype_DISCONNECTED:
    if (gWsClientNum == num)
      gWsClientNum = 0xFF;
    break;
  case WStype_BIN:
    if (payload != nullptr && length > 0)
      applyLightFrame(payload, length);
    break;
  case WStype_TEXT:
    break;
  default:
    break;
  }
}

static void broadcastDiscovery() {
  if (WiFi.status() != WL_CONNECTED && WiFi.getMode() != WIFI_AP)
    return;

  resolight::encodeDiscoveryBeacon(gDiscoverScratch, kChip, gMac, gBoardName);

  IPAddress bcast;
#if defined(RESOLIGHT_ESP32)
  if (WiFi.getMode() == WIFI_AP || WiFi.getMode() == WIFI_AP_STA) {
    bcast = WiFi.softAPIP();
    bcast[3] = 255;
  } else {
    bcast = WiFi.broadcastIP();
  }
#else
  if (WiFi.getMode() == WIFI_AP || WiFi.getMode() == WIFI_AP_STA) {
    bcast = WiFi.softAPIP();
    bcast[3] = 255;
  } else {
    bcast = IPAddress(WiFi.localIP()[0], WiFi.localIP()[1], WiFi.localIP()[2], 255);
  }
#endif

  gUdp.beginPacket(bcast, resolight::kDiscoveryPort);
  gUdp.write(gDiscoverScratch, resolight::kDiscoveryBeaconSize);
  gUdp.endPacket();
}

static void buildBoardName() {
  snprintf(gBoardName, sizeof(gBoardName), "ResoLight-%02X%02X", gMac[4], gMac[5]);
}

static void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

#if defined(RESOLIGHT_ESP32)
  WiFi.setHostname(gBoardName);
#else
  WiFi.hostname(gBoardName);
#endif

  const bool hasSecrets = RESOLIGHT_WIFI_SSID[0] != '\0';
  if (hasSecrets) {
    WiFi.begin(RESOLIGHT_WIFI_SSID, RESOLIGHT_WIFI_PASS);
    const uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 15000u) {
      delay(50);
      yield();
    }
  }

  if (WiFi.status() != WL_CONNECTED) {
    WiFi.mode(WIFI_AP);
    WiFi.softAP(gBoardName, "resolight");
  }
}

static void initLeds() {
#if RESOLIGHT_LED_HAS_CLOCK
  FastLED.addLeds<RESOLIGHT_LED_CHIP, RESOLIGHT_LED_PIN, RESOLIGHT_LED_CLOCK_PIN,
                  RESOLIGHT_LED_ORDER>(gLeds, RESOLIGHT_LED_COUNT);
#else
  FastLED.addLeds<RESOLIGHT_LED_CHIP, RESOLIGHT_LED_PIN, RESOLIGHT_LED_ORDER>(
      gLeds, RESOLIGHT_LED_COUNT);
#endif
  FastLED.setBrightness(RESOLIGHT_LED_BRIGHTNESS);
  FastLED.setDither(0);
  blackoutLeds();
}

void setup() {
  WiFi.macAddress(gMac);
  buildBoardName();

  initLeds();
  connectWifi();

  gWs.begin();
  gWs.onEvent(onWsEvent);
  gUdp.begin(0);

  // Boot blip so a freshly flashed board is obviously alive.
  const uint16_t blip = RESOLIGHT_LED_COUNT < 8 ? RESOLIGHT_LED_COUNT : 8;
  fill_solid(gLeds, blip, CRGB(0, 40, 0));
  FastLED.show();
  delay(120);
  blackoutLeds();
}

void loop() {
  gWs.loop();

  const uint32_t now = millis();

  if (now - gLastDiscoverMs >= resolight::kDiscoveryIntervalMs) {
    gLastDiscoverMs = now;
    broadcastDiscovery();
  }

  if (gWsClientNum != 0xFF && now - gLastStatusMs >= RESOLIGHT_STATUS_INTERVAL_MS) {
    gLastStatusMs = now;
    sendStatus(gWsClientNum);
  }

  yield();
}
