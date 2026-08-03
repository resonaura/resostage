#pragma once

// Process-lifetime wiring for the optional Chromium Embedded Framework
// rendering engine (see vendor/cef/CMakeLists.txt and the CEF integration
// milestones). Every function here is safe to call unconditionally from
// app code regardless of RESOSTAGE_ENABLE_CEF or the user's persisted
// engine choice -- when CEF isn't compiled in, these compile down to
// nothing; when it is compiled in but the user has selected "wkwebview"
// (the default), bootstrapIfSelected() never loads the framework at all,
// so there is zero process/thread/memory cost for anyone who hasn't opted
// in.
//
// Switching the persisted engine choice is NOT hot-swappable: CEF's
// CefInitialize/CefShutdown are documented as safe to call at most once
// each per OS process lifetime on the mac port (re-initializing after
// shutdown is unsupported), so changing the setting takes effect on next
// launch, not immediately -- see the Settings UI's "Restart to apply"
// affordance.

namespace resostage::cef_lifecycle {

#if RESOSTAGE_ENABLE_CEF

// Must be called as the very first statement in main(), before any JUCE or
// AppKit initialization -- CEF's docs require its entry-point check
// (CefExecuteProcess) to run before the host application creates its own
// NSApplication. Reads the persisted engine choice itself (a plain JSON
// file read, safe this early) and does nothing at all if "wkwebview" is
// selected. On the main ResoStage executable, CefExecuteProcess always
// determines "not a subprocess" and returns -- macOS CEF subprocess roles
// (renderer/GPU/utility/...) relaunch through the separate Helper.app
// bundles built in app/CMakeLists.txt (see app/cef/HelperMain.mm), never
// this binary, unlike Windows/Linux's single-binary-relaunches-itself
// model.
void bootstrapIfSelected(int argc, char* argv[]);

// Called from ResoStageApplication::initialise(), once JUCE's message loop
// exists (CefDoMessageLoopWork must only ever run on that thread). No-op if
// bootstrapIfSelected() didn't load the framework.
void initializeIfLoaded();

// Called from ResoStageApplication::shutdown().
void shutdownIfInitialized();

#else

inline void bootstrapIfSelected(int, char*[]) {}
inline void initializeIfLoaded() {}
inline void shutdownIfInitialized() {}

#endif

} // namespace resostage::cef_lifecycle
