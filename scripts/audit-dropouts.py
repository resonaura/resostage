#!/usr/bin/env python3
"""Measures ResoStage's three dropout counters across a burst of live edits.

Anything above zero in the report is audible: silentBlocks are whole blocks the
outputs spent as silence, starves are a step to zero inside a block, underruns
are the driver missing its deadline.
"""
import json
import subprocess
import sys
import time

API = "http://127.0.0.1:2899/api/v1"


def get(path):
    out = subprocess.run(["curl", "-s", "--max-time", "10", API + path],
                         capture_output=True, text=True).stdout
    return json.loads(out)


def post(path, body):
    subprocess.run(["curl", "-s", "-X", "POST", API + path,
                    "-H", "Content-Type: application/json",
                    "-d", json.dumps(body), "-o", "/dev/null"], check=False)


def counters():
    h = get("/state")["health"]
    return (h["audioCallbackCount"], h["silentBlockCount"],
            h["streamStarveCount"], h["underrunCount"])


def report(label, before, after):
    cb, silent, starve, under = (a - b for a, b in zip(after, before))
    verdict = "CLEAN" if (silent or starve or under) == 0 else "*** AUDIBLE ***"
    print(f"  {label:<34} callbacks={cb:<6} silent={silent:<5} starve={starve:<5} "
          f"underrun={under:<5} {verdict}")
    return silent + starve + under


def run(label, fn):
    before = counters()
    fn()
    time.sleep(2.5)
    return report(label, before, counters())


def main():
    state = get("/state")
    if not state["playing"]:
        print("transport is not playing -- start it first", file=sys.stderr)
        return 1
    song0 = state["songs"][0]
    track_id = song0["regions"][0]["trackId"]
    region_id = song0["regions"][0]["id"]
    print(f"playing '{state['songName']}'  track={track_id}\n")

    bad = 0

    def knobs():
        for i in range(120):
            v = -9 + 6 * (i % 11) / 10.0
            post("/track/gain", {"index": 0, "value": v})
            post("/track/pan", {"index": 0, "value": (i % 20) / 10.0 - 1.0})
            post("/bus/gain", {"index": 0, "value": v})
            post("/bus/pan", {"index": 0, "value": (i % 20) / 10.0 - 1.0})

    def sends():
        for i in range(120):
            post("/mixer/track/send",
                 {"trackIndex": 0, "busId": "audio::main", "level": 30 + (i % 70)})

    def toggles():
        for i in range(60):
            post("/track/mute", {"index": 1, "value": i % 2})
            post("/track/solo", {"index": 2, "value": i % 2})
            post("/track/mono", {"index": 3, "value": i % 2})
            post("/bus/mute", {"index": 1, "value": i % 2})

    def locators():
        for i in range(120):
            post("/builder/cycle/update",
                 {"songIndex": 0, "active": True, "leftSec": 20 + (i % 30) / 10.0,
                  "rightSec": 26, "gestureId": "loc"})

    def region_drag():
        for i in range(120):
            post("/builder/region/update",
                 {"songIndex": 0, "regionId": region_id,
                  "startSeconds": (i % 20) / 10.0, "gestureId": "drag"})

    def tempo():
        for i in range(80):
            post("/builder/song/update",
                 {"index": 0, "bpm": 118 + (i % 8), "gestureId": "bpm"})

    def add_undo():
        for i in range(30):
            post("/builder/region/add",
                 {"songIndex": 0, "trackId": track_id,
                  "file": "Audio/516418366720-NVRLND_BASS_120BPM.wav",
                  "startSeconds": 100 + i, "sourceOffsetSeconds": 0,
                  "durationSeconds": 5, "gainDb": 0, "gestureId": f"add{i}"})
            post("/timeline/undo", {})

    bad += run("track/bus gain + pan drag", knobs)
    bad += run("send level drag", sends)
    bad += run("mute / solo / mono toggles", toggles)
    bad += run("loop locator drag", locators)
    bad += run("region drag", region_drag)
    bad += run("song tempo drag (click regrid)", tempo)
    bad += run("region add + undo", add_undo)

    print()
    print("TOTAL audible events:", bad)
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
