add_library(resoset_engine STATIC
  timing/MasterClock.cpp
  audio/RoutingEngine.cpp
  audio/Metering.cpp
  project/ProjectLoader.cpp
)

target_include_directories(resoset_engine PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

target_link_libraries(resoset_engine
  PUBLIC
    miniz
    simdjson
    moodycamel_rwq
)

target_compile_features(resoset_engine PUBLIC cxx_std_20)
