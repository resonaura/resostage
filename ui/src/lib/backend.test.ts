// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setRemoteBackend,
  getRemoteBackend,
  backendOrigin,
  wsUrl,
  apiUrl,
  apiFetch,
  onBackendChange,
} from "./backend";

const NATIVE = 2899;

beforeEach(() => {
  setRemoteBackend(null);
  // Reset the electron proxy to absent so tests are deterministic.
  delete (window as unknown as { resostageElectron?: unknown }).resostageElectron;
  window.history.replaceState({}, "", "/?embedded=1");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setRemoteBackend / backendOrigin", () => {
  it("starts local (no remote) and origin points at the native backend", () => {
    expect(getRemoteBackend()).toBeNull();
    expect(backendOrigin()).toBe(`localhost:${NATIVE}`);
  });

  it("stores a bare host and appends the native port", () => {
    setRemoteBackend("192.168.5.125");
    expect(getRemoteBackend()).toBe("192.168.5.125:2899");
    expect(backendOrigin()).toBe("192.168.5.125:2899");
  });

  it("keeps an explicit port", () => {
    setRemoteBackend("192.168.5.125:3100");
    expect(backendOrigin()).toBe("192.168.5.125:3100");
  });

  it("strips schemes and trailing paths", () => {
    setRemoteBackend("http://192.168.5.125:3100/foo");
    expect(backendOrigin()).toBe("192.168.5.125:3100");
  });

  it("clearing the remote returns to the native backend", () => {
    setRemoteBackend("192.168.5.125:2899");
    setRemoteBackend(null);
    expect(getRemoteBackend()).toBeNull();
    expect(backendOrigin()).toBe(`localhost:${NATIVE}`);
  });

  it("does not re-notify listeners when unchanged", () => {
    const fn = vi.fn();
    const unsub = onBackendChange(fn);
    setRemoteBackend("1.2.3.4:2899");
    const first = fn.mock.calls.length;
    setRemoteBackend("1.2.3.4:2899");
    expect(fn.mock.calls.length).toBe(first);
    setRemoteBackend(null);
    expect(fn.mock.calls.length).toBe(first + 1);
    unsub();
  });

  it("reads the remote query param when no dynamic remote is set", () => {
    window.history.replaceState({}, "", "/?remote=192.168.5.125:3100");
    expect(backendOrigin()).toBe("192.168.5.125:3100");
  });
});

describe("url builders", () => {
  it("wsUrl targets the active remote origin", () => {
    setRemoteBackend("192.168.5.125:2899");
    expect(wsUrl()).toBe("ws://192.168.5.125:2899/ws");
  });

  it("apiUrl targets the active remote origin", () => {
    setRemoteBackend("192.168.5.125:2899");
    expect(apiUrl("/api/v1/state")).toBe("http://192.168.5.125:2899/api/v1/state");
  });
});

describe("apiFetch", () => {
  it("routes through the electron proxy when available", async () => {
    const proxy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      data: { hello: "world" },
      isJson: true,
    });
    (window as unknown as { resostageElectron: { proxyRequest: typeof proxy } }).resostageElectron = { proxyRequest: proxy };

    const res = await apiFetch("/api/v1/state");
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ hello: "world" });
    expect(proxy).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/v1/state", method: "GET" }),
    );
  });

  it("strips absolute URLs to a path before proxying", async () => {
    const proxy = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: "", headers: {}, data: {}, isJson: true,
    });
    (window as unknown as { resostageElectron: { proxyRequest: typeof proxy } }).resostageElectron = { proxyRequest: proxy };
    await apiFetch("http://192.168.5.125:2899/api/v1/state");
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({ path: "/api/v1/state" }));
  });

  it("uses a plain fetch to the active origin when no proxy exists", async () => {
    const origin = backendOrigin();
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "{}",
    });
    vi.stubGlobal("fetch", stub);
    await apiFetch("/api/v1/state");
    expect(stub).toHaveBeenCalledWith(`http://${origin}/api/v1/state`, undefined);
  });
});