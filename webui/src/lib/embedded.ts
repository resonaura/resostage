// Set by DevOrEmbeddedWebView.h on both URLs it loads (dev server and the
// embedded-server fallback) -- true only when this page is running inside
// the native app's own webview, as opposed to a plain LAN/localhost browser
// tab. A native FileChooser/save dialog popped from the embedded webview
// shows up in that same on-screen window, so it's safe to drive natively;
// a plain browser tab has no such window to show it in, so it needs its own
// upload/download flow instead. See app/ui/DevOrEmbeddedWebView.h.
export const IS_EMBEDDED = new URLSearchParams(window.location.search).get("embedded") === "1";
