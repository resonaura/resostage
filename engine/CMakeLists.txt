add_library(resostage_engine STATIC
  timing/MasterClock.cpp
  audio/RoutingEngine.cpp
  audio/Metering.cpp
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

target_include_directories(resostage_engine PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

target_link_libraries(resostage_engine
  PUBLIC
    miniz
    simdjson
    moodycamel_rwq
)

if(APPLE)
  find_library(ACCELERATE_FRAMEWORK Accelerate REQUIRED)
  target_link_libraries(resostage_engine PUBLIC ${ACCELERATE_FRAMEWORK})
endif()

target_compile_features(resostage_engine PUBLIC cxx_std_20)
