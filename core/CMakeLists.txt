cmake_minimum_required(VERSION 3.28)

project(ResoStage VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# windows.h (via WIN32_LEAN_AND_MEAN) still pulls in `min`/`max` macros by
# default, which break std::min/std::max/std::clamp everywhere a translation
# unit both includes windows.h and uses those. Disable them repo-wide rather
# than chasing each file.
if(WIN32)
  add_compile_definitions(NOMINMAX WIN32_LEAN_AND_MEAN)
endif()


if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0")
endif()

option(RESOSTAGE_BUILD_TESTS "Build engine unit tests" ON)
option(RESOSTAGE_BUILD_APP "Build the ResoStage JUCE app" ON)

include(FetchContent)

# ---------------------------------------------------------------------------
# JUCE (only pulled in when the app is being built; engine/tests don't need it)
# ---------------------------------------------------------------------------
if(RESOSTAGE_BUILD_APP)
  FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        9.0.0
    GIT_SHALLOW    TRUE
  )
  FetchContent_MakeAvailable(JUCE)

  # ---------------------------------------------------------------------------
  # Signalsmith Stretch: phase vocoder for per-region transposition.
  #
  # Header-only and MIT, so it costs a single include path and no build target.
  # Chosen over Rubber Band (GPL unless licensed, and heavier) and over rolling
  # our own -- a vocoder that does not smear transients is months of work, and
  # this one is what Tracktion Engine uses.
  # ---------------------------------------------------------------------------
  FetchContent_Declare(
    signalsmith_stretch
    GIT_REPOSITORY https://github.com/Signalsmith-Audio/signalsmith-stretch.git
    GIT_TAG        main
    GIT_SHALLOW    TRUE
  )
  # Its own CMakeLists declares an INTERFACE target and pulls in the linear
  # algebra header pack it needs, so let it -- populating by hand missed that
  # dependency and the build failed on a missing signalsmith-linear/stft.h.
  FetchContent_MakeAvailable(signalsmith_stretch)

  # Third-party headers, compiled with our warning flags, produce a wall of
  # shadow/conversion warnings that are not ours to fix and would drown the
  # ones that are. Re-declaring their include dirs as SYSTEM silences them
  # without loosening anything on our own code.
  foreach(sstarget signalsmith-stretch signalsmith-linear)
    if(TARGET ${sstarget})
      get_target_property(_ssdirs ${sstarget} INTERFACE_INCLUDE_DIRECTORIES)
      if(_ssdirs)
        set_target_properties(${sstarget} PROPERTIES
          INTERFACE_SYSTEM_INCLUDE_DIRECTORIES "${_ssdirs}")
      endif()
    endif()
  endforeach()

  # ---------------------------------------------------------------------------
  # libwebsockets: embedded HTTP/WebSocket server for the dual native+remote
  # web UI. TLS/extensions/test-apps disabled -- this serves a local-network-
  # only UI, so a TLS backend (OpenSSL/mbedTLS) would be an unnecessary
  # dependency for the "zero external runtime dependencies" goal. Chosen over
  # the originally-researched uWebSockets because uWebSockets has no CMake
  # build (Makefile-only), making it a much higher-risk FetchContent target;
  # libwebsockets is a mature, widely-deployed C library with a proper CMake
  # build that integrates as cleanly as JUCE did above.
  set(LWS_WITH_SSL OFF CACHE BOOL "" FORCE)
  set(LWS_WITH_SHARED OFF CACHE BOOL "" FORCE)
  set(LWS_WITH_STATIC ON CACHE BOOL "" FORCE)
  set(LWS_WITHOUT_TESTAPPS ON CACHE BOOL "" FORCE)
  set(LWS_WITHOUT_TEST_SERVER ON CACHE BOOL "" FORCE)
  set(LWS_WITHOUT_TEST_SERVER_EXTPOLL ON CACHE BOOL "" FORCE)
  set(LWS_WITHOUT_TEST_PING ON CACHE BOOL "" FORCE)
  set(LWS_WITHOUT_TEST_CLIENT ON CACHE BOOL "" FORCE)
  set(LWS_WITH_MINIMAL_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(LWS_WITHOUT_EXTENSIONS ON CACHE BOOL "" FORCE)

  FetchContent_Declare(
    libwebsockets
    GIT_REPOSITORY https://github.com/warmcat/libwebsockets.git
    GIT_TAG        v4.5.8
    GIT_SHALLOW    TRUE
  )
  FetchContent_MakeAvailable(libwebsockets)
endif()

# ---------------------------------------------------------------------------
# Glaze — reflection-based JSON (project I/O + dynamic command/settings parse).
# Header-only C++20. Typed DTOs for project.json; glz::generic for web command
# bodies and settings.json.
# ---------------------------------------------------------------------------
FetchContent_Declare(
  glaze
  GIT_REPOSITORY https://github.com/stephenberry/glaze.git
  GIT_TAG        v8.0.0
  GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(glaze)

add_subdirectory(vendor)
add_subdirectory(engine)

if(RESOSTAGE_BUILD_APP)
  add_subdirectory(app)
endif()

if(RESOSTAGE_BUILD_TESTS)
  enable_testing()
  add_subdirectory(tests)
endif()
