// The C++ WebServer (app/web/WebServer.cpp) always listens on this port,
// independent of whichever origin actually served this page. In production
// (page served *by* that same server) relative URLs already resolve there.
// In dev (page served by the Vite dev server on :2900) we must point
// explicitly at the native app's backend instead of Vite's own origin.
const NATIVE_BACKEND_PORT = 2899;

function backendOrigin(): string {
  if (import.meta.env.DEV) {
    return `${location.hostname}:${NATIVE_BACKEND_PORT}`;
  }
  return location.host;
}

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${backendOrigin()}/ws`;
}

export function apiUrl(path: string): string {
  const proto = location.protocol === "https:" ? "https:" : "http:";
  return `${proto}//${backendOrigin()}${path}`;
}
