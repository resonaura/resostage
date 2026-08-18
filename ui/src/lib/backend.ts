// The C++ WebServer (app/web/WebServer.cpp) always listens on this port,
// independent of whichever origin actually served this page. In production
// (page served *by* that same server) relative URLs already resolve there.
// In dev (page served by the Vite dev server on :2900) we must point
// explicitly at the native app's backend instead of Vite's own origin.
const NATIVE_BACKEND_PORT = 2899;

function cleanHostString(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^wss?:\/\//i, "");
  s = s.replace(/\/+.*$/, "");
  return s;
}

function backendOrigin(): string {
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
