cmake_minimum_required(VERSION 3.28)

project(ResoStage VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0")
endif()

option(RESOSTAGE_BUILD_TESTS "Build engine unit tests" ON)
option(RESOSTAGE_BUILD_APP "Build the ResoStage JUCE app" ON)
option(RESOSTAGE_BUILD_TOOLS "Build developer tools (test-project generator)" ON)

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

add_subdirectory(third_party)
add_subdirectory(engine)

if(RESOSTAGE_BUILD_APP)
  add_subdirectory(app)
endif()

if(RESOSTAGE_BUILD_TOOLS)
  add_subdirectory(tools/make_test_project)
endif()

if(RESOSTAGE_BUILD_TESTS)
  enable_testing()
  add_subdirectory(tests)
endif()
