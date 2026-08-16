add_library(resostage_engine STATIC
  timing/MasterClock.cpp
  audio/RoutingEngine.cpp
  audio/MixGraph.cpp
  audio/MixRenderer.cpp
  audio/Metering.cpp
  audio/SincInterpolator.cpp
  audio/WavStreamDecoder.cpp
  audio/WavMetadata.cpp
  audio/AudioRingBuffer.cpp
  audio/StreamingTrackBuffer.cpp
  audio/StreamingEngine.cpp
  audio/ClickGenerator.cpp
  audio/PeakOverview.cpp
  audio/PeakCache.cpp
  audio/PeakBuildThreadPool.cpp
  audio/ArtNetPacket.cpp
  project/ProjectLoader.cpp
  project/ProjectJson.cpp
  project/ProjectHistory.cpp
  telemetry/SystemHealth.cpp
)

if(WIN32)
  target_sources(resostage_engine PRIVATE telemetry/SystemHealthWindows.cpp)
elseif(NOT APPLE)
  target_sources(resostage_engine PRIVATE telemetry/SystemHealthLinux.cpp)
endif()

target_include_directories(resostage_engine PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}
  # ResoLightProtocol.h: the ESP32/ESP8266 hardware transport's wire format,
  # shared verbatim (not hand-ported) with resolight/firmware -- see that
  # header's own doc comment for why.
  ${CMAKE_CURRENT_SOURCE_DIR}/../../resolight/firmware/shared
)

target_link_libraries(resostage_engine
  PUBLIC
    miniz
    moodycamel_rwq
    glaze::glaze
)

if(APPLE)
  find_library(ACCELERATE_FRAMEWORK Accelerate REQUIRED)
  target_link_libraries(resostage_engine PUBLIC ${ACCELERATE_FRAMEWORK})
endif()

target_compile_features(resostage_engine PUBLIC cxx_std_20)
if(MSVC)
  target_compile_options(resostage_engine PRIVATE /W4)
else()
  target_compile_options(resostage_engine PRIVATE -Wall -Wextra -Wunused)
endif()
