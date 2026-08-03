# Chromium Embedded Framework (CEF) -- alternate GPU-accelerated rendering
# engine for the embedded web UI (see app/ui/CefWebView, added in a later
# milestone). Only fetched/built when RESOSTAGE_ENABLE_CEF is on (see root
# CMakeLists.txt) -- this is a multi-hundred-MB download+build and a new
# process/thread surface, so builds that don't need the app target (or
# explicitly opt out) never pay that cost.
#
# Pinned to a specific Spotify-hosted automated CEF build
# (https://cef-builds.spotifycdn.com/index.json) -- CEF's own upstream repo
# does not publish prebuilt binaries, and building Chromium from source is
# far outside this project's scope. Pinned by URL + SHA1 (as published in
# Spotify's index.json) so FetchContent's local cache is stable across
# rebuilds and CI runs, matching the same pinned-version FetchContent idiom
# already used for JUCE/libwebsockets in the root CMakeLists.txt.
set(RESOSTAGE_CEF_VERSION "151.3.14+g5d67476+chromium-151.0.7922.72")
set(RESOSTAGE_CEF_SHA1 "41c8a20b68d36b795d16287d9f75ca8ff9dc1363")

FetchContent_Declare(
  cef
  URL "https://cef-builds.spotifycdn.com/cef_binary_${RESOSTAGE_CEF_VERSION}_macosarm64_minimal.tar.bz2"
  URL_HASH SHA1=${RESOSTAGE_CEF_SHA1}
)
# FetchContent_MakeAvailable downloads/extracts the distribution AND runs its
# top-level CMakeLists.txt (like it already does for JUCE/libwebsockets
# above) -- that top-level file sets up compiler/linker flags for the whole
# distribution and conditionally adds libcef_dll_wrapper (the C++ wrapper
# around CEF's C API) plus the cefsimple/cefclient sample apps. The
# "minimal" distribution doesn't ship the samples, so only the wrapper
# actually gets added. This deliberately does NOT invoke any Xcode/Ninja-
# oriented app-bundling machinery (that only exists for the sample-app
# targets we don't have); libcef_dll_wrapper itself is a plain static
# library of ordinary source files and builds identically under any
# generator, including this repo's Unix Makefiles.
FetchContent_MakeAvailable(cef)

# Deliberately NOT linking the framework binary directly. Per the CEF
# distribution's own README.txt and include/wrapper/cef_library_loader.h:
# "Executables must load this framework dynamically at runtime instead of
# linking it directly" -- this is a macOS sandbox requirement. That runtime
# dlopen()-and-resolve dance is exactly what libcef_dll_wrapper's
# CefScopedLibraryLoader (used from application code, see
# tools/cef_smoke/main.mm) and its libcef_dll_dylib.cc trampolines already
# implement, so linking only libcef_dll_wrapper is correct and sufficient --
# the framework's actual symbols are resolved at runtime, not link time.
add_library(resostage_cef INTERFACE)
target_include_directories(resostage_cef INTERFACE ${cef_SOURCE_DIR})
target_link_libraries(resostage_cef INTERFACE libcef_dll_wrapper)

# Exposed for app/CMakeLists.txt's POST_BUILD bundle-assembly step (copying
# the framework into ResoStage.app -- added in a later milestone). On macOS,
# CEF's locales/*.pak resources live inside the framework bundle itself
# (Release/.../Chromium Embedded Framework.framework/Resources), not in a
# separate top-level Resources/ dir (that only exists in the Windows/Linux
# distributions) -- copying the whole framework brings them along for free.
set(RESOSTAGE_CEF_FRAMEWORK_DIR "${cef_SOURCE_DIR}/Release/Chromium Embedded Framework.framework" CACHE INTERNAL "")
