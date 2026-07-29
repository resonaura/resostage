# Vendored single-file / small dependencies, wired as tiny INTERFACE/static targets.

# ---------------------------------------------------------------------------
# moodycamel::ReaderWriterQueue (header-only SPSC queue)
# ---------------------------------------------------------------------------
add_library(moodycamel_rwq INTERFACE)
target_include_directories(moodycamel_rwq INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/moodycamel)

# ---------------------------------------------------------------------------
# doctest (header-only test framework)
# ---------------------------------------------------------------------------
add_library(doctest INTERFACE)
target_include_directories(doctest INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/doctest)

# ---------------------------------------------------------------------------
# simdjson (amalgamated single-file library)
# ---------------------------------------------------------------------------
add_library(simdjson STATIC ${CMAKE_CURRENT_SOURCE_DIR}/simdjson/simdjson.cpp)
target_include_directories(simdjson PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/simdjson)
target_compile_features(simdjson PUBLIC cxx_std_17)

# ---------------------------------------------------------------------------
# miniz (zip reading)
# ---------------------------------------------------------------------------
add_library(miniz STATIC
  ${CMAKE_CURRENT_SOURCE_DIR}/miniz/miniz.c
  ${CMAKE_CURRENT_SOURCE_DIR}/miniz/miniz_tdef.c
  ${CMAKE_CURRENT_SOURCE_DIR}/miniz/miniz_tinfl.c
  ${CMAKE_CURRENT_SOURCE_DIR}/miniz/miniz_zip.c
)
target_include_directories(miniz PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/miniz)
