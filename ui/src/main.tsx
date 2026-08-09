import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { applyTheme } from "./lib/theme";

// Applied synchronously, before the first render -- this app is a
// stage-side remote/mirror of the native (always-dark) desktop app, so it
// always forces dark rather than following system preference. Doing this
// here (not in a useEffect in App) matters: React fires child effects
// before parent effects on mount, so a component that reads HeroUI's
// theme-driven CSS custom properties in its own effect (e.g. the Light
// tab's 3D stage, resolving --background/--default for its grid colors)
// could otherwise run before the "dark" class landed and permanently
// capture the light theme's near-white values.
applyTheme("dark");

// Page Lifecycle / visibility: after OS sleep or long background the
// compositor can leave a black frame. Dispatch the same resume event the
// Electron shell uses so WebGL / WS wake paths share one entry point.
// (No toggle — always on.)
function dispatchShellResume(reason: string) {
  try {
    window.dispatchEvent(
      new CustomEvent("resoshell-resume", { detail: { reason } }),
    );
  } catch {
    /* ignore */
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") dispatchShellResume("visibility");
});
// Chromium Page Lifecycle (freeze/resume after background discard).
window.addEventListener("resume", () => {
  dispatchShellResume("page-resume");
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) dispatchShellResume("pageshow-bfcache");
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
