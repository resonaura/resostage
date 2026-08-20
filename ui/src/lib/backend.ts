// The C++ WebServer (app/web/WebServer.cpp) always listens on this port,
// independent of whichever origin actually served this page. In production
// (page served *by* that same server) relative URLs already resolve there.
// In dev (page served by the Vite dev server on :2900) we must point
// explicitly at the native app's backend instead of Vite's own origin.
const NATIVE_BACKEND_PORT = 2899;

let _dynamicRemoteOrigin: string | null = null;

export type BackendChangeListener = (origin: string, isRemote: boolean) => void;
const _backendListeners = new Set<BackendChangeListener>();

export function onBackendChange(fn: BackendChangeListener): () => void {
  _backendListeners.add(fn);
  return () => _backendListeners.delete(fn);
}

export function setRemoteBackend(host: string | null): void {
  let nextOrigin: string | null = null;
  if (host) {
    const clean = cleanHostString(host);
    nextOrigin = clean.includes(":") ? clean : `${clean}:${NATIVE_BACKEND_PORT}`;
  }
  if (_dynamicRemoteOrigin === nextOrigin) {
    return;
  }
  _dynamicRemoteOrigin = nextOrigin;
  const origin = backendOrigin();
  const isRemote = Boolean(_dynamicRemoteOrigin);
  _backendListeners.forEach((fn) => {
    try {
      fn(origin, isRemote);
    } catch {}
  });
}

export function getRemoteBackend(): string | null {
  return _dynamicRemoteOrigin;
}

function cleanHostString(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^wss?:\/\//i, "");
  s = s.replace(/\/+.*$/, "");
  return s;
}

export function backendOrigin(): string {
    if (_dynamicRemoteOrigin) {
      return _dynamicRemoteOrigin;
    }
  if (typeof window !== "undefined" && window.location) {
    const params = new URLSearchParams(window.location.search);
    const remote = params.get("remote");
    if (remote && remote !== "1" && remote !== "true") {
      const clean = cleanHostString(remote);
      if (clean) {
        return clean.includes(":") ? clean : `${clean}:${NATIVE_BACKEND_PORT}`;
      }
    }
  }
  if (import.meta.env.DEV) {
    const host = (typeof location !== "undefined" && location.hostname) || "localhost";
    return `${host}:${NATIVE_BACKEND_PORT}`;
  }
  return (typeof location !== "undefined" && location.host) || `localhost:${NATIVE_BACKEND_PORT}`;
}

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${backendOrigin()}/ws`;
}

export function apiUrl(path: string): string {
  const proto = location.protocol === "https:" ? "https:" : "http:";
  return `${proto}//${backendOrigin()}${path}`;
}

export interface ApiResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
}

export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<ApiResponse> {
  if (typeof window !== "undefined" && window.resostageElectron?.proxyRequest) {
    let path = input;
    if (path.startsWith("http://") || path.startsWith("https://")) {
      try {
        const u = new URL(path);
        path = u.pathname + u.search + u.hash;
      } catch {}
    }

    let headers: Record<string, string> | undefined;
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        headers = Object.fromEntries(init.headers.entries());
      } else if (Array.isArray(init.headers)) {
        headers = Object.fromEntries(init.headers);
      } else {
        headers = init.headers as Record<string, string>;
      }
    }

    let bodyStr: string | null = null;
    if (init?.body !== undefined && init?.body !== null) {
      if (typeof init.body === "string") {
        bodyStr = init.body;
      } else if (init.body instanceof Blob) {
        bodyStr = await init.body.text();
      } else {
        bodyStr = String(init.body);
      }
    }

    const res = await window.resostageElectron.proxyRequest({
      path,
      method: init?.method || "GET",
      headers,
      body: bodyStr,
    });

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      json: async <T>() => (res.isJson ? (res.data as T) : JSON.parse((res.data as string) || "{}")),
      text: async () => (typeof res.data === "string" ? res.data : JSON.stringify(res.data)),
    };
  }

  const url = input.startsWith("http://") || input.startsWith("https://") ? input : apiUrl(input);
  const rawRes = await fetch(url, init);
  return {
    ok: rawRes.ok,
    status: rawRes.status,
    statusText: rawRes.statusText,
    json: async <T>() => rawRes.json() as Promise<T>,
    text: async () => rawRes.text(),
  };
}

