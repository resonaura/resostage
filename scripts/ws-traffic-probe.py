#!/usr/bin/env python3
"""Minimal raw WebSocket client: measures ResoStage's real telemetry frames.

Connects, optionally scopes the view, then reports frame sizes, rate, and how
much of each frame actually CHANGED since the previous one.
"""
import base64
import json
import os
import socket
import sys
import time

HOST, PORT = "127.0.0.1", 2899
PATH = sys.argv[1] if len(sys.argv) > 1 else "/ws"
VIEW = sys.argv[2] if len(sys.argv) > 2 else None
SECONDS = float(sys.argv[3]) if len(sys.argv) > 3 else 5.0


def handshake(sock):
    key = base64.b64encode(os.urandom(16)).decode()
    req = (f"GET {PATH} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nUpgrade: websocket\r\n"
           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
           f"Sec-WebSocket-Protocol: resoset\r\n"
           f"Sec-WebSocket-Version: 13\r\n\r\n")
    sock.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("closed during handshake")
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    if b"101" not in head.split(b"\r\n")[0]:
        raise RuntimeError("upgrade refused: " + head.split(b"\r\n")[0].decode())
    return rest


def send_text(sock, text):
    payload = text.encode()
    mask = os.urandom(4)
    header = bytearray([0x81])
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    else:
        header.append(0x80 | 126)
        header += n.to_bytes(2, "big")
    header += mask
    sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))


def frames(sock, initial):
    buf = initial
    while True:
        while len(buf) < 2:
            buf += sock.recv(65536)
        b0, b1 = buf[0], buf[1]
        opcode = b0 & 0x0F
        ln = b1 & 0x7F
        off = 2
        if ln == 126:
            while len(buf) < 4:
                buf += sock.recv(65536)
            ln = int.from_bytes(buf[2:4], "big")
            off = 4
        elif ln == 127:
            while len(buf) < 10:
                buf += sock.recv(65536)
            ln = int.from_bytes(buf[2:10], "big")
            off = 10
        while len(buf) < off + ln:
            buf += sock.recv(65536)
        payload = buf[off:off + ln]
        buf = buf[off + ln:]
        yield opcode, payload


def main():
    sock = socket.create_connection((HOST, PORT), timeout=10)
    rest = handshake(sock)
    if VIEW:
        send_text(sock, json.dumps({"view": VIEW}))

    sizes, text_frames, bin_frames = [], 0, 0
    tbytes = bbytes = 0
    prev = None
    changed_keys = {}
    identical = 0
    t0 = time.time()
    for opcode, payload in frames(sock, rest):
        if time.time() - t0 > SECONDS:
            break
        if opcode == 0x2:
            bin_frames += 1
            bbytes += len(payload)
            sizes.append(len(payload))
            continue
        if opcode != 0x1:
            continue
        text_frames += 1
        tbytes += len(payload)
        sizes.append(len(payload))
        try:
            cur = json.loads(payload)
        except Exception:
            continue
        if prev is not None:
            if payload == prevraw:
                identical += 1
            for k in cur:
                if k in prev and json.dumps(prev[k], sort_keys=True) != json.dumps(cur[k], sort_keys=True):
                    changed_keys[k] = changed_keys.get(k, 0) + 1
        prev, prevraw = cur, payload

    dur = time.time() - t0
    total = sum(sizes)
    print(f"view={VIEW or 'default'}  {dur:.1f}s")
    print(f"  frames: {text_frames} text + {bin_frames} binary   "
          f"({(text_frames+bin_frames)/dur:.1f}/s)")
    print(f"  bytes : {total:,}  ->  {total/dur/1024:.0f} KiB/s per client")
    print(f"          text {tbytes/dur/1024:.0f} KiB/s   binary {bbytes/dur/1024:.0f} KiB/s")
    if sizes:
        print(f"  frame : avg {total//len(sizes):,} B   max {max(sizes):,} B")
    print(f"  byte-identical consecutive text frames: {identical}/{max(1,text_frames-1)}")
    if changed_keys:
        print("  fields that changed between frames (count):")
        for k, v in sorted(changed_keys.items(), key=lambda kv: -kv[1])[:12]:
            print(f"     {k:<24} {v}")


if __name__ == "__main__":
    main()
