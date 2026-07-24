cmake_minimum_required(VERSION 3.28)

project(Resoset VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0")
endif()

option(RESOSET_BUILD_TESTS "Build engine unit tests" ON)
option(RESOSET_BUILD_APP "Build the ResoStage JUCE app" ON)
option(RESOSET_BUILD_TOOLS "Build developer tools (test-project generator)" ON)

include(FetchContent)

# ---------------------------------------------------------------------------
# JUCE (only pulled in when the app is being built; engine/tests don't need it)
# ---------------------------------------------------------------------------
if(RESOSET_BUILD_APP)
  FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        9.0.0
    GIT_SHALLOW    TRUE
  )
  FetchContent_MakeAvailable(JUCE)
endif()

add_subdirectory(third_party)
add_subdirectory(engine)

if(RESOSET_BUILD_APP)
  add_subdirectory(app)
endif()

if(RESOSET_BUILD_TOOLS)
  add_subdirectory(tools/make_test_project)
endif()

if(RESOSET_BUILD_TESTS)
  enable_testing()
  add_subdirectory(tests)
endif()
